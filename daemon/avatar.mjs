import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The profile picture is a URL from the vault owner's kind-0, hosted
// anywhere. The panel runs inside the shared Omarchy shell, so it never
// loads that URL itself: the daemon downloads it here with a byte cap and a
// timeout, checks it is a PNG/JPEG/GIF/WebP whose header dimensions are
// small enough to decode cheaply, and keeps a local copy the panel loads
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
// image type.
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
  const buf = await readBodyCapped(res, maxBytes);
  const info = imageInfo(buf);
  if (!info) throw new Error("not a readable PNG, JPEG, GIF or WebP file");
  if (!withinDecodeLimits(info)) {
    throw new Error(`image is ${info.width}x${info.height} (max ${MAX_AVATAR_SIDE}x${MAX_AVATAR_SIDE})`);
  }
  return { buf, mime: info.mime, ext: ALLOWED_TYPES.get(info.mime), width: info.width, height: info.height };
}

// Local copy of the current profile picture: <dir>/avatar.<ext>, described
// by <dir>/avatar.json ({ url, file, sha256 }) so a restart doesn't refetch.
export function createAvatarCache(dir, { log = () => {}, download = downloadAvatar } = {}) {
  const metaPath = path.join(dir, "avatar.json");
  let current = null;
  let inflight = null;
  let wanted = null; // the url of the latest sync(), so a slower older fetch can't win

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (meta && typeof meta.url === "string" && typeof meta.file === "string" && typeof meta.sha256 === "string"
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
      current = { url, file, sha256 };
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
