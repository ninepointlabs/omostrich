import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The profile picture is a URL from the vault owner's kind-0, hosted
// anywhere. The panel runs inside the shared Omarchy shell, so it never
// loads that URL itself: the daemon downloads it here with a byte cap and a
// timeout, checks it is a PNG/JPEG/GIF/WebP whose header dimensions are
// small enough to decode cheaply, rewrites it down to the parts needed to
// draw it (stripImage below), and keeps that local copy for the panel to load
// via file:// (with a small sourceSize on top). Anything that fails a check
// leaves no picture, so the panel shows its placeholder.
export const MAX_AVATAR_BYTES = 1024 * 1024;
export const AVATAR_TIMEOUT_MS = 10_000;
// Per side, and in total, so a decode is at most ~16 MB of ARGB32
// before Qt scales it to sourceSize.
export const MAX_AVATAR_SIDE = 2048;
export const MAX_AVATAR_PIXELS = 2048 * 2048;

const ALLOWED_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

// Format and pixel size from the file header alone (no decoding), or null
// when the bytes are not one of the four formats or the header is short.
export function imageInfo(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a
      && buf.subarray(12, 16).toString("ascii") === "IHDR") {
    return { mime: "image/png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("ascii"))) {
    return { mime: "image/gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    const chunk = buf.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      return { mime: "image/webp", width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { mime: "image/webp", width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker.
    let i = 2;
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// True when Qt can decode it within the pixel budget above.
export function withinDecodeLimits(info) {
  return !!info && info.width > 0 && info.height > 0
    && info.width <= MAX_AVATAR_SIDE && info.height <= MAX_AVATAR_SIDE
    && info.width * info.height <= MAX_AVATAR_PIXELS;
}

// Metadata is decoded before sourceSize applies (libpng inflates every
// zTXt/iTXt/iCCP chunk as Qt reads the header), so the cached copy keeps
// only what drawing the first frame needs. Each function returns a new
// buffer or throws if the structure is malformed or unsupported.

// PNG: the critical chunks plus fixed-size colour hints. Every text, ICC,
// EXIF, APNG and private chunk is dropped; an unknown critical chunk is
// refused, as is anything after IEND.
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "IDAT", "IEND"]);

function stripPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  let idat = false;
  for (;;) {
    if (i + 12 > buf.length) throw new Error("PNG is truncated");
    const len = buf.readUInt32BE(i);
    const end = i + 12 + len;
    if (len > 0x7fffffff || end > buf.length) throw new Error("PNG is truncated");
    const type = buf.subarray(i + 4, i + 8).toString("latin1");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error("PNG has a malformed chunk");
    if ((i === 8) !== (type === "IHDR")) throw new Error("PNG does not start with IHDR");
    if (PNG_KEEP.has(type)) {
      out.push(buf.subarray(i, end));
      if (type === "IDAT") idat = true;
    } else if (type[0] >= "A" && type[0] <= "Z") {
      throw new Error(`PNG has an unsupported critical chunk ${type}`);
    }
    i = end;
    if (type === "IEND") break;
  }
  if (!idat) throw new Error("PNG has no image data");
  return Buffer.concat(out);
}

// JPEG: drops COM and every APPn but APP0 (JFIF) and APP14 (Adobe, which
// says how to convert the colours), and anything after EOI.
function stripJpeg(buf) {
  const out = [buf.subarray(0, 2)];
  let i = 2;
  let scanned = false;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error("JPEG has a malformed segment");
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd9) break;
    if (marker === undefined || marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      throw new Error("JPEG has a malformed segment");
    }
    if (i + 4 > buf.length) throw new Error("JPEG is truncated");
    const len = buf.readUInt16BE(i + 2);
    let end = i + 2 + len;
    if (len < 2 || end > buf.length) throw new Error("JPEG is truncated");
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed
      // 0xFF00 or a restart marker.
      scanned = true;
      while (end < buf.length) {
        if (buf[end] === 0xff && end + 1 < buf.length) {
          const next = buf[end + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
          end += 2;
        } else {
          end += 1;
        }
      }
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (!(marker === 0xfe || (isApp && marker !== 0xe0 && marker !== 0xee))) out.push(buf.subarray(i, end));
    i = end;
  }
  if (!scanned) throw new Error("JPEG has no image data");
  out.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(out);
}

// GIF: the first frame and its graphic control block only; comment,
// application (looping) and plain-text extensions and later frames go.
function stripGif(buf) {
  const need = (n) => { if (n > buf.length) throw new Error("GIF is truncated"); };
  need(13);
  const packed = buf[10];
  let i = 13 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
  need(i);
  const out = [buf.subarray(0, i)];
  const skipBlocks = (j) => {
    for (;;) {
      need(j + 1);
      const n = buf[j];
      j += 1 + n;
      if (n === 0) return j;
    }
  };
  let control = null;
  for (;;) {
    need(i + 1);
    const block = buf[i];
    if (block === 0x21) {
      need(i + 2);
      const end = skipBlocks(i + 2);
      if (buf[i + 1] === 0xf9) control = buf.subarray(i, end);
      i = end;
    } else if (block === 0x2c) {
      need(i + 10);
      const local = buf[i + 9];
      let j = i + 10 + (local & 0x80 ? 3 << ((local & 7) + 1) : 0);
      need(j + 1);
      j = skipBlocks(j + 1); // LZW minimum code size, then the data
      if (control) out.push(control);
      out.push(buf.subarray(i, j), Buffer.from([0x3b]));
      return Buffer.concat(out);
    } else {
      throw new Error("GIF has no image");
    }
  }
}

// WebP: a still image only (VP8 or VP8L, with ALPH under VP8X); ICCP, EXIF,
// XMP and unknown chunks go and their VP8X flags are cleared. Animated
// WebP is refused.
function stripWebp(buf) {
  // Bytes past the RIFF size are not part of the file.
  const limit = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let i = 12;
  while (i + 8 <= limit) {
    const type = buf.subarray(i, i + 4).toString("latin1");
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > limit) throw new Error("WebP is truncated");
    chunks.push({ type, chunk: buf.subarray(i, Math.min(end, limit)) });
    i = end;
  }
  const kept = [];
  const first = chunks[0]?.type;
  if (first === "VP8X") {
    const vp8x = Buffer.from(chunks[0].chunk);
    if (vp8x.length < 18 || vp8x[8] & 0x02) throw new Error("animated WebP is not supported");
    vp8x[8] &= 0x10; // alpha only
    kept.push(vp8x);
    for (const c of chunks.slice(1)) {
      if (c.type === "ALPH" || c.type === "VP8 " || c.type === "VP8L") kept.push(c.chunk);
    }
  } else if (first === "VP8 " || first === "VP8L") {
    kept.push(chunks[0].chunk);
  }
  const frames = kept.filter((c) => /^VP8[ L]$/.test(c.subarray(0, 4).toString("latin1")));
  if (frames.length !== 1) throw new Error("WebP has no single image");
  // Each chunk is padded to even length; the final one may not have been.
  const body = Buffer.concat(kept.map((c) => (c.length & 1 ? Buffer.concat([c, Buffer.alloc(1)]) : c)));
  const head = Buffer.from("RIFF\0\0\0\0WEBP", "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

// Returns a copy of buf (whose type imageInfo() reported as mime) holding
// only what is needed to draw it, or throws.
export function stripImage(buf, mime) {
  switch (mime) {
    case "image/png": return stripPng(buf);
    case "image/jpeg": return stripJpeg(buf);
    case "image/gif": return stripGif(buf);
    case "image/webp": return stripWebp(buf);
    default: throw new Error(`cannot strip ${mime}`);
  }
}

// Reads a fetch() Response body, giving up (and cancelling the stream) once
// it passes maxBytes. Content-Length is checked first but not trusted.
export async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

// Downloads url and returns { buf, mime, ext, width, height }, or throws
// with the reason. Both the header and the bytes must say it is an allowed
// image type; buf is the stripped copy (stripImage), not the bytes served.
export async function downloadAvatar(url, { fetchImpl = fetch, timeoutMs = AVATAR_TIMEOUT_MS, maxBytes = MAX_AVATAR_BYTES } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("not a URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("not an http(s) URL");
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(parsed.toString(), {
    signal,
    redirect: "follow",
    headers: { Accept: [...ALLOWED_TYPES.keys()].join(", ") },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`content type ${type || "(none)"} is not PNG, JPEG, GIF or WebP`);
  }
  const raw = await readBodyCapped(res, maxBytes);
  const info = imageInfo(raw);
  if (!info) throw new Error("not a readable PNG, JPEG, GIF or WebP file");
  if (!withinDecodeLimits(info)) {
    throw new Error(`image is ${info.width}x${info.height} (max ${MAX_AVATAR_SIDE}x${MAX_AVATAR_SIDE})`);
  }
  const buf = stripImage(raw, info.mime);
  return { buf, mime: info.mime, ext: ALLOWED_TYPES.get(info.mime), width: info.width, height: info.height };
}

// Local copy of the current profile picture: <dir>/avatar.<ext>, described
// by <dir>/avatar.json ({ url, file, sha256, version }) so a restart doesn't
// refetch. A copy from an older version (before stripImage) is ignored and
// fetched again.
const CACHE_VERSION = 2;

export function createAvatarCache(dir, { log = () => {}, download = downloadAvatar } = {}) {
  const metaPath = path.join(dir, "avatar.json");
  let current = null;
  let inflight = null;
  let wanted = null; // the url of the latest sync(), so a slower older fetch can't win

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta && meta.version === CACHE_VERSION && typeof meta.url === "string" && typeof meta.file === "string" && typeof meta.sha256 === "string"
        && path.dirname(meta.file) === dir && fs.existsSync(meta.file)) {
      current = meta;
    }
  } catch {
    /* nothing cached yet */
  }

  function removeFiles(keep) {
    for (const ext of ALLOWED_TYPES.values()) {
      const f = path.join(dir, `avatar.${ext}`);
      if (f !== keep) fs.rmSync(f, { force: true });
    }
  }

  function clear() {
    current = null;
    removeFiles(null);
    fs.rmSync(metaPath, { force: true });
  }

  async function fetchAndStore(url) {
    try {
      const img = await download(url);
      if (wanted !== url) return false;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `avatar.${img.ext}`);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, img.buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
      removeFiles(file);
      const sha256 = crypto.createHash("sha256").update(img.buf).digest("hex");
      current = { url, file, sha256, version: CACHE_VERSION };
      fs.writeFileSync(metaPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
      log(`profile picture cached (${img.mime}, ${img.width}x${img.height}, ${img.buf.length} bytes)`);
      return true;
    } catch (err) {
      if (wanted !== url) return false;
      clear();
      log(`profile picture not loaded: ${err?.message || err}`);
      return true;
    }
  }

  return {
    // file:// URL for the panel, with ?v= so Qt's image cache sees a new
    // picture at the same path; "" when there is none for this url.
    fileUrl(url) {
      if (!current || !url || current.url !== url) return "";
      return `${pathToFileURL(current.file).href}?v=${current.sha256.slice(0, 16)}`;
    },
    // Resolves true when the cached picture changed (or was dropped).
    async sync(url) {
      wanted = url || null;
      if (!url) {
        if (!current) return false;
        clear();
        return true;
      }
      if (current && current.url === url && fs.existsSync(current.file)) return false;
      if (inflight && inflight.url === url) return inflight.promise;
      const promise = fetchAndStore(url).finally(() => { if (inflight?.promise === promise) inflight = null; });
      inflight = { url, promise };
      return promise;
    },
  };
}
