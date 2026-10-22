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
