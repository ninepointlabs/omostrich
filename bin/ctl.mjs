#!/usr/bin/env node
import net from "node:net";
import { socketPath } from "../src/paths.mjs";

const [cmd] = process.argv.slice(2);

if (!cmd) {
  process.stderr.write("usage: omostrich-ctl <cmd> [json-payload]\n");
  process.stderr.write("       (or pipe the JSON payload on stdin instead of an argv arg)\n");
  process.exit(2);
}

// Audit item 1 (HIGH): nsec/passphrase must never appear on argv, because
// for the life of the child process any other process running as this
// same user can read argv via /proc/<pid>/cmdline or `ps aux` — a much
// wider trust boundary than "the daemon socket, which is 0600 and
// filesystem-protected". Two payload sources, in priority order:
//   1. stdin, if anything was actually piped/written to it. This is now
//      the ONLY path Panel.qml/ComposeOverlay.qml use for unlock/import
//      (see their own runAction()) — passphrases and nsecs never touch
//      process.argv at all anymore.
//   2. process.argv[3], kept ONLY for commands that carry no secret
//      (status, lock, list_pending, revoke_client, etc.) and for anyone
//      running this by hand at a terminal — a human's own shell history
//      already sees what they typed regardless of whether it's argv or
//      an interactive stdin paste, so this isn't a new exposure for that
//      case, only for a piped-payload caller like the plugin, which is
//      exactly why the plugin no longer uses it.
//
// Reads exactly ONE LINE from stdin, not until EOF/close. Two reasons,
// both hard requirements, not just an optimization:
//
// 1. Quickshell's Process type (qs.Io) exposes `write()` on stdin but has
//    NO way to close/signal EOF on it from QML at all. A caller that
//    wrote its payload and then waited for stdin to end would hang
//    forever on every command that DOES write a payload.
// 2. For commands that never write anything to stdin at all (status,
//    lock, approve, etc. — the majority), whether Quickshell leaves that
//    child's stdin pipe open indefinitely or closes it immediately isn't
//    documented anywhere reachable from this repo, and guessing wrong in
//    either direction breaks something: assuming "always closes
//    promptly" risks hanging on some future/different transport;
//    assuming "always stays open" needs the newline-driven resolve above
//    anyway. So this races the newline-based read against a short
//    timeout instead of trusting stdin's close behavior at all. A real
//    payload write happens synchronously right after the child starts
//    (see Panel.qml/ComposeOverlay.qml's runAction — same
//    onStarted-immediately pattern the stock network plugin's
//    enterpriseConnect Process already uses for its own secret-over-
//    stdin case), so 150ms is generous slack for scheduling jitter while
//    still keeping every argv-only command (the common case, called from
//    a real terminal or a script) fast.
//
// Newline-terminated payloads are already this whole codebase's
// convention (control-socket.mjs: one JSON line in, one JSON line out
// over the Unix socket) — the QML side writes
// `JSON.stringify(payload) + "\n"` for exactly this reason.
function readStdinPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      // No pipe attached at all — nothing to read, don't hang waiting for
      // input that will never come.
      resolve(null);
      return;
    }
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(buffer.trim() ? buffer : null), 150);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) finish(buffer.slice(0, newlineIndex));
    });
    process.stdin.on("end", () => finish(buffer.trim() ? buffer : null));
    process.stdin.on("error", () => finish(null));
  });
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_json_payload" }) + "\n");
    process.exit(1);
  }
}

const stdinRaw = await readStdinPayload();
const argvRaw = process.argv[3];
const payload = parsePayload(stdinRaw ?? argvRaw);

const socket = net.createConnection(socketPath);
let buffer = "";

socket.on("connect", () => {
  socket.write(JSON.stringify({ cmd, ...payload }) + "\n");
});

socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + 1);
    if (line.trim()) process.stdout.write(line + "\n");
    if (cmd !== "watch") socket.end();
  }
});

socket.on("error", () => {
  process.stdout.write(JSON.stringify({ ok: false, error: "daemon_not_running" }) + "\n");
  process.exit(1);
});

socket.on("close", () => {
  if (cmd !== "watch") process.exit(0);
});
