import fs from "node:fs";
import net from "node:net";
import { stateDir, socketPath } from "./paths.mjs";

// Line-delimited JSON over a Unix socket. One request per line in, one
// response line out — except `watch`, which keeps the connection open and
// pushes further `{"event": ..., "data": ...}` lines until the client
// disconnects. The socket file itself is the trust boundary: anything that
// can open it already runs as this user, so there is no auth beyond
// filesystem permissions (dir 0700, socket 0600).
export function createControlServer(handleCommand) {
  const watchers = new Set();

  const server = net.createServer((socket) => {
    let buffer = "";
    let watching = false;

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        let request;
        try {
          request = JSON.parse(line);
        } catch {
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
  });

  function broadcast(event, data) {
    const line = JSON.stringify({ event, data }) + "\n";
    for (const socket of watchers) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  function listen() {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }

  return { server, listen, broadcast };
}
