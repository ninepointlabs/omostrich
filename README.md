# omarchy-nostr-signer

Local Nostr key-custody daemon for the Omarchy desktop. Holds one nsec,
encrypted at rest, and signs on request:

- **Directly**, over a Unix control socket, for first-party Omarchy plugins
  running as your own user (the intended path for a future "post to Nostr"
  chat-entry plugin).
- **Remotely**, via [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
  (Nostr Connect / `bunker://`), so any NIP-46-aware client — a web app, a
  mobile client, Vega, etc. — can request signatures too, subject to
  approval.

The panel lives at `plugin/` in this repo (bar icon + dropdown, id
`tim.nostr-signer`), deployed to `~/.config/omarchy/plugins/nostr-signer/`
via `plugin/install.sh`. This directory (the parent of `plugin/`) is the
daemon that panel talks to.

## How it works

- `src/vault.mjs` — imports an nsec and encrypts it at rest
  (`~/.local/share/omarchy-nostr-signer/vault.json`) with AES-256-GCM under
  a key derived from your passphrase via scrypt (N=2^17). The raw key only
  ever exists in process memory, and only while unlocked.
- `src/daemon.mjs` — the long-running process. Exposes a control protocol
  over a Unix socket (`~/.local/state/omarchy/nostr-signer/control.sock`,
  mode 0600) and, once unlocked, an [NDK](https://github.com/nostr-dev-kit/ndk)
  `NDKNip46Backend` listening on your configured relays for kind-24133
  remote-signing requests.
- Auto-locks after 15 minutes of inactivity (`autoLockMinutes` in
  `~/.local/share/omarchy-nostr-signer/config.json`).
- The first time an unrecognized app's pubkey asks for a signature, the
  request sits pending until you approve or deny it from the panel (auto-
  denied after 2 minutes if you don't answer). "Always allow" remembers
  that app's pubkey for every future request; "Approve once" doesn't.
- `bin/ctl.mjs` (installed as `omarchy-nostr-signer-ctl`) is a thin CLI over
  the control socket — one JSON command in, one JSON response out (or a
  streaming `watch` for push events). The QML panel shells out to this the
  same way other Omarchy plugins shell out to their own helper scripts.

## Setup

```bash
npm install          # already done
./install.sh          # symlinks + enables the systemd --user service
```

Then open the "Nostr" bar icon (right section) and paste in an nsec plus a
passphrase. From then on the icon shows locked/unlocked state and a badge
for pending approvals; click it to compose and post a note, unlock, lock,
review pending requests, manage authorized apps, or edit the relay list
and Blossom server.

## Operating it

```bash
systemctl --user status omarchy-nostr-signer.service
tail -f ~/.local/state/omarchy/nostr-signer/daemon.log
omarchy-nostr-signer-ctl status
```

## Not done yet

- NIP-46 has been proven end-to-end with real NDK client code
  (`NDKNip46Signer.bunker()`) against this daemon's own backend, using
  disposable keys — connect, sign_event, and switch_relays all
  round-trip. Still not exercised against an actual third-party app
  (Amber, nsec.app, etc.) on a real phone — worth doing once, but the
  protocol-level blocker (see `applyToken` in `daemon.mjs`) is fixed
  and the bunker URL is in the panel to paste into one.
