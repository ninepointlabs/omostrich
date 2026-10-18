// The control server's two transports: the Unix socket needs no token, the
// TCP listener needs {"auth": "<token>"} as its first line and runs nothing
// before that. Runs the real server on 127.0.0.1 with a throwaway HOME, so
// Tim's real socket, token and daemon are never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omostrich-control-"));
process.env.HOME = home;
const { createControlServer, loadOrCreateToken, tokenMatches } = await import("../daemon/control-socket.mjs");
const { socketPath, tcpTokenPath } = await import("../daemon/paths.mjs");

const calls = [];
async function handleCommand(cmd, req) {
  calls.push(cmd);
  if (cmd === "status") return { unlocked: false };
  throw new Error("unknown command " + cmd);
}

let server;
let tcpPort;
before(async () => {
  assert.ok(socketPath.startsWith(home), "paths must follow the throwaway HOME");
  server = createControlServer(handleCommand, { tcpHost: "127.0.0.1", tcpPort: 0 });
  const parts = await server.listen();
  tcpPort = server.tcpServer.address().port;
  assert.ok(parts.some((p) => p.startsWith("tcp:127.0.0.1:")), parts.join(", "));
});
after(() => {
  server.unixServer.close();
  server.tcpServer.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// Send lines, collect every response line until the server closes the
// connection or `want` lines have arrived.
function talk(connectOpts, lines, want = Infinity) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(connectOpts);
    const got = [];
    let buf = "";
    let closed = false;
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        got.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
      if (got.length >= want) socket.end();
    });
    socket.on("close", () => { closed = true; resolve({ got, closed }); });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(lines.map((l) => l + "\n").join("")));
    setTimeout(() => { if (!closed) socket.destroy(); }, 3000);
  });
}
const tcp = () => ({ host: "127.0.0.1", port: tcpPort });

test("the token is 32 random bytes in hex, mode 0600, and survives a restart", () => {
  const token = fs.readFileSync(tcpTokenPath, "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tcpTokenPath).mode & 0o777, 0o600);
  assert.equal(loadOrCreateToken(), token);
});

test("tokenMatches compares exactly and refuses non-strings and other lengths", () => {
  assert.equal(tokenMatches("abc", "abc"), true);
  assert.equal(tokenMatches("abd", "abc"), false);
  assert.equal(tokenMatches("ab", "abc"), false);
  assert.equal(tokenMatches(undefined, "abc"), false);
  assert.equal(tokenMatches(123, "123"), false);
});

test("the Unix socket works without a token", async () => {
  calls.length = 0;
  const { got } = await talk({ path: socketPath }, [JSON.stringify({ cmd: "status" })], 1);
  assert.deepEqual(got[0], { ok: true, data: { unlocked: false } });
  assert.deepEqual(calls, ["status"]);
});

test("TCP: a command before auth is refused, closed, and never run", async () => {
  calls.length = 0;
  const { got, closed } = await talk(tcp(), [JSON.stringify({ cmd: "import", nsec: "x", passphrase: "y", replace: true })]);
  assert.deepEqual(got, [{ ok: false, error: "unauthorized" }]);
  assert.equal(closed, true);
  assert.deepEqual(calls, []);
});

test("TCP: a wrong token is refused and nothing after it runs", async () => {
  calls.length = 0;
  const { got, closed } = await talk(tcp(), [JSON.stringify({ auth: "0".repeat(64) }), JSON.stringify({ cmd: "status" })]);
  assert.deepEqual(got, [{ ok: false, error: "unauthorized" }]);
  assert.equal(closed, true);
  assert.deepEqual(calls, []);
});

test("TCP: non-JSON as the first line is refused", async () => {
  calls.length = 0;
  const { got } = await talk(tcp(), ["hello"]);
  assert.deepEqual(got, [{ ok: false, error: "unauthorized" }]);
  assert.deepEqual(calls, []);
});

test("TCP: the right token, then commands work as on the Unix socket", async () => {
  calls.length = 0;
  const token = fs.readFileSync(tcpTokenPath, "utf8").trim();
  const { got } = await talk(tcp(), [JSON.stringify({ auth: token }), JSON.stringify({ cmd: "status" })], 2);
  assert.deepEqual(got[0], { ok: true, data: { authenticated: true } });
  assert.deepEqual(got[1], { ok: true, data: { unlocked: false } });
  assert.deepEqual(calls, ["status"]);
});

test("TCP: more than 4 KB without authenticating closes the connection", async () => {
  calls.length = 0;
  const { got, closed } = await talk(tcp(), ["x".repeat(5000)]);
  assert.deepEqual(got, []);
  assert.equal(closed, true);
  assert.deepEqual(calls, []);
});
