#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p ~/.config/systemd/user
ln -sf "$DIR/omarchy-nostr-signer.service" ~/.config/systemd/user/omarchy-nostr-signer.service

systemctl --user daemon-reload
systemctl --user enable --now omarchy-nostr-signer.service

echo "omarchy-nostr-signer.service installed and started."
echo "Logs: ~/.local/state/omarchy/nostr-signer/daemon.log"
echo "Uninstall: systemctl --user disable --now omarchy-nostr-signer.service && rm ~/.config/systemd/user/omarchy-nostr-signer.service"
