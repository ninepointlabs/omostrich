// Facts and text for the About page (AboutView.qml), kept out of QML so node
// can check them against the repo (see tests/about.test.mjs).
//
// The version comes from manifest.json and the license from LICENSE at run
// time, so neither is copied here and neither can drift from the real file.
// Nothing here talks to the signer daemon: the About page works locked,
// unlocked, or with the daemon not running at all.

var NAME = "Omostrich"
var TAGLINE = "Local Nostr signer and note composer for Omarchy."
var ORGANIZATION = "Nine Point Labs"
var CREATED = "August 2026" // first commit: 2026-08-24
var SUPPORT_EMAIL = "help@ninepointlabs.com"

// Must stay true to the code. Sources: daemon/vault.mjs (AES-256-GCM,
// scrypt, 0600), daemon/config.mjs (default relays), daemon/daemon.mjs (NDK
// is created only on unlock; publish, kind-0 profile lookup, NIP-46 backend,
// audit log), daemon/notify-watch.mjs (mention/DM/zap subscription),
// daemon/nostrconnect.mjs (relays named by a scanned code), daemon/blossom.mjs and daemon/avatar.mjs (the only fetch()es:
// Blossom upload, bounded profile-picture download), daemon/control-socket.mjs (0600
// socket, plus token-gated TCP 4737 on the Tailscale address), Panel.qml (Images load local files only), and NDK's default outbox
// relays (purplepag.es, nos.lol). tests/about.test.mjs fails if a host is
// added to the code without being named here.
var PRIVACY = [
  "No account and no telemetry. Your nsec is stored only on this computer, encrypted with AES-256-GCM "
    + "under a key derived from your passphrase with scrypt, in ~/.local/share/omostrich/vault.json "
    + "(mode 0600). It is decrypted only in the signer daemon's memory while unlocked and never leaves "
    + "this machine. What goes out is the result of using it: signed events, your public key, and, for "
    + "an app you approve over NIP-46, the signature, encryption or decryption it asked for.",
  "The daemon connects to Nostr relays only after you unlock. It uses the relays you configure: your "
    + "posting relays (by default relay.damus.io, nos.lol and relay.nostr.band) to publish notes, read "
    + "your profile and, if Alerts are on, watch for mentions, DMs and zaps; and your NIP-46 relays (by "
    + "default relay.damus.io, relay.primal.net and nos.lol) to answer signing requests from apps you "
    + "approve. Its Nostr library also connects to purplepag.es and nos.lol to look up relay lists, and "
    + "may read your profile from the relays in your published relay list.",
  "If you connect an app from its nostrconnect:// code (Remote signing, Scan QR or Paste code), the "
    + "daemon also uses the relays that code names to answer that app, after every unlock, until you "
    + "revoke it. Scan QR turns on your camera, with a preview in its own window, only until it reads "
    + "one QR code, you cancel, or two minutes pass. Frames are handed straight to the QR decoder (zbar) "
    + "on this computer; no picture is saved or sent anywhere.",
  "Notes you publish are public and permanent on those relays. Images you attach are uploaded to the "
    + "Blossom server you configure. While unlocked, the daemon downloads your profile picture from "
    + "the address in your Nostr profile (at most 1 MB, PNG, JPEG, GIF or WebP) and keeps a copy, without its "
    + "metadata, in ~/.local/share/omostrich/; the panel shows only that copy.",
  "Other programs running as you can use the signer through ~/.local/state/omarchy/omostrich/control.sock "
    + "(mode 0600). When Tailscale is up, the daemon also listens on TCP port 4737 on this computer's "
    + "Tailscale address, for your own devices such as a phone. A device must first send the token kept "
    + "in ~/.local/state/omarchy/omostrich/tcp-token (mode 0600); until it does, nothing is run, and a "
    + "wrong token closes the connection. A device with the token can do everything the socket allows: "
    + "lock it, unlock it with your passphrase, sign, post, approve apps and change relays while it is "
    + "unlocked, and replace the stored key. Delete tcp-token and restart the daemon to issue a new one.",
  "The daemon logs unlocks, each signature and each post (event kind and id, a short content hash, "
    + "length, relay results), the sender (first 16 characters of the public key), relay and method "
    + "(such as sign_event) of each incoming NIP-46 request, and whether the reply was ok or which error "
    + "it carried, to daemon.log in ~/.local/state/omarchy/omostrich/; never your key, your passphrase, "
    + "a request's content or what was sent back. Settings and your cached profile are in ~/.local/share/omostrich/."
].join("\n\n")

// "0.2.0" from manifest.json's text, or "" when it can't be read.
function manifestVersion(text) {
  try {
    var v = JSON.parse(String(text || "")).version
    return typeof v === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(v) ? v : ""
  } catch (e) {
    return ""
  }
}

// "MIT License, © 2026 Nine Point Labs" from LICENSE's text: its first line
// plus its copyright line, as written there.
function licenseSummary(text) {
  var lines = String(text || "").split("\n")
  var name = ""
  var holder = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "") continue
    if (name === "") name = line
    var m = /^Copyright\s+(?:\(c\)|©)\s*(.+)$/i.exec(line)
    if (m) { holder = "© " + m[1]; break }
  }
  return holder ? name + ", " + holder : name
}

// LICENSE with one line per paragraph, so it wraps to the panel's width.
function licenseBody(text) {
  var paras = String(text || "").replace(/\r/g, "").split(/\n\s*\n/)
  var out = []
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i].split(/\s+/).join(" ").trim()
    if (p !== "") out.push(p)
  }
  return out.join("\n\n")
}

// Highest minor version `has(major, minor)` accepts, as "major.minor"
// (Quickshell.hasVersion / hasQtVersion only answer yes or no), or "".
function probedVersion(has, major) {
  if (typeof has !== "function" || !has(major, 0)) return ""
  var minor = 0
  while (minor < 99 && has(major, minor + 1)) minor++
  return major + "." + minor
}

function builtWith(quickshell, qt) {
  return "Quickshell " + (quickshell || "?") + ", Qt " + (qt || "?")
    + "; signer daemon on Node.js with nostr-tools and NDK"
}

// Version details to paste into a support email.
function details(version, quickshell, qt, desktop) {
  return NAME + " " + (version || "unknown version") + "\n"
    + "Quickshell " + (quickshell || "unknown") + ", Qt " + (qt || "unknown") + "\n"
    + (desktop || "unknown desktop")
}

function mailto(version, detailText) {
  return "mailto:" + SUPPORT_EMAIL
    + "?subject=" + encodeURIComponent(NAME + " " + (version || ""))
    + "&body=" + encodeURIComponent("\n\n--\n" + detailText)
}

if (typeof module !== "undefined") {
  module.exports = {
    NAME: NAME, TAGLINE: TAGLINE, ORGANIZATION: ORGANIZATION, CREATED: CREATED,
    SUPPORT_EMAIL: SUPPORT_EMAIL, PRIVACY: PRIVACY,
    manifestVersion: manifestVersion, licenseSummary: licenseSummary, licenseBody: licenseBody,
    probedVersion: probedVersion, builtWith: builtWith, details: details, mailto: mailto
  }
}
