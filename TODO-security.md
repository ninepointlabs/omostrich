# Security TODO

From a security assessment on 2026-08-24, remediated 2026-09-02. Crypto
fundamentals (AES-256-GCM, scrypt N=2^17 with correct maxmem, random
per-vault salt/IV, 0600/0700 file perms, key zeroing on lock) were solid
from the start and remain untouched.

## 1. HIGH — `sign_internal` had no approval gate and no audit trail — CLOSED (partially)

`src/daemon.mjs` (`signInternal`, `publishNote`)

Fixed: every `sign_internal` call (and therefore every `publish`, which
calls it) now logs `kind`, event `id`, a truncated content hash, and
content length — never the nsec, never the passphrase, never full
content. `signInternal` no longer calls `touchActivity()` itself; only
`publishNote` does, explicitly, because that's the action that
represents real user intent. A same-UID process polling `sign_internal`
in a loop can no longer keep the vault open indefinitely as a side
effect of harvesting signatures — the auto-lock timer runs on schedule
regardless of how often that path is called.

**Decision that was needed, made:** silent/unapproved signing over the
control socket stays intentional (the README's own "first-party plugins
running as your own user" design, and the socket's whole trust
boundary), but it's no longer *invisible* — every call leaves a log line
— and it can no longer silently extend the unlock window.

**Known residual gap, found while fixing this, NOT closed:** NIP-46's
own `sign_event` handler
(`node_modules/@nostr-dev-kit/ndk/src/signers/nip46/backend/sign-event.ts`)
calls `event.sign(backend.signer)` directly — it does not go through
this daemon's `signInternal()` at all, so the new audit-log line does
**not** cover signatures produced via NIP-46 remote signing, only the
direct control-socket `sign_internal`/`publish` path. This was out of
scope for the task as given (scoped explicitly to "every sign_internal
and publish") and NDK's own architecture doesn't offer an obvious single
choke point to hook without wrapping `backend.signer` itself, which
wasn't attempted here. Worth a follow-up task if full audit coverage
across both paths matters.

## 2. HIGH — nsec and passphrase transited as a CLI argument — CLOSED

`bin/ctl.mjs`, `plugin/Panel.qml`, `plugin/ComposeOverlay.qml`

Fixed: `runAction()` in both QML files now writes the JSON payload to the
child process's stdin (`stdinEnabled: true` + `write()` on `onStarted`,
same pattern the stock Omarchy network plugin already uses for its own
802.1X password) instead of passing it as a `JSON.stringify(...)` argv
element. `ctl.mjs` reads one newline-terminated line from stdin (racing
a 150ms timeout, since Quickshell's `Process` type has no stdin-close/EOF
signal reachable from QML) and falls back to `argv[3]` only when nothing
arrives on stdin — kept for commands with no secret (status, lock, etc.)
and for anyone invoking this by hand at a terminal.

Verified live, not just by reading the code: spawned `ctl.mjs unlock`
with a fake passphrase over stdin and read `/proc/<pid>/cmdline` while
the child was alive — it showed only `node`, the script path, and
`unlock`; the passphrase never appeared. The daemon also genuinely
received and parsed the piped JSON (`{"ok":false,"error":"already
unlocked"}` came back, proving the payload round-tripped correctly
against the live, already-unlocked daemon).

## 3. MEDIUM — "Always allow" was unscoped and approvals were blind — CLOSED

`src/daemon.mjs` (`permitCallback`, `resolvePending`), `plugin/Panel.qml`

Fixed: `config.clients[pubkey]` now stores a `methods` array instead of
being a bare "trusted or not" flag. "Always allow" on a pending request
grants only that specific method for that pubkey, merging into (not
replacing) whatever was already granted — approving `sign_event` no
longer silently also grants `connect`/`get_public_key`/etc. forever. The
pending-request list now shows the event `kind` and a truncated (80
char) content preview whenever the method is `sign_event` (the only NIP-46
method NDK passes an actual `NDKEvent` as `params` for — every other
method's preview row simply doesn't render, there's nothing to show).
The "Always allow" button itself is labeled with the specific method
(e.g. "Always allow sign_event") so the scoping isn't a surprise buried
in code the user never reads.

No expiry on grants was added — out of scope for what was asked, and not
attempted.

## 4. MEDIUM — systemd unit had no hardening, no `LimitCORE=0` — CLOSED

`omostrich.service` (was `omarchy-nostr-signer.service` before the 2026-09-03 product rename)

Added `LimitCORE=0` (the one that matters most: this machine runs
`systemd-coredump`, and without it a crash while unlocked would write
the raw 32-byte key to a core file on disk, outside the vault's
encryption entirely), plus `NoNewPrivileges=true`, `PrivateTmp=true`,
`ProtectSystem=strict`, `ProtectHome=read-only`, and explicit
`ReadWritePaths=` for exactly the two directories the daemon actually
writes to (`~/.local/share/omostrich`,
`~/.local/state/omarchy/omostrich` — confirmed by reading
`paths.mjs`). `ProtectHome=read-only` (not `yes`/`tmpfs`) specifically
because `blossom.mjs`'s `loadBytes()` reads arbitrary Tim-chosen image
paths from anywhere under `$HOME` (e.g. `~/Pictures/foo.png`) for
upload — those still need to be *readable*, just not writable from
outside the two explicit paths above. `node`/`mise`'s own paths under
`%h/.local/share/mise/` are untouched (read-only home covers them fine,
nothing there needs write access). Verified with `systemd-analyze
verify` against the unit file directly — exit 0, no warnings.

**Requires a daemon restart to take effect** — a `systemctl daemon-reload`
plus `restart omostrich.service`, which re-locks the vault
(Tim unlocks again from the bar). Not done automatically by this fix;
Keeley applies it.

## 5. LOW — passphrase strength check was client-side only — CLOSED

`src/vault.mjs` (`create`)

Fixed: `vault.create()` itself now throws `"passphrase must be at least
8 characters"` if the passphrase is under 8 characters, regardless of
caller. Previously only `Panel.qml`'s `submitImport()` enforced this, so
anything that could reach the control socket directly bypassed it
entirely. The QML-side check stays too (fail fast, better error
placement in the UI) — this is defense in depth, not a replacement.

## 6. LOW/INFO — setup used `npm install`, not `npm ci` — CLOSED

`README.md`

Changed the documented setup step to `npm ci`.
