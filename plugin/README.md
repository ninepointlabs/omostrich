# Nostr (Omarchy plugin)

A single bar icon for the Omarchy shell (Quickshell): compose and post a
kind-1 Nostr note, unlock/lock the local signer, review pending NIP-46
approvals, manage authorized apps, and edit your relay list — all in one
dropdown.

This is desktop plumbing, not a Nostr client. There is no timeline, no
replies, no zaps, no feed of any kind. Image attach is Blossom upload
only — the daemon PUTs the blob, the note gets a URL.

## Merge history

This used to be two separate icons: `tim.nostr-signer` (lock/unlock,
approvals, relays) and `tim.nostr-compose` (a standalone composer that
called into the signer's control socket). Feedback after the composer's
first real use was that a second icon just for typing a note was one chip
too many for what it actually does, so compose now lives at the top of this
same dropdown. The plugin id stays `tim.nostr-signer` — same bar slot, same
identity, no re-onboarding needed. `install.sh` here also retires the old
`tim.nostr-compose` icon if it's still present from before the merge.

## What it does

- **Bar icon** — a padlock mark; open/closed reflects locked state, dims
  when the signer daemon is unreachable, and shows a small red badge with a
  count when NIP-46 approval requests are pending.
- **Compose** (shown once unlocked, at the top of the dropdown) — a wrapping
  field that grows with the note. Enter (or the Post button) posts a kind-1
  text note; Shift+Enter inserts a newline. Calls the signer's `publish`
  command, which signs and broadcasts to every configured relay and reports
  back per-relay success/failure.
- **Lock / unlock / import** — the original signer setup and unlock flow,
  unchanged.
- **Pending requests** — approve once, always allow, or deny an incoming
  NIP-46 (remote signing) request.
- **Authorized apps** — see and revoke apps that were "always allow"'d.
- **Relays** — edit the comma-separated relay list.
- **Blossom** — one media server URL (same config.json as relays). Path
  field or paste-from-clipboard (wl-paste, same as the Omarchy clipboard
  plugin). Preview + URL; on post the daemon appends the URL to the kind-1
  (imeta tag if the blob hash is known). Empty blossom URL = no upload.

## Dependencies

- [`omarchy-nostr-signer`](https://github.com/ninepointlabs/omarchy-nostr-signer)
  (the daemon in the parent directory of this plugin) installed and running
  (`systemctl --user status omarchy-nostr-signer.service`). This plugin
  never holds an nsec or imports one — it only talks to that daemon's
  control socket.
- Node (resolved via `~/.local/share/mise/shims/node`) to run the signer's
  `bin/ctl.mjs` control-socket client.

No Nostr library, relay connection, or key material lives in this plugin —
`bin/ctl.mjs` and the socket are the only things it talks to.

## Install

```bash
./install.sh
```

This copies the plugin's files into
`~/.config/omarchy/plugins/nostr-signer`, retires the old separate
`tim.nostr-compose` icon if present, runs `omarchy bar put tim.nostr-signer`
(a no-op if it's already on the bar, which it will be for anyone upgrading
from the pre-merge version), then runs `omarchy restart shell`.

**Re-run `./install.sh` after every edit.** Files are copied, not
symlinked — there's no live-reload shortcut here, and neither the
plugins-dir file watcher nor `omarchy-shell shell rescanPlugins` reliably
picks up a changed QML file on this machine. Only a full
`omarchy restart shell` does, so that's what this script runs every time.
It only restarts the shell chrome (bar/panels); other running apps are
unaffected.

If you ever want to move it, remove it from the bar, or re-add it:

```bash
omarchy bar move tim.nostr-signer --section left   # move it
omarchy bar put tim.nostr-signer --before omarchy.tray
omarchy plugin disable tim.nostr-signer            # take it off the bar
omarchy plugin enable tim.nostr-signer             # put it back
```

## v1 scope

Deliberately narrow, per the build plan this came out of:

- Kind-1 text notes only. No replies, quotes, zaps, media, or feeds.
- No timeline or reading UI of any kind — compose-and-dismiss only.
- No mentions/DM/zap notifications (a separate later step).
- No key handling whatsoever; every signature and every publish happens on
  `omarchy-nostr-signer`'s side of the control socket.

## Uninstall

```bash
omarchy plugin disable tim.nostr-signer
rm -rf ~/.config/omarchy/plugins/nostr-signer
```

This does not touch the signer daemon or your vault — see the parent
`omarchy-nostr-signer` repo's own README to uninstall that separately.

## Notes for future changes

Built against the same Omarchy shell plugin contract as `omarchy-hermes-chat`
— `PluginRegistry.qml` for the manifest schema, and the `qs.Ui` base
components (`Panel`, `KeyboardPanel`, `BarIconButton`, `Button`, `TextField`,
`PanelHero`, `PanelSectionHeader`, `PanelSeparator`) those sibling plugins
already use. Compose uses Qt Quick Controls `TextArea` (qs.Ui has no
multi-line field; same primitive as hey-calendar's journal editor) with
qs.Ui.TextField chrome. The pending-count badge on the bar icon reuses the same
small-badge-dot pattern as `TailscaleIcon.qml`'s warning indicator
(`/usr/share/omarchy/shell/plugins/panels/tailscale/TailscaleIcon.qml`) —
`BorderSurface` circle anchored to a corner, deliberately not a novel
pattern. `omarchy plugin validate <folder>` (ships with Omarchy) checks the
manifest against the current schema if something breaks later.

## License

MIT — see [LICENSE](LICENSE).
