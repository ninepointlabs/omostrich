# Omostrich

Omostrich (Omarchy + ostrich) is a local Nostr signing and posting tool
for the [Omarchy](https://omarchy.org) desktop. One bar chip lets you
unlock a locally-encrypted key, compose and post notes, and act as a
NIP-46 remote signer for other Nostr apps — all without any app but this
one ever touching your private key.

It is **not** a Nostr client. There's no timeline, no feed, no replies,
no DMs to read. It composes, it posts, it signs on request. That's it.

## What it actually does

### The bar chip

One icon (id `tim.omostrich`), an ostrich mark that dims when the
signer daemon is unreachable and shows a small red badge with a count
when something needs your approval.

**Unlock.** Paste your nsec once to set up; after that, just a
passphrase. Pick how long the unlock lasts before you type it —
**5 minutes, 30 minutes, 1 hour, 12 hours, or 24 hours** — right on the
unlock form. Whatever you pick becomes the default next time. You can
also change it later from Settings without re-locking.

**Compose.** A text field that wraps and grows with your note (up to a
sane cap, then it scrolls). Enter posts. Shift+Enter adds a newline.
Shows a live character count and flags a "long note" past 700
characters — a soft nudge, not a hard limit; relays accept longer notes
fine. Posts as a kind-1 text note to every relay you've configured, and
tells you exactly which relays it actually reached and which it didn't
— not just a bare success/fail.

**Attach an image.** Optional, needs a Blossom server URL configured
first (see Settings). Three ways in: type/paste a file path, paste an
image straight from the clipboard, or use the real file picker
(`zenity`, filtered to png/jpg/webp/gif). The daemon uploads the blob
(BUD-01/NIP-98 signed auth), shows you the preview and resulting URL,
and appends it to the note on post — with an `imeta` tag if the hash,
mime type, and size are all known.

**Identity.** Once unlocked, the chip shows who you are — your NIP-05
if you've set one, else your kind-0 display name, else your name, else
a truncated npub as a last resort. Fetched from the relay pool after
unlock and cached locally so it doesn't have to wait on a fresh
network round-trip every time. A circular profile picture shows up too,
if your kind-0 has one.

**Settings** (collapsed by default — one line, click to expand):
- **Relays** — the comma-separated list you post to.
- **Blossom** — one media server URL. Empty = attachments are off, and
  the composer says so plainly rather than pretending an upload
  happened.
- **Alerts** — an on/off switch for desktop notifications. While
  unlocked and on, Omostrich watches for mentions, DMs, and zaps
  addressed to you and fires a toast (via `notify-send`, picked up by
  Omarchy's own notification service) — content is never decrypted for
  the toast, DMs just say "encrypted message." No history replay, no
  inbox, no feed — the toast is the whole feature.
- **Auto-lock** — same 5m/30m/1h/12h/24h picker as the unlock form, so
  you can change how long you stay unlocked without having to lock and
  re-unlock to do it.

**NIP-46 remote signing** (also collapsed, but auto-expands the moment
something's actually pending, so you never miss an approval). Copy your
`bunker://` connection string straight from here to paste into any
NIP-46-aware client — Amber, nsec.app, a web app, whatever supports
Nostr Connect. Every incoming request from an app you haven't already
trusted shows up here with the method being requested, and — for
`sign_event` specifically, the one method that actually produces a
public, permanent artifact — the event's **kind and a content preview**,
so approving isn't blind. Three choices per request: **Approve once**,
**Always allow** (scoped to that exact method for that exact app —
approving `sign_event` once doesn't also silently hand over
`get_public_key` forever), or **Deny**. Unanswered requests auto-deny
after two minutes; a signer should never sit there waiting on you
indefinitely. Authorized apps and what they've been granted are listed
and revocable.

### Super+N: compose without opening the bar

Hit `SUPER + N` from anywhere and a small compose-only overlay appears,
already keyboard-focused — no click required. Same wrap/grow field,
same Enter-to-post/Shift+Enter-for-newline, `Esc` dismisses. If the
vault's locked or unreachable, it says so plainly and points you at the
bar icon instead of pretending to be a working composer. This is the
exact same daemon, same `publish` command, same everything as the bar
dropdown — just a faster way in when you don't want to click through
the bar first.

## How it's built

**The daemon** (`daemon/daemon.mjs`) is the only process that ever holds
your decrypted private key, and only in memory, and only while
unlocked. It:

- Imports an nsec once and encrypts it at rest with AES-256-GCM under a
  key derived from your passphrase via scrypt (N=2^17 — deliberately
  expensive, to raise the cost of an offline guess against a stolen
  vault file).
- Talks over a Unix domain socket (`~/.local/state/omarchy/omostrich/control.sock`,
  mode 0600 in a 0700 directory) — the trust boundary is "anything
  running as this user can already reach it," same as any local IPC
  socket. `bin/ctl.mjs` (installed as `omostrich-ctl`) is a thin CLI
  wrapper over it: one JSON command in, one JSON response out.
- Publishes a note to **every relay you've configured** by resolving
  each one explicitly and publishing to it directly — not just
  whichever subset happened to already be connected at that instant,
  which was a real bug caught and fixed (a partial-connect race could
  silently skip a relay that hadn't finished its handshake yet).
- Runs NIP-46 remote signing on its **own separate relay list**
  (`nip46Relays`), not your posting relays. This matters: a NIP-46
  client's very first connection is signed by a fresh, disposable
  keypair it just generated — not your identity — and an invite-only
  posting relay that already trusts *you* will happily reject that
  unknown throwaway key. Splitting the lists is what makes a real
  third-party NIP-46 client's first connection actually work.
- Never puts a secret on a command line. `omostrich-ctl` reads its JSON
  payload from stdin, not argv — an nsec or passphrase living in argv
  would be visible to any other process running as you (`ps aux`,
  `/proc/<pid>/cmdline`) for the life of that process. This is verified,
  not assumed — it was proven by actually inspecting a running process's
  argv while it held a payload over stdin.
- Keeps an **audit log** (`~/.local/state/omarchy/omostrich/daemon.log`)
  of every signature it produces and every note it publishes — event
  kind, event id, a truncated content hash, content length. Never the
  key, never the passphrase, never full content for the log's own sake.
  Silent internal signing does not reset the auto-lock timer on its own
  — only real, user-initiated activity (a publish, an approved NIP-46
  request) does, so nothing can quietly poll for signatures while also
  keeping the vault open indefinitely.
- Auto-locks after your configured idle window, always. If it isn't
  unlocked, `publish` refuses outright with a clear "locked" error — it
  does not queue, does not retry, does not attempt to unlock itself.
- Runs as a systemd `--user` service with real sandboxing:
  `LimitCORE=0` (this machine can produce crash dumps; without this a
  crash while unlocked would leave your raw key sitting in a core file
  on disk, completely outside the vault's own encryption),
  `NoNewPrivileges=true`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `PrivateTmp=true`, and explicit
  `ReadWritePaths=` limited to exactly the two directories it actually
  needs.

**The plugin** (`manifest.json`, `Panel.qml`, `ComposeOverlay.qml`,
`LockIcon.qml` at the repo root) is Quickshell QML for the Omarchy
shell. It never imports a key, never decrypts anything, never touches
the socket protocol directly — every single action shells out to
`omostrich-ctl` and reads back a JSON response. If you never trust
anything else in this repo, that's the one property worth verifying
yourself: grep the QML for `nsec` and you'll find it only ever appears
as something typed into a field and handed straight to a subprocess's
stdin, never stored, never logged, never held longer than it takes to
write it to that pipe.

## Security model, plainly

- **The QML never holds your key.** Not in memory, not on disk, not
  briefly, not ever. The daemon is the only thing that decrypts it, and
  only into its own process memory, and only while unlocked.
- **Locked means locked.** Every signing path checks the unlock state
  first and refuses with a plain error if it isn't unlocked — there's
  no back door, no cached signature, no "just this once."
- **The trust boundary is your own user account.** The control socket
  has no separate authentication beyond filesystem permissions (0600,
  owned by you) — the assumption, standard for local Unix-socket IPC,
  is that anything already running as you is already inside your trust
  boundary. This is why other agents (Hermes, Claude Code, etc.) can
  post on your explicit request by calling the same CLI you do, and
  also why the daemon logs every signature it produces — so "who signed
  what, and when" has a real answer even though the socket itself
  doesn't ask "who are you."
- **NIP-46 approvals are per-app, per-method, and never blind for the
  method that matters.** Approving one thing doesn't silently approve
  everything, and you can always see what you're actually signing
  before you say yes.

## Install

Requires Node (any install — system package, `mise`, `nvm`, `fnm`,
`volta`, whatever puts `node` on your `PATH`) and
[Omarchy](https://omarchy.org).

```bash
git clone https://github.com/ninepointlabs/omostrich ~/Projects/omostrich
cd ~/Projects/omostrich
npm ci                # installs exactly what's pinned in package-lock.json
./install-daemon.sh   # installs + starts the systemd --user service, symlinks the CLI
./install-plugin.sh   # deploys the bar widget + Super+N overlay, adds it to your bar
```

`install-daemon.sh` symlinks `omostrich.service` into
`~/.config/systemd/user/`, enables and starts it, and symlinks
`bin/ctl.mjs` to `~/.local/bin/omostrich-ctl` (make sure `~/.local/bin`
is on your `PATH`).

`install-plugin.sh` copies **every** `*.qml` file, `*.png`, and
`manifest.json` from the repo root into
`~/.config/omarchy/plugins/omostrich/` — including `LockIcon.qml`,
which is easy to forget if you ever copy plugin files by hand instead
of running the script. `Panel.qml`'s bar-icon `iconComponent`
instantiates `LockIcon` directly; without `LockIcon.qml` present in
the deployed directory, Quickshell fails to draw the chip at all and
you get a blank slot on the bar where the icon should be — this
happened for real on this machine right after an earlier repo rename,
from a hand-copy that only grabbed `Panel.qml` + `ComposeOverlay.qml`
+ `ostrich.png` + `manifest.json` and missed `LockIcon.qml`. **Don't
hand-copy a subset of files — always run `install-plugin.sh`**, which
globs `*.qml` and picks up every QML file in the directory (currently
`Panel.qml`, `ComposeOverlay.qml`, and `LockIcon.qml`) with nothing to
remember or leave out. It also runs `omarchy bar put tim.omostrich`
and restarts the Omarchy shell so the change is live.

Re-run `install-plugin.sh` after any plugin edit — Quickshell doesn't
reliably pick up a changed QML file without a shell restart, which
this script always does at the end.

Add the `SUPER + N` overlay bind to your own
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + N", "Omostrich compose", "omarchy-shell shell toggle tim.omostrich")
```

Then open the bar icon, paste in an nsec and a passphrase, and you're
set up.

If you ever want to move the bar icon, remove it, or re-add it:

```bash
omarchy bar move tim.omostrich --section left   # move it
omarchy bar put tim.omostrich --before omarchy.tray
omarchy plugin disable tim.omostrich            # take it off the bar
omarchy plugin enable tim.omostrich             # put it back
```

To uninstall:

```bash
omarchy plugin disable tim.omostrich
rm -rf ~/.config/omarchy/plugins/omostrich
systemctl --user disable --now omostrich.service
rm ~/.config/systemd/user/omostrich.service ~/.local/bin/omostrich-ctl
```

### Paths

| What | Where |
|---|---|
| Repo | `~/Projects/omostrich` |
| Plugin manifest + QML | repo root (`manifest.json`, `Panel.qml`, `ComposeOverlay.qml`, `LockIcon.qml`, `ostrich.png`) |
| Daemon source | `daemon/` |
| Encrypted vault + config + profile cache | `~/.local/share/omostrich/` |
| Control socket, daemon log, notification dedup state | `~/.local/state/omarchy/omostrich/` |
| CLI | `omostrich-ctl` (symlinked from `bin/ctl.mjs`) |
| MCP server (stdio) | `bin/mcp.mjs` — run directly, no symlink needed |
| systemd unit | `omostrich.service` |
| Plugin (deployed) | `~/.config/omarchy/plugins/omostrich/` |
| Plugin id | `tim.omostrich` |

## Operating it

```bash
systemctl --user status omostrich.service
tail -f ~/.local/state/omarchy/omostrich/daemon.log
omostrich-ctl status
```

## Agent access

Two ways for an agent (Hermes, Claude Code/CLI, Grok, etc.) to post a
note on your explicit ask — MCP if your setup supports connecting one,
`omostrich-ctl` otherwise. Neither surface ever holds, logs, or accepts
an nsec or passphrase; both are thin clients of the same daemon.
Policy for any agent using either is in [`SKILL.md`](SKILL.md) —
explicit-ask-only, no auto-posting, never attempt to unlock.

### MCP (v1: `status` and `publish` only)

`bin/mcp.mjs` is a stdio MCP server exposing exactly two tools:

- **`status`** — `{ locked, vaultExists, npub, relays }`. No secrets.
- **`publish`** — takes `{ content: string }`, returns
  `{ eventId, publishedTo, failed }` on success or an error string
  (e.g. `"locked"`) with `isError: true` on failure. Same daemon
  `publish` command the bar plugin uses — signs a kind-1 note and
  broadcasts to every configured relay.

Nothing else is exposed over MCP. Unlocking, importing a key, changing
relays/settings, and approving/denying NIP-46 requests all stay bar-icon
only — deliberately not reachable from any agent.

**`bin/mcp.mjs` ships only in the git clone — it is NOT part of the
deployed bar plugin.** `install-plugin.sh` copies `*.qml`, `*.png`, and
`manifest.json` from the repo root into
`~/.config/omarchy/plugins/omostrich/` — that directory does not (and
should never) contain `mcp.mjs`. **Installing the bar chip does not
register MCP with anything.** Running `./install-daemon.sh` (daemon)
and `./install-plugin.sh` (bar icon) gets you a working chip and a
running daemon, but Hermes and Claude Code have no idea Omostrich
exists until you separately run the `mcp add` command below, pointing
at the repo path directly (`~/Projects/omostrich/bin/mcp.mjs`) — not
the deployed plugin directory, which never has this file. So the full
sequence for a new machine is: clone, `npm ci`, `./install-daemon.sh`
(daemon), `./install-plugin.sh` (bar icon) if you want the chip too,
then `mcp add` per-agent as its own separate step.

`bin/mcp.mjs` talks to the exact same Unix control socket
`omostrich-ctl` does — same daemon, same trust boundary, no separate
auth. Unlock the vault from the ostrich bar icon first; a `publish`
call against a locked vault returns the daemon's own `"locked"` error
verbatim, same as `omostrich-ctl` would. **No nsec or passphrase ever
crosses the MCP protocol** — connecting MCP doesn't change what the
daemon will let you do or see; it's just a second way to call the same
two operations (`status`, `publish`) that were already possible from
the CLI.

**Connect it in Hermes:**

```bash
hermes mcp add omostrich --command node --args ~/Projects/omostrich/bin/mcp.mjs
```

This prompts interactively — `Enable all 2 tools? [Y/n/select]` — and
if stdin isn't a real terminal (running it from a script, a non-TTY
shell, piped from another tool) that prompt gets nothing and the whole
add is **cancelled with nothing saved**, silently, no error. Confirmed
on this machine: running the bare command above with stdin closed
prints "Connected! Found 2 tool(s)" and then just "Cancelled." —
`hermes mcp list` afterward shows nothing configured. Answer the
prompt explicitly in that case:

```bash
printf 'Y\n' | hermes mcp add omostrich --command node --args ~/Projects/omostrich/bin/mcp.mjs
```

That saves it (confirmed: `hermes mcp list` then shows `omostrich` with
2/2 tools enabled) and prints its own reminder — **start a new Hermes
session before the tools show up.** An already-running session doesn't
pick up a newly-added MCP server on its own.

**Connect it in Claude Code / Claude CLI:**

```bash
claude mcp add omostrich -- node ~/Projects/omostrich/bin/mcp.mjs
```

No API key, no network endpoint, no daemon restart needed to connect
either — the MCP process is a separate stdio client of the same running
control socket, launched fresh by each agent's own MCP runtime.

### `omostrich-ctl` (fallback, or if you just want a CLI)

```bash
omostrich-ctl status
omostrich-ctl publish '{"content":"your note text"}'
```

Response is one line of JSON on stdout:

```json
{"ok":true,"data":{"event":{...},"publishedTo":["wss://..."],"failed":[]}}
```

or, if the vault is locked:

```json
{"ok":false,"error":"locked"}
```

or if the daemon isn't running at all:

```json
{"ok":false,"error":"daemon_not_running"}
```

**Rules every calling agent must follow — these are not enforced by the
daemon, they're the deal for using either path at all** (also in
`SKILL.md`):

- Only call `publish` when the user has explicitly asked *that agent,
  in that moment* to post *that* text. No auto-posting, no scheduled/cron posting,
  no posting as a side effect of some other task.
- If the response is locked, tell the user the vault is locked and to unlock
  it from the Omostrich bar icon. Do not attempt to unlock it yourself —
  no agent has (or should ever construct) the passphrase.
- Never print, log, or otherwise surface an nsec. No agent should ever
  hold one; both surfaces exist specifically so none of them ever need
  to.

## What this is not

- Not a Nostr client. No timeline, no feed, no reading UI, no DMs, no
  replies, no quotes, no zaps sent from here.
- Not a general-purpose key manager for other protocols — Nostr only.
- Not a multi-account tool — one vault, one identity, by design.

## Naming history

This project's product name is **Omostrich** (Omarchy + ostrich) as of
2026-09-03. Before that it was simply called "Nostr" — display strings
changed first (2026-09-02), then the full rename followed: plugin id
`tim.nostr-signer` -> `tim.omostrich`, repo directory
`~/Projects/omarchy-nostr-signer` -> `~/Projects/omostrich`, GitHub repo
`ninepointlabs/omarchy-nostr-signer` -> `ninepointlabs/omostrich` (renamed
via `gh repo rename`, git history preserved), CLI `omarchy-nostr-signer-ctl`
-> `omostrich-ctl`, systemd unit `omarchy-nostr-signer.service` ->
`omostrich.service`, data dir `~/.local/share/omarchy-nostr-signer` ->
`~/.local/share/omostrich`, state dir
`~/.local/state/omarchy/nostr-signer` -> `~/.local/state/omarchy/omostrich`.
The existing vault/config/profile-cache were migrated to the new data
dir, not recreated — same key, same identity, no re-onboarding needed.

Before that, this was two separate icons: `tim.nostr-signer` (lock/unlock,
approvals, relays) and `tim.nostr-compose` (a standalone composer that
called into the signer's control socket). Feedback after the composer's
first real use was that a second icon just for typing a note was one chip
too many for what it actually does, so compose lives at the top of this
same dropdown (and, separately, in the `SUPER + N` overlay).
`install-plugin.sh` cleans up both that old `tim.nostr-compose` icon and
the pre-rename `tim.nostr-signer` install dir if either is still present
from an earlier version.

As of 2026-09-02, `manifest.json` and the plugin QML moved from a
`plugin/` subdirectory to the repository root, and the daemon's source
moved from `src/` to `daemon/` — the Omarchy plugin marketplace requires
`manifest.json` at the repository root, which this repo's original
layout (daemon and plugin as sibling directories) didn't satisfy.

## Notes for future QML changes

Built against the same Omarchy shell plugin contract as
`omarchy-hermes-chat` — `PluginRegistry.qml` for the manifest schema, and
the `qs.Ui` base components (`Panel`, `KeyboardPanel`, `BarIconButton`,
`Button`, `TextField`, `PanelHero`, `PanelSectionHeader`,
`PanelSeparator`) those sibling plugins already use. Compose uses Qt
Quick Controls `TextArea` (qs.Ui has no multi-line field; same primitive
as hey-calendar's journal editor) with qs.Ui.TextField chrome. The
pending-count badge on the bar icon reuses the same small-badge-dot
pattern as `TailscaleIcon.qml`'s warning indicator
(`/usr/share/omarchy/shell/plugins/panels/tailscale/TailscaleIcon.qml`) —
`BorderSurface` circle anchored to a corner, deliberately not a novel
pattern. `omarchy plugin validate <folder>` (ships with Omarchy) checks
the manifest against the current schema if something breaks later.

## License

MIT — see [LICENSE](LICENSE).
