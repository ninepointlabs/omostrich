# Omostrich posting skill (policy, not an implementation)

This file is policy for any agent (Hermes, Claude Code/CLI, Grok, etc.)
that wants to post a Nostr note through Omostrich. It does not implement
anything itself — the actual posting logic lives entirely in this
repo's daemon (`src/daemon.mjs`) and its two client surfaces:

- **MCP** (`bin/mcp.mjs`) — preferred when your tool-calling setup can
  connect an MCP server. Exposes exactly two tools: `status` and
  `publish`. See the repo README's "Connect an agent" section for the
  exact connection command for Hermes and Claude CLI.
- **`omostrich-ctl`** (`bin/ctl.mjs`, symlinked to `~/.local/bin/omostrich-ctl`) —
  use this if MCP isn't connected for some reason. Same daemon, same
  two effective operations, just a plain CLI:
  ```bash
  omostrich-ctl status
  omostrich-ctl publish '{"content":"..."}'
  ```

Neither surface ever holds, logs, or accepts an nsec or a passphrase.
Both are thin clients of the same Unix control socket the bar plugin
itself uses — the daemon is the only process that ever touches the
decrypted key.

## Rules — these are not enforced by the daemon, they are the deal for
## using either surface at all

1. **Post only when Tim explicitly asks, in that exact moment, for that
   exact text.** Not "he mentioned wanting to post something earlier,"
   not "this seems like something he'd want posted," not as a side
   effect of some other task you were doing. If he didn't ask you,
   right now, to post this, don't call `publish`.

2. **Never auto-post. Never schedule it. Never cron it.** There is no
   legitimate "post this every day" or "post this when X happens" use
   of this tool. If you're tempted to wire this into any kind of
   automation, stop — that's explicitly out of scope and was never
   approved.

3. **Never invent content he didn't ask you to post.** Don't summarize,
   don't embellish, don't "improve" the wording unless he specifically
   asked you to draft something and then separately confirmed posting
   it. What gets published should be recognizably what he asked for.

4. **Never attempt to unlock the vault.** If `status` shows `locked:
   true`, or `publish` comes back with `{"ok":false,"error":"locked"}`,
   tell Tim the signer is locked and to unlock it himself from the
   Omostrich bar icon (the ostrich). No agent has, or should ever
   construct, the passphrase. Do not retry, do not queue the post for
   later, do not try any workaround — just report it and stop.

5. **Check `status` first if you're not sure of the lock state**, but
   don't over-poll it — one check before a `publish` attempt is enough.

6. **Never print, log, or otherwise surface an nsec or passphrase** in
   any output, transcript, or message to Tim or anyone else. This
   should never come up in practice — neither tool surface ever hands
   you one — but if you ever somehow see raw key material anywhere in
   a response, treat that as a bug to report, not something to relay.

## What "success" looks like

A `publish` call returns which relays it actually reached
(`publishedTo`) and which it didn't (`failed`) — report both if either
is non-empty, don't just say "posted" and move on. A partial publish
(some relays succeeded, some didn't) is still worth telling Tim about
honestly rather than rounding up to "done."
