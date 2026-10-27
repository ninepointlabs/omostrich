// Node test runner for daemon/avatar.mjs: the bounded profile-picture
// download the panel depends on (it never loads a remote URL itself). Uses a
// local HTTP server on 127.0.0.1 and a temp directory; no vault, daemon,
// socket or relay.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import {
  imageInfo,
  withinDecodeLimits,
  stripImage,
  downloadAvatar,
  createAvatarCache,
  MAX_AVATAR_BYTES,
} from "../daemon/avatar.mjs";

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// A real, decodable greyscale PNG of the given size (all black).
function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(16)]);
}

async function withServer(routes, fn) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const serve = (type, body, extra = {}) => (req, res) => {
  res.writeHead(200, { "Content-Type": type, ...extra });
  res.end(body);
};

test("imageInfo reads dimensions from PNG, JPEG, GIF and WebP headers", () => {
  assert.deepEqual(imageInfo(png(64, 32)), { mime: "image/png", width: 64, height: 32 });
  assert.deepEqual(imageInfo(jpegHeader(300, 200)), { mime: "image/jpeg", width: 300, height: 200 });
  const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
  assert.deepEqual(imageInfo(gif), { mime: "image/gif", width: 320, height: 240 });
  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0, "ascii");
  vp8x.write("WEBP", 8, "ascii");
  vp8x.write("VP8X", 12, "ascii");
  vp8x.writeUIntLE(4999, 24, 3);
  vp8x.writeUIntLE(99, 27, 3);
  assert.deepEqual(imageInfo(vp8x), { mime: "image/webp", width: 5000, height: 100 });
  assert.equal(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(imageInfo(Buffer.from("<html>")), null);
  assert.equal(imageInfo(Buffer.alloc(0)), null);
});

// A PNG of the given size carrying `count` compressed text chunks, each
// inflating to 1 MiB: a tiny file that costs libpng ~count MiB to read.
function pngWithText(width, height, count) {
  const plain = png(width, height);
  const bomb = zlib.deflateSync(Buffer.alloc(1024 * 1024, 0x41), { level: 9 });
  const text = [];
  for (let k = 0; k < count; k++) {
    text.push(k % 2
      ? pngChunk("zTXt", Buffer.concat([Buffer.from(`k${k}\0\0`, "latin1"), bomb]))
      : pngChunk("iTXt", Buffer.concat([Buffer.from(`k${k}\0\x01\0\0\0`, "latin1"), bomb])));
  }
  // IHDR is 25 bytes after the 8-byte signature; text before and after IDAT.
  const half = Math.floor(text.length / 2);
  return Buffer.concat([
    plain.subarray(0, 33),
    pngChunk("iCCP", Buffer.concat([Buffer.from("icc\0\0", "latin1"), bomb])),
    pngChunk("tEXt", Buffer.from("Comment\0hello", "latin1")),
    ...text.slice(0, half),
    plain.subarray(33, plain.length - 12),
    pngChunk("acTL", Buffer.alloc(8)),
    ...text.slice(half),
    plain.subarray(plain.length - 12),
    Buffer.from("trailing junk"),
  ]);
}

const jpegSegment = (marker, data) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};

test("stripImage keeps only the PNG chunks needed to draw it", () => {
  const plain = png(32, 32);
  const fat = pngWithText(32, 32, 200);
  assert.ok(fat.length < MAX_AVATAR_BYTES, `fat is ${fat.length} bytes`);
  const clean = stripImage(fat, "image/png");
  assert.ok(clean.equals(plain), "every ancillary chunk but the colour hints is gone");
  assert.ok(stripImage(plain, "image/png").equals(plain), "a plain PNG is unchanged");
  assert.deepEqual(imageInfo(clean), { mime: "image/png", width: 32, height: 32 });

  // gAMA/sRGB/tRNS/PLTE stay.
  const hinted = Buffer.concat([plain.subarray(0, 33), pngChunk("gAMA", Buffer.alloc(4)), pngChunk("sRGB", Buffer.from([0])),
    plain.subarray(33)]);
  assert.ok(stripImage(hinted, "image/png").equals(hinted));

  const unknownCritical = Buffer.concat([plain.subarray(0, 33), pngChunk("ABCD", Buffer.alloc(4)), plain.subarray(33)]);
  assert.throws(() => stripImage(unknownCritical, "image/png"), /unsupported critical chunk ABCD/);
  assert.throws(() => stripImage(plain.subarray(0, plain.length - 12), "image/png"), /truncated/);
  const noIdat = Buffer.concat([plain.subarray(0, 33), plain.subarray(plain.length - 12)]);
  assert.throws(() => stripImage(noIdat, "image/png"), /no image data/);
  const textFirst = Buffer.concat([plain.subarray(0, 8), pngChunk("tEXt", Buffer.from("a\0b")), plain.subarray(8)]);
  assert.throws(() => stripImage(textFirst, "image/png"), /does not start with IHDR/);
});

test("stripImage drops JPEG comments and APP metadata but keeps JFIF, Adobe and the scans", () => {
  const app0 = jpegSegment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
  const app14 = jpegSegment(0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01", "latin1"));
  const dqt = jpegSegment(0xdb, Buffer.alloc(65));
  const sof = jpegSegment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  const dht = jpegSegment(0xc4, Buffer.alloc(17));
  // Entropy data with a stuffed 0xFF00 and a restart marker, which are not
  // segment boundaries.
  const scan = Buffer.concat([jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])]);
  const eoi = Buffer.from([0xff, 0xd9]);
  const soi = Buffer.from([0xff, 0xd8]);
  const clean = Buffer.concat([soi, app0, app14, dqt, sof, dht, scan, eoi]);
  const fat = Buffer.concat([soi, app0, jpegSegment(0xe1, Buffer.alloc(60000, 1)), jpegSegment(0xe2, Buffer.alloc(60000, 2)),
    app14, jpegSegment(0xfe, Buffer.from("comment")), dqt, sof, jpegSegment(0xed, Buffer.alloc(1000)), dht, scan, eoi,
    Buffer.from("trailing")]);
  assert.ok(stripImage(fat, "image/jpeg").equals(clean));
  assert.ok(stripImage(clean, "image/jpeg").equals(clean));
  assert.deepEqual(imageInfo(stripImage(fat, "image/jpeg")), { mime: "image/jpeg", width: 16, height: 16 });
  // A missing EOI is added; no scan at all is refused.
  assert.ok(stripImage(clean.subarray(0, clean.length - 2), "image/jpeg").equals(clean));
  assert.throws(() => stripImage(Buffer.concat([soi, app0, sof, eoi]), "image/jpeg"), /no image data/);
  assert.throws(() => stripImage(Buffer.concat([soi, app0, Buffer.from([0x00, 0x01])]), "image/jpeg"), /malformed/);
});

test("stripImage keeps only the first GIF frame and its graphic control block", () => {
  const screen = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([2, 0, 2, 0, 0x80, 0, 0]), Buffer.alloc(6)]);
  const control = Buffer.from([0x21, 0xf9, 4, 1, 0, 0, 0, 0]);
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 2, 0x44, 0x01, 0]);
  const loop = Buffer.concat([Buffer.from([0x21, 0xff, 11]), Buffer.from("NETSCAPE2.0"), Buffer.from([3, 1, 0, 0, 0])]);
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe]), ...Array.from({ length: 100 }, () => Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 0x41)])), Buffer.from([0])]);
  const fat = Buffer.concat([screen, loop, comment, control, frame, comment, control, frame, Buffer.from([0x3b])]);
  const clean = Buffer.concat([screen, control, frame, Buffer.from([0x3b])]);
  assert.ok(stripImage(fat, "image/gif").equals(clean));
  assert.ok(stripImage(clean, "image/gif").equals(clean));
  assert.throws(() => stripImage(Buffer.concat([screen, comment, Buffer.from([0x3b])]), "image/gif"), /no image/);
  assert.throws(() => stripImage(Buffer.concat([screen, frame.subarray(0, 12)]), "image/gif"), /truncated/);
});

test("stripImage keeps a still WebP's image and alpha, drops metadata, refuses animation", () => {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
  };
  const riff = (...chunks) => {
    const body = Buffer.concat(chunks);
    const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
    head.writeUInt32LE(body.length + 4, 4);
    return Buffer.concat([head, body]);
  };
  const vp8x = (flags) => {
    const d = Buffer.alloc(10);
    d[0] = flags;
    d.writeUIntLE(63, 4, 3);
    d.writeUIntLE(63, 7, 3);
    return chunk("VP8X", d);
  };
  const image = chunk("VP8 ", Buffer.from([0x50, 0x02, 0x00, 0x9d, 0x01, 0x2a, 64, 0, 64, 0, 1, 2, 3]));
  const alpha = chunk("ALPH", Buffer.from([0, 1, 2]));
  const fat = riff(vp8x(0x20 | 0x10 | 0x08 | 0x04), chunk("ICCP", Buffer.alloc(5000)), alpha, image,
    chunk("EXIF", Buffer.alloc(5000)), chunk("XMP ", Buffer.alloc(5000)), chunk("ZZZZ", Buffer.alloc(9)));
  const clean = riff(vp8x(0x10), alpha, image);
  assert.ok(stripImage(fat, "image/webp").equals(clean));
  assert.deepEqual(imageInfo(clean), { mime: "image/webp", width: 64, height: 64 });
  const simple = riff(image);
  assert.ok(stripImage(Buffer.concat([simple, Buffer.from("junk!!!!")]), "image/webp").equals(simple));
  assert.throws(() => stripImage(riff(vp8x(0x02), chunk("ANIM", Buffer.alloc(6)), chunk("ANMF", Buffer.alloc(30))), "image/webp"),
    /animated/);
  assert.throws(() => stripImage(riff(vp8x(0), chunk("EXIF", Buffer.alloc(4))), "image/webp"), /no single image/);
  assert.throws(() => stripImage(riff(vp8x(0), image, image), "image/webp"), /no single image/);
});

test("decode limits reject huge or empty dimensions", () => {
  assert.equal(withinDecodeLimits({ width: 400, height: 400 }), true);
  assert.equal(withinDecodeLimits({ width: 2048, height: 2048 }), true);
  assert.equal(withinDecodeLimits({ width: 2049, height: 10 }), false);
  assert.equal(withinDecodeLimits({ width: 0, height: 10 }), false);
  assert.equal(withinDecodeLimits(null), false);
});

test("downloadAvatar accepts a small image and enforces every limit", async () => {
  const small = png(96, 96);
  const bomb = png(20000, 20000); // compresses to ~1 MB; 400 MP decoded
  await withServer({
    "/ok.png": serve("image/png", small),
    "/text.png": serve("image/png", pngWithText(96, 96, 200)),
    "/bad-chunk.png": serve("image/png", Buffer.concat([small.subarray(0, 33), pngChunk("ABCD", Buffer.alloc(4)), small.subarray(33)])),
    "/ok-charset.png": serve("image/png; charset=binary", small),
    "/html": serve("text/html", "<html></html>"),
    "/svg": serve("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>"),
    "/lies.png": serve("image/png", "<html>not a png</html>"),
    "/bomb.png": serve("image/png", bomb),
    "/big-declared": serve("image/png", Buffer.alloc(MAX_AVATAR_BYTES + 1)),
    "/big-chunked": (req, res) => {
      // No Content-Length: the cap has to stop the stream itself.
      res.writeHead(200, { "Content-Type": "image/png", "Transfer-Encoding": "chunked" });
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      const push = () => {
        while (sent < 64 * MAX_AVATAR_BYTES) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once("drain", push); return; }
        }
        res.end();
      };
      push();
    },
    "/slow": (req, res) => { res.writeHead(200, { "Content-Type": "image/png" }); res.write(small.subarray(0, 10)); },
    "/redirect": (req, res) => { res.writeHead(302, { Location: "/ok.png" }); res.end(); },
    "/missing": (req, res) => { res.writeHead(404); res.end(); },
  }, async (base) => {
    const ok = await downloadAvatar(`${base}/ok.png`);
    assert.equal(ok.mime, "image/png");
    assert.equal(ok.ext, "png");
    assert.equal(ok.width, 96);
    assert.ok(ok.buf.equals(small));
    assert.equal((await downloadAvatar(`${base}/ok-charset.png`)).ext, "png");
    assert.equal((await downloadAvatar(`${base}/redirect`)).width, 96);
    // Served with hundreds of MiB of compressed text; cached without it.
    assert.ok((await downloadAvatar(`${base}/text.png`)).buf.equals(small));
    await assert.rejects(downloadAvatar(`${base}/bad-chunk.png`), /unsupported critical chunk/);

    assert.ok(bomb.length < MAX_AVATAR_BYTES, `bomb is ${bomb.length} bytes`);
    await assert.rejects(downloadAvatar(`${base}/bomb.png`), /20000x20000/);
    await assert.rejects(downloadAvatar(`${base}/html`), /content type text\/html/);
    await assert.rejects(downloadAvatar(`${base}/svg`), /content type image\/svg\+xml/);
    await assert.rejects(downloadAvatar(`${base}/lies.png`), /not a readable/);
    await assert.rejects(downloadAvatar(`${base}/big-declared`), /too large/);
    await assert.rejects(downloadAvatar(`${base}/big-chunked`), /too large \(over/);
    await assert.rejects(downloadAvatar(`${base}/slow`, { timeoutMs: 300 }), /abort|timeout/i);
    await assert.rejects(downloadAvatar(`${base}/missing`), /HTTP 404/);
    await assert.rejects(downloadAvatar("file:///etc/passwd"), /not an http/);
    await assert.rejects(downloadAvatar("javascript:alert(1)"), /not an http/);
  });
});

test("avatar cache stores a 0600 local copy, serves it as file://, and drops it on failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omostrich-avatar-"));
  try {
    const small = png(48, 48);
    let hits = 0;
    await withServer({
      "/a.png": (req, res) => { hits++; serve("image/png", small)(req, res); },
      "/b.html": serve("text/html", "<html>"),
    }, async (base) => {
      const logs = [];
      const cache = createAvatarCache(dir, { log: (l) => logs.push(l) });
      assert.equal(cache.fileUrl(`${base}/a.png`), "");
      assert.equal(await cache.sync(`${base}/a.png`), true);
      const url = cache.fileUrl(`${base}/a.png`);
      assert.match(url, /^file:\/\/\/.*\/avatar\.png\?v=[0-9a-f]{16}$/);
      const file = path.join(dir, "avatar.png");
      assert.ok(fs.readFileSync(file).equals(small));
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      // A different URL in the profile gets no picture until it is fetched.
      assert.equal(cache.fileUrl(`${base}/other.png`), "");

      // Same URL again: no refetch, and a restart reuses avatar.json.
      assert.equal(await cache.sync(`${base}/a.png`), false);
      const reopened = createAvatarCache(dir);
      assert.equal(reopened.fileUrl(`${base}/a.png`), url);
      assert.equal(await reopened.sync(`${base}/a.png`), false);
      assert.equal(hits, 1);

      // A bad picture leaves nothing on disk and nothing for the panel.
      await cache.sync(`${base}/b.html`);
      assert.equal(cache.fileUrl(`${base}/b.html`), "");
      assert.equal(fs.existsSync(file), false);
      assert.ok(logs.some((l) => /not loaded: content type text\/html/.test(l)));

      // No picture in the profile: clear.
      await cache.sync(`${base}/a.png`);
      assert.equal(await cache.sync(""), true);
      assert.deepEqual(fs.readdirSync(dir), []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("avatar cache stores the stripped copy and ignores one cached before stripping", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omostrich-avatar-"));
  try {
    const fat = pngWithText(24, 24, 50);
    await withServer({ "/fat.png": serve("image/png", fat) }, async (base) => {
      // What 0.3.1 left behind: the served bytes and a meta with no version.
      const file = path.join(dir, "avatar.png");
      fs.writeFileSync(file, fat);
      fs.writeFileSync(path.join(dir, "avatar.json"), JSON.stringify({ url: `${base}/fat.png`, file, sha256: "0".repeat(64) }));
      const cache = createAvatarCache(dir);
      assert.equal(cache.fileUrl(`${base}/fat.png`), "");
      assert.equal(await cache.sync(`${base}/fat.png`), true);
      assert.ok(fs.readFileSync(file).equals(png(24, 24)));
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "avatar.json"), "utf8")).version, 2);
      assert.notEqual(createAvatarCache(dir).fileUrl(`${base}/fat.png`), "");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a slower, older avatar fetch can't replace a newer one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omostrich-avatar-"));
  try {
    let releaseOld;
    const download = (url) => url === "old"
      ? new Promise((r) => { releaseOld = () => r({ buf: png(8, 8), mime: "image/png", ext: "png", width: 8, height: 8 }); })
      : Promise.resolve({ buf: png(16, 16), mime: "image/png", ext: "png", width: 16, height: 16 });
    const cache = createAvatarCache(dir, { download });
    const oldSync = cache.sync("old");
    await cache.sync("new");
    releaseOld();
    assert.equal(await oldSync, false);
    assert.notEqual(cache.fileUrl("new"), "");
    assert.equal(cache.fileUrl("old"), "");
    assert.equal(imageInfo(fs.readFileSync(path.join(dir, "avatar.png"))).width, 16);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
