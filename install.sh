#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p ~/.config/systemd/user
ln -sf "$DIR/omostrich.service" ~/.config/systemd/user/omostrich.service

systemctl --user daemon-reload
systemctl --user enable --now omostrich.service

mkdir -p ~/.local/bin
chmod +x "$DIR/bin/ctl.mjs"
ln -sf "$DIR/bin/ctl.mjs" ~/.local/bin/omostrich-ctl

echo "omostrich.service installed and started."
echo "Logs: ~/.local/state/omarchy/omostrich/daemon.log"
echo "CLI: omostrich-ctl (symlinked into ~/.local/bin, make sure that's on PATH)"
echo "Uninstall: systemctl --user disable --now omostrich.service && rm ~/.config/systemd/user/omostrich.service ~/.local/bin/omostrich-ctl"
