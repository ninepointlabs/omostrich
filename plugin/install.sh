#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.config/omarchy/plugins/nostr-signer"
OLD_COMPOSE_TARGET="$HOME/.config/omarchy/plugins/nostr-compose"

# No symlinks, real copies — matching how nostr-signer/hermes-chat have
# always been deployed. A symlinked directory doesn't get watched (inotify
# walks real directories, not into ~/Projects through a dir symlink);
# per-file symlinks didn't reliably work either. Copying means re-running
# this script is what deploys an edit — there is no live-symlink shortcut.
mkdir -p "$TARGET"
cp "$DIR"/*.qml "$DIR"/manifest.json "$TARGET/"

echo "Copied $DIR/*.{qml,json} -> $TARGET/"

omarchy plugin validate "$DIR"

# Same plugin id as before (tim.nostr-signer) — this replaces the file
# contents of an already-enabled widget, so no bar-layout change happens
# here. If tim.nostr-compose (the now-retired second icon) is still on the
# bar from before this merge, disable it so the widget list doesn't show a
# broken/duplicate entry — the compose UI it provided now lives inside this
# one icon's dropdown.
if omarchy plugin disable tim.nostr-compose 2>/dev/null; then
  echo "Removed the old separate Nostr Compose icon (its UI now lives inside this one)."
fi
if [ -d "$OLD_COMPOSE_TARGET" ]; then
  rm -rf "$OLD_COMPOSE_TARGET"
  echo "Removed the retired plugin files at $OLD_COMPOSE_TARGET."
fi

if omarchy bar put tim.nostr-signer; then
  echo "Nostr widget is on your bar (right section)."
else
  echo "Could not auto-add it to the bar; add it yourself with:"
  echo "  omarchy bar put tim.nostr-signer"
fi

# Confirmed by direct testing on this machine (see omarchy-hermes-chat): the
# plugins-dir inotify watcher and `shell rescanPlugins` do not reliably force
# Quickshell to recompile a changed QML file. A full shell restart is the
# only thing observed to actually pick up an edit. This restarts just the
# Omarchy shell chrome (bar/panels) — other running apps are unaffected.
omarchy restart shell
echo "Restarted the Omarchy shell so this change is actually live."
