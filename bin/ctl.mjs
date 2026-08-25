#!/usr/bin/env node
import net from "node:net";
import { socketPath } from "../src/paths.mjs";

const [cmd, payloadJson] = process.argv.slice(2);

if (!cmd) {
  process.stderr.write("usage: omarchy-nostr-signer-ctl <cmd> [json-payload]\n");
  process.exit(2);
}

let payload = {};
if (payloadJson) {
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "invalid_json_payload" }) + "\n");
    process.exit(1);
  }
}

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
