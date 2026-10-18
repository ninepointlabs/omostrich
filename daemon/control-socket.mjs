import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { stateDir, socketPath, tcpTokenPath } from "./paths.mjs";

const TCP_PORT = 4737;
// Before a TCP client authenticates it gets this long and this many bytes;
// past either, the connection is dropped.
const AUTH_TIMEOUT_MS = 10000;
const AUTH_MAX_BYTES = 4096;

// The TCP token: 32 random bytes as hex, created on first use in the 0700
// state dir with mode 0600, and kept across restarts so a paired phone keeps
// working. Delete the file to rotate it.
export function loadOrCreateToken(file = tcpTokenPath) {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch {}
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

export function tokenMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tailscaleIp() {
  const ifaces = os.networkInterfaces();
  const ts = ifaces["tailscale0"];
  if (!ts) return null;
  const v4 = ts.find((a) => a.family === "IPv4" && !a.internal);
  return v4 ? v4.address : null;
}

// Line-delimited JSON. Two transports — Unix socket for local Omarchy
// plugins, TCP on the Tailscale IP for remote clients (phone).
// Trust boundary: Unix socket = filesystem permissions (dir 0700, socket
// 0600). TCP = tailnet reachability PLUS the token in tcp-token: the first
// line on a TCP connection must be {"auth": "<token>"}; nothing else is
// read until it is, and a wrong token closes the connection.
// Same protocol and handleCommand after that.
//
// options.tcpHost/tcpPort override the Tailscale address (tests use
// 127.0.0.1 and port 0); options.tokenPath overrides the token file.
export function createControlServer(handleCommand, options = {}) {
  const watchers = new Set();
  let tcpToken = null;

  function createConnection(socket, requireToken) {
    let buffer = "";
    let watching = false;
    let authed = !requireToken;
    let rejected = false;

    if (!authed) {
      socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy());
    }

    socket.on("data", async (chunk) => {
      if (rejected) return;
      buffer += chunk.toString("utf8");
      if (!authed && buffer.length > AUTH_MAX_BYTES) {
        socket.destroy();
        return;
      }
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        let request;
        try {
          request = JSON.parse(line);
        } catch {
          request = null;
        }

        if (!authed) {
          if (request && tokenMatches(request.auth, tcpToken)) {
            authed = true;
            socket.setTimeout(0);
            socket.write(JSON.stringify({ ok: true, data: { authenticated: true } }) + "\n");
            continue;
          }
          rejected = true;
          socket.end(JSON.stringify({ ok: false, error: "unauthorized" }) + "\n");
          return;
        }

        if (request === null) {
          socket.write(JSON.stringify({ ok: false, error: "invalid_json" }) + "\n");
          continue;
        }

        if (request.cmd === "watch") {
          watching = true;
          watchers.add(socket);
          socket.write(JSON.stringify({ ok: true, data: { watching: true } }) + "\n");
          continue;
        }

        try {
          const data = await handleCommand(request.cmd, request);
          socket.write(JSON.stringify({ ok: true, data: data ?? null }) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ ok: false, error: String(err?.message || err) }) + "\n");
        }
      }
    });

    socket.on("close", () => {
      if (watching) watchers.delete(socket);
    });
    socket.on("error", () => {
      if (watching) watchers.delete(socket);
    });
  }

  const unixServer = net.createServer((socket) => createConnection(socket, false));
  const tcpServer = net.createServer((socket) => createConnection(socket, true));

  function broadcast(event, data) {
    const line = JSON.stringify({ event, data }) + "\n";
    for (const socket of watchers) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  function listen() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

    const tsIp = options.tcpHost ?? tailscaleIp();
    const tcpPort = options.tcpPort ?? TCP_PORT;
    const tcpAddr = tsIp ? `${tsIp}:${tcpPort}` : null;
    if (tcpAddr) tcpToken = loadOrCreateToken(options.tokenPath);

    const promises = [
      new Promise((resolve, reject) => {
        unixServer.once("error", reject);
        unixServer.listen(socketPath, () => {
          fs.chmodSync(socketPath, 0o600);
          resolve();
        });
      }),
    ];

    if (tcpAddr) {
      promises.push(
        new Promise((resolve, reject) => {
          tcpServer.once("error", reject);
          tcpServer.listen(tcpPort, tsIp, () => {
            resolve();
          });
        }),
      );
    }

    return Promise.all(promises).then(() => {
      const parts = [`unix:${socketPath}`];
      if (tcpAddr) parts.push(`tcp:${tsIp}:${tcpServer.address().port} (token)`);
      return parts;
    });
  }

  return { unixServer, tcpServer, listen, broadcast };
}
