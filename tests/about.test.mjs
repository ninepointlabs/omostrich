// Node test runner (`npm test`, or `node --test tests/`) for the About page.
// Its facts come from the repo's own files (manifest.json, LICENSE, the first
// commit), and its privacy statement must name every network host the code
// can reach. Reads source files only: never touches a vault, the daemon, its
// socket, or a relay.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

// About.js is a QML JavaScript resource, not a Node module (this package is
// "type": "module"), so evaluate it the way QML would and take its exports.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(read("About.js"), sandbox, { filename: "About.js" });
const About = sandbox.module.exports;

// Source files that make up the plugin and the daemon (not node_modules).
function sourceFiles() {
  const out = [];
  for (const dir of [".", "bin", "daemon"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (/\.(qml|js|mjs|sh|service)$/.test(f) && f !== "About.js") out.push(path.join(dir, f));
    }
  }
  return out;
}

// Code lines only: whole-line comments are documentation, not behaviour.
function codeLines(file) {
  return read(file).split("\n").filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l));
}

test("version comes from manifest.json", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(About.manifestVersion(read("manifest.json")), manifest.version);
  assert.match(About.manifestVersion(read("manifest.json")), /^\d+\.\d+\.\d+$/);
  assert.equal(About.manifestVersion("not json"), "");
  assert.equal(About.manifestVersion('{"version":"1.0 <b>"}'), "");
  assert.equal(About.NAME, manifest.name);
});

test("license summary and text come from LICENSE", () => {
  const text = read("LICENSE");
  assert.equal(About.licenseSummary(text), "MIT License, © 2026 Nine Point Labs");
  const body = About.licenseBody(text);
  assert.ok(body.startsWith("MIT License\n\nCopyright (c) 2026 Nine Point Labs\n\nPermission is hereby granted"));
  assert.ok(body.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
  assert.ok(!body.includes("a copy\nof"), "one line per paragraph");
});

test("facts: Nine Point Labs, created date, support address", () => {
  assert.equal(About.ORGANIZATION, "Nine Point Labs");
  assert.equal(About.SUPPORT_EMAIL, "help@ninepointlabs.com");
  const first = execFileSync("git", ["log", "--reverse", "--format=%ad", "--date=format:%B %Y"],
    { cwd: ROOT, encoding: "utf8" }).split("\n")[0];
  assert.equal(About.CREATED, first);
});

test("versions, details and mailto", () => {
  assert.equal(About.probedVersion((major, minor) => major === 6 && minor <= 11, 6), "6.11");
  assert.equal(About.probedVersion((major, minor) => major === 0 && minor <= 3, 0), "0.3");
  assert.equal(About.probedVersion(() => false, 6), "");
  assert.equal(About.probedVersion(null, 6), "");
  const details = About.details("0.2.0", "0.3", "6.11", "Hyprland, wayland");
  assert.equal(details, "Omostrich 0.2.0\nQuickshell 0.3, Qt 6.11\nHyprland, wayland");
  const url = About.mailto("0.2.0", details);
  assert.ok(url.startsWith("mailto:help@ninepointlabs.com?subject=Omostrich%200.2.0&body="));
  assert.equal(decodeURIComponent(url.split("&body=")[1]), "\n\n--\n" + details);
});

test("privacy statement names every host and relay in the code", () => {
  // Placeholder text in an input field, never contacted.
  const placeholders = new Set(["blossom.example"]);
  const found = [];
  for (const file of sourceFiles()) {
    for (const line of codeLines(file)) {
      for (const m of line.matchAll(/\b(?:wss?|https?):\/\/([A-Za-z0-9.-]+)/g)) {
        if (!placeholders.has(m[1])) found.push([file, m[1]]);
      }
    }
  }
  assert.ok(found.length > 0, "expected the default relays in daemon/config.mjs");
  for (const [file, host] of found) assert.ok(About.PRIVACY.includes(host), `${host} (${file}) is not named in About.PRIVACY`);
  // Anything else is covered only by these clauses.
  assert.match(About.PRIVACY, /the relays you configure/);
  assert.match(About.PRIVACY, /Blossom server you configure/);
  assert.match(About.PRIVACY, /No account and no telemetry/);
  assert.match(About.PRIVACY, /public and permanent/);
});

test("privacy statement names the Nostr library's own default relays", (t) => {
  const ndk = path.join(ROOT, "node_modules/@nostr-dev-kit/ndk/dist/index.mjs");
  if (!fs.existsSync(ndk)) return t.skip("run npm ci first");
  const m = /DEFAULT_OUTBOX_RELAYS\s*=\s*\[([^\]]*)\]/.exec(fs.readFileSync(ndk, "utf8"));
  assert.ok(m, "NDK's DEFAULT_OUTBOX_RELAYS moved; re-check what the daemon connects to");
  const hosts = [...m[1].matchAll(/wss?:\/\/([A-Za-z0-9.-]+)/g)].map((h) => h[1]);
  assert.ok(hosts.length > 0);
  for (const host of hosts) assert.ok(About.PRIVACY.includes(host), host);
  // The daemon leaves NDK's outbox model on; if that changes, so does the text.
  assert.doesNotMatch(read("daemon/daemon.mjs"), /enableOutboxModel|outboxRelayUrls/);
});

test("only the Blossom upload and the bounded avatar download make HTTP requests, and the panel loads only local images", () => {
  const fetchers = sourceFiles().filter((f) => codeLines(f).some((l) => /\bfetch(Impl)?\(/.test(l)));
  assert.deepEqual(fetchers.sort(), [path.join("daemon", "avatar.mjs"), path.join("daemon", "blossom.mjs")]);
  const imageSources = [];
  for (const f of sourceFiles().filter((f) => f.endsWith(".qml"))) {
    for (const l of codeLines(f)) {
      const m = /^\s*source:\s*(.+)$/.exec(l);
      if (m) imageSources.push(m[1].trim());
    }
  }
  assert.deepEqual(imageSources.sort(), [
    "\"ostrich.png\"", // bar icon, local
    "root.attachPreview", // upload preview: the local file, file:// only
    "root.profilePicture", // daemon's bounded local copy, file:// only
    "root.showBunkerQr ? root.bunkerQrSource : \"\"", // bunker QR, local file from qrencode
    "silhouette", // bar icon tint (LockIcon.qml), local
  ]);
  assert.match(About.PRIVACY, /profile picture/);
  assert.match(About.PRIVACY, /at most 1 MB/);
  const panel = read("Panel.qml");
  assert.match(panel, /readonly property string profilePicture: \(root\.profile && \/\^file:/);
  assert.match(panel, /root\.attachPreview = res\.data\.previewable \? root\.fileUrl\(p, /);
  // Every Image in the panel has a sourceSize, so decode size is bounded by it.
  for (const f of ["Panel.qml", "LockIcon.qml"]) {
    const blocks = read(f).split(/\bImage \{/).slice(1);
    assert.ok(blocks.length > 0, f);
    for (const b of blocks) assert.match(b.slice(0, 600), /sourceSize\.width/, `${f}: Image without sourceSize`);
  }
});

test("privacy statement matches the vault, socket and log code", () => {
  const vault = read("daemon/vault.mjs");
  assert.match(vault, /"aes-256-gcm"/);
  assert.match(vault, /crypto\.scryptSync/);
  assert.match(vault, /chmodSync\(vaultPath, 0o600\)/);
  assert.match(About.PRIVACY, /AES-256-GCM/);
  assert.match(About.PRIVACY, /scrypt/);
  const paths = read("daemon/paths.mjs");
  assert.match(paths, /"\.local", "share", "omostrich"/);
  assert.match(paths, /"\.local", "state", "omarchy", "omostrich"/);
  assert.match(paths, /socketPath = path\.join\(stateDir, "control\.sock"\)/);
  assert.ok(About.PRIVACY.includes("~/.local/share/omostrich/vault.json"));
  assert.ok(About.PRIVACY.includes("~/.local/state/omarchy/omostrich/control.sock"));
  const control = read("daemon/control-socket.mjs");
  assert.match(control, /chmodSync\(socketPath, 0o600\)/);
  // The tailnet listener: port, interface and the fact that it has no auth
  // must all be in the privacy text, or a reader would think the socket is the only way in.
  const port = control.match(/const TCP_PORT = (\d+);/);
  assert.ok(port, "TCP_PORT not found in control-socket.mjs");
  assert.match(control, /ifaces\["tailscale0"\]/);
  assert.ok(About.PRIVACY.includes("TCP port " + port[1]), "privacy text must name TCP port " + port[1]);
  assert.match(About.PRIVACY, /Tailscale address/);
  // TCP is token-gated: the TCP server requires auth, the token lives in tcp-token.
  assert.match(control, /net\.createServer\(\(socket\) => createConnection\(socket, true\)\)/);
  assert.match(read("daemon/paths.mjs"), /tcpTokenPath = path\.join\(stateDir, "tcp-token"\)/);
  assert.ok(About.PRIVACY.includes("~/.local/state/omarchy/omostrich/tcp-token"));
  assert.match(About.PRIVACY, /must first send the token/);
  assert.match(About.PRIVACY, /replace the stored key/);
  // The NIP-46 request log records sender, relay and method, never params;
  // replies log ok or the error string, never the result.
  const daemonSrc = read("daemon/daemon.mjs");
  assert.match(daemonSrc, /const from = event\.pubkey\?\.slice\(0, 16\);/);
  assert.match(daemonSrc, /log\(`nip46 request \$\{method \|\| "\(no method\)"\} from \$\{from\} via \$\{via\}`\)/);
  assert.match(daemonSrc, /const outcome = result === "error" \? `error: \$\{error\}` : "ok";/);
  assert.match(About.PRIVACY, /first 16 characters of the public key/);
  assert.match(About.PRIVACY, /never your key, your passphrase, a request's content or what was sent back/);
  // Relays are opened only by unlockWith(): no NDK outside it.
  const daemon = read("daemon/daemon.mjs");
  assert.equal(daemon.match(/new NDK\(/g).length, 1);
  assert.ok(daemon.indexOf("new NDK(") > daemon.indexOf("async function unlockWith("));
  assert.ok(daemon.indexOf("new NDK(") < daemon.indexOf("function lockNow("));
});

test("the About page never calls the signer daemon", () => {
  for (const f of ["About.js", "AboutView.qml"]) {
    const text = read(f).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(text, /ctlPath|nodeBin|runAction|Process\s*\{|execDetached/, f);
  }
  // Panel.qml opens it without touching the daemon.
  const panel = read("Panel.qml");
  const setAbout = panel.slice(panel.indexOf("function setAbout("), panel.indexOf("function setAbout(") + 400);
  assert.doesNotMatch(setAbout.split("\n  }\n")[0], /runAction|refreshStatus|ctlPath/);
});
