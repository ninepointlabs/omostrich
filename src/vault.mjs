import fs from "node:fs";
import crypto from "node:crypto";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { dataDir, vaultPath } from "./paths.mjs";

// scrypt N=2^17 costs ~128MB and a few hundred ms on modern hardware, which
// is the point: it sets the floor on how expensive an offline passphrase
// guess against a stolen vault.json is. Node's default scrypt maxmem (32MB)
// is well under that, so it must be raised explicitly or unlock throws.
const KDF = { name: "scrypt", N: 131072, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KDF.keylen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

export function exists() {
  return fs.existsSync(vaultPath);
}

export function readMeta() {
  if (!exists()) return null;
  const vault = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
  return { npub: vault.npub, pubkeyHex: vault.pubkeyHex, createdAt: vault.createdAt };
}

// Encrypts and writes a new vault, replacing any existing one. Caller (the
// control socket handler) is responsible for requiring an explicit
// "replace" confirmation before calling this when a vault already exists.
export function create(nsec, passphrase) {
  const decoded = nip19.decode(String(nsec || "").trim());
  if (decoded.type !== "nsec") throw new Error("not an nsec key");
  const skBytes = decoded.data;

  const pubkeyHex = getPublicKey(skBytes);
  const npub = nip19.npubEncode(pubkeyHex);

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(skBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  key.fill(0);

  const vault = {
    version: 1,
    npub,
    pubkeyHex,
    kdf: KDF,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(vaultPath, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(vaultPath, 0o600);

  return { npub, pubkeyHex };
}

// Returns the raw 32-byte secret key on success. Throws on a wrong
// passphrase (GCM auth tag check fails) or a missing/corrupt vault.
export function unlock(passphrase) {
  const vault = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
  const salt = Buffer.from(vault.salt, "base64");
  const iv = Buffer.from(vault.iv, "base64");
  const authTag = Buffer.from(vault.authTag, "base64");
  const ciphertext = Buffer.from(vault.ciphertext, "base64");

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let skBytes;
  try {
    skBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    key.fill(0);
  }

  return { skBytes: new Uint8Array(skBytes), npub: vault.npub, pubkeyHex: vault.pubkeyHex };
}
