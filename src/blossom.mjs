import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

const MAX_BYTES = 25 * 1024 * 1024;

export function normalizeBlossomUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error("blossomUrl must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("blossomUrl must be an http(s) URL");
  }
  // Strip trailing slashes; upload path is `${url}/upload`.
  return url.toString().replace(/\/+$/, "");
}

function sniffMime(buf, fallback) {
  if (fallback && fallback !== "application/octet-stream") return fallback;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return fallback || "application/octet-stream";
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "";
}

function loadBytes(req) {
  if (req.path) {
    const filePath = String(req.path);
    if (!path.isAbsolute(filePath)) throw new Error("path must be absolute");
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      throw new Error("file not readable");
    }
    if (!st.isFile()) throw new Error("path is not a file");
    if (st.size > MAX_BYTES) throw new Error("blob too large (max 25MB)");
    const buf = fs.readFileSync(filePath);
    const mime = sniffMime(buf, req.mime || mimeFromPath(filePath));
    return { buf, mime };
  }
  if (req.bytes) {
    const buf = Buffer.from(String(req.bytes), "base64");
    if (!buf.length) throw new Error("bytes were empty");
    if (buf.length > MAX_BYTES) throw new Error("blob too large (max 25MB)");
    const mime = sniffMime(buf, req.mime || "application/octet-stream");
    return { buf, mime };
  }
  throw new Error("path or bytes required");
}

async function signUploadAuth({ ndk, skBytes, pubkeyHex, sha256, size }) {
  const signer = new NDKPrivateKeySigner(skBytes);
  const now = Math.floor(Date.now() / 1000);
  const event = new NDKEvent(ndk, {
    kind: 24242,
    pubkey: pubkeyHex,
    created_at: now,
    content: "Upload Blob",
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", String(now + 120)],
      ["size", String(size)],
    ],
  });
  await event.sign(signer);
  return event.rawEvent();
}

function nostrAuthHeader(rawEvent) {
  // NIP-98 header shape: `Authorization: Nostr <base64(event json)>`.
  // BUD-01/BUD-11 use the same header with a kind-24242 event (t=upload).
  return "Nostr " + Buffer.from(JSON.stringify(rawEvent)).toString("base64");
}

export async function uploadBlob({ ndk, skBytes, pubkeyHex, blossomUrl, req }) {
  const server = normalizeBlossomUrl(blossomUrl);
  if (!server) throw new Error("no blossom server configured");
  if (!skBytes) throw new Error("locked");
  if (!ndk) throw new Error("not connected");

  const { buf, mime } = loadBytes(req);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const raw = await signUploadAuth({ ndk, skBytes, pubkeyHex, sha256, size: buf.length });
  const uploadUrl = `${server}/upload`;

  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: nostrAuthHeader(raw),
      "Content-Type": mime,
      "Content-Length": String(buf.length),
      "X-SHA-256": sha256,
    },
    body: buf,
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const hint = body?.message || body?.error || text.slice(0, 200) || res.statusText;
    throw new Error(`blossom ${res.status}: ${hint}`);
  }

  const url = body?.url || `${server}/${sha256}`;
  return {
    url,
    sha256: body?.sha256 || sha256,
    size: body?.size || buf.length,
    mime: body?.type || mime,
  };
}

export function imetaTags({ url, sha256, mime, size }) {
  const parts = [`url ${url}`];
  if (mime) parts.push(`m ${mime}`);
  if (sha256) parts.push(`x ${sha256}`);
  if (size) parts.push(`size ${size}`);
  return [["imeta", ...parts]];
}
