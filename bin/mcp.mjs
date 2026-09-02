#!/usr/bin/env node
// Omostrich MCP v1 — stdio JSON-RPC server exposing exactly two tools
// (status, publish) so Hermes, Claude CLI, and Grok can share one tool
// surface for posting kind-1 notes on Tim's explicit ask, instead of
// each agent needing its own bespoke integration. A Hermes skill alone
// doesn't load in Claude CLI or standalone Grok — MCP is the actual
// shared surface across all three.
//
// This process NEVER holds, logs, or accepts an nsec or passphrase. It
// talks to the exact same Unix control socket bin/ctl.mjs does, using
// the identical line-delimited-JSON protocol (control-socket.mjs) — it
// is a second thin client of that socket, not a second implementation
// of anything the daemon already does. It only ever sends two command
// names to that socket: "status" and "publish". Every other daemon
// command (unlock, import, sign_internal, set_relays, set_nip46_relays,
// set_autolock, set_blossom, set_notifications, blossom_upload, approve,
// deny, revoke_client) is simply never referenced anywhere in this file
// — there is no code path here that could reach them even by mistake.
//
// No @modelcontextprotocol/sdk dependency. That package install was
// blocked twice in this environment by a security-scanner network
// timeout unrelated to the package itself (OSV/deps.dev/ecosyste.ms
// lookups timing out, not a flagged package) — see the repo's own
// README "Agent access" section for the earlier CLI-first call this
// follows. The MCP stdio wire protocol for what v1 needs (initialize,
// tools/list, tools/call, notifications/initialized) is a small, stable,
// versioned JSON-RPC 2.0 surface (see modelcontextprotocol.io's own
// spec) — implementing exactly that here, once, is a smaller footprint
// than pulling in the full SDK for two tools.
import net from "node:net";
import { socketPath } from "../daemon/paths.mjs";

const PROTOCOL_VERSION = "2024-11-05";

// One socket round-trip, mirroring bin/ctl.mjs's own connect/write/read
// logic exactly (same line-delimited-JSON protocol, same daemon on the
// other end) rather than shelling out to that script as a subprocess —
// this avoids a second process spawn per tool call and keeps this file
// self-contained, but the wire behavior is intentionally identical.
function callDaemon(cmd, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let socket;
    try {
      socket = net.createConnection(socketPath);
    } catch {
      finish({ ok: false, error: "daemon_not_running" });
      return;
    }

    let buffer = "";
    socket.on("connect", () => {
      socket.write(JSON.stringify({ cmd, ...payload }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        response = { ok: false, error: "invalid_daemon_response" };
      }
      finish(response);
      socket.end();
    });
    socket.on("error", () => finish({ ok: false, error: "daemon_not_running" }));
    socket.on("close", () => finish({ ok: false, error: "daemon_not_running" }));
  });
}

// --- Tool definitions --------------------------------------------------
// v1 is exactly these two. No unlock, no import, no relay/config
// mutation, no NIP-46 approval control — those stay bar-icon-only.

const TOOLS = [
  {
    name: "status",
    description:
      "Check whether the Omostrich signer is unlocked and see its configured relays. Never returns secrets — no nsec, no passphrase. Use this before publish if you need to know the lock state first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "publish",
    description:
      "Post a kind-1 Nostr text note. Only call this when the user has explicitly asked, in this exact moment, for this exact text to be posted — never speculatively, never as a side effect of another task, never on a schedule. If the signer is locked, this returns a locked error; tell the user to unlock it from the Omostrich bar icon. Never attempt to unlock it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The exact kind-1 note text to publish, verbatim as the user asked for it.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

// --- Tool handlers -------------------------------------------------------

async function handleStatus() {
  const res = await callDaemon("status", undefined);
  if (!res.ok) {
    return toolResult({ ok: false, error: res.error }, true);
  }
  const d = res.data || {};
  // Deliberately re-shaped, not a pass-through of the daemon's full
  // status(): the daemon's status() also returns config.clients (NIP-46
  // authorized-app grants) and bunkerUrl, neither of which an MCP-calling
  // agent needs or should be encouraged to reason about — this tool's
  // whole job is "can I publish right now", not a full admin dump.
  return toolResult(
    {
      ok: true,
      locked: !!d.locked,
      vaultExists: !!d.vaultExists,
      npub: d.npub || null,
      relays: Array.isArray(d.relays) ? d.relays : [],
    },
    false,
  );
}

async function handlePublish(args) {
  const content = typeof args?.content === "string" ? args.content : "";
  if (!content.trim()) {
    // Caught here too (not just left to the daemon) so a caller gets a
    // clear, MCP-native error immediately rather than a round-trip to
    // discover the same thing the daemon would have said anyway.
    return toolResult({ ok: false, error: "content required" }, true);
  }
  const res = await callDaemon("publish", { content });
  if (!res.ok) {
    // Passed through verbatim — "locked", "daemon_not_running", "no
    // vault; import a key first", "not connected to relays", etc. are
    // all real, already-clear daemon error strings. No queueing, no
    // retry, no attempt to unlock — a locked response is returned
    // exactly as the daemon gave it, immediately.
    return toolResult({ ok: false, error: res.error }, true);
  }
  const d = res.data || {};
  return toolResult(
    {
      ok: true,
      eventId: d.event?.id || null,
      publishedTo: Array.isArray(d.publishedTo) ? d.publishedTo : [],
      failed: Array.isArray(d.failed) ? d.failed : [],
    },
    false,
  );
}

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: !!isError,
  };
}

// --- JSON-RPC 2.0 / MCP stdio framing -------------------------------------
// Newline-delimited JSON on stdin/stdout, per the MCP stdio transport spec
// (modelcontextprotocol.io/specification/.../basic/transports): one
// message per line in, one message per line out. stdout carries ONLY
// valid MCP/JSON-RPC messages — every diagnostic goes to stderr instead,
// since a client reading stdout would otherwise choke on anything else
// written there.

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "omostrich", version: "0.2.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // Notification, not a request — no id, no response expected or sent.
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "status") {
        respond(id, await handleStatus());
      } else if (name === "publish") {
        respond(id, await handlePublish(args));
      } else {
        respondError(id, -32601, `unknown tool: ${name}`);
      }
    } catch (err) {
      // A thrown error here means something in this file broke, not the
      // daemon (daemon errors are already ok:false results, not
      // exceptions) — surface it as a protocol-level error rather than
      // silently losing it.
      respondError(id, -32000, String(err?.message || err));
    }
    return;
  }

  if (id !== undefined) {
    respondError(id, -32601, `unknown method: ${method}`);
  }
  // Unknown notifications (no id) are silently ignored, per spec — a
  // client is allowed to send notifications a server doesn't recognize.
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`omostrich-mcp: invalid JSON on stdin, ignoring: ${line}\n`);
      continue;
    }
    handleRequest(msg).catch((err) => {
      process.stderr.write(`omostrich-mcp: unhandled error: ${err?.stack || err}\n`);
    });
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.stderr.write("omostrich-mcp: ready (stdio)\n");
