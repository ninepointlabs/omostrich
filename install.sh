#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p ~/.config/systemd/user
ln -sf "$DIR/omarchy-nostr-signer.service" ~/.config/systemd/user/omarchy-nostr-signer.service

systemctl --user daemon-reload
systemctl --user enable --now omarchy-nostr-signer.service

mkdir -p ~/.local/bin
chmod +x "$DIR/bin/ctl.mjs"
ln -sf "$DIR/bin/ctl.mjs" ~/.local/bin/omarchy-nostr-signer-ctl

echo "omarchy-nostr-signer.service installed and started."
echo "Logs: ~/.local/state/omarchy/nostr-signer/daemon.log"
echo "CLI: omarchy-nostr-signer-ctl (symlinked into ~/.local/bin, make sure that's on PATH)"
echo "Uninstall: systemctl --user disable --now omarchy-nostr-signer.service && rm ~/.config/systemd/user/omarchy-nostr-signer.service ~/.local/bin/omarchy-nostr-signer-ctl"
