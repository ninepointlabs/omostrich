#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/.config/omarchy/plugins/omostrich"
OLD_COMPOSE_TARGET="$HOME/.config/omarchy/plugins/nostr-compose"
OLD_SIGNER_TARGET="$HOME/.config/omarchy/plugins/nostr-signer"

# No symlinks, real copies — matching how nostr-signer/hermes-chat have
# always been deployed. A symlinked directory doesn't get watched (inotify
# walks real directories, not into ~/Projects through a dir symlink);
# per-file symlinks didn't reliably work either. Copying means re-running
# this script is what deploys an edit — there is no live-symlink shortcut.
#
# manifest.json, the QML, and ostrich.png live at the repo root (not a
# plugin/ subdirectory) so `omarchy plugin validate`/`omarchy plugin add`
# find manifest.json exactly where the Omarchy plugin marketplace requires
# it. The daemon's own source lives under daemon/ instead — this script
# only ever touches the plugin-facing files at the repo root, never
# daemon/.
#
# The *.qml glob below covers every QML file at the repo root, currently
# Panel.qml, ComposeOverlay.qml, AND LockIcon.qml — do not replace this
# with a hand-picked file list. Panel.qml's bar-icon iconComponent
# instantiates LockIcon directly; a deploy that omits LockIcon.qml (e.g.
# a manual `cp Panel.qml ComposeOverlay.qml ostrich.png manifest.json`)
# leaves Quickshell unable to draw the bar chip at all — a blank slot
# where the icon should be. This happened for real on this machine
# right after an earlier repo rename, from exactly that kind of hand-copy.
mkdir -p "$TARGET"
cp "$DIR"/*.qml "$DIR"/*.png "$DIR"/manifest.json "$TARGET/"

echo "Copied $DIR/*.{qml,png,json} -> $TARGET/"

omarchy plugin validate "$DIR"

# Plugin id is now tim.omostrich (renamed from tim.nostr-signer). If the
# old tim.nostr-compose icon (retired well before that rename) or the
# pre-rename tim.nostr-signer install dir are still present from an
# earlier version of this repo, clean them up so the plugin list doesn't
# show a stale/duplicate entry pointing at files that no longer exist.
if omarchy plugin disable tim.nostr-compose 2>/dev/null; then
  echo "Removed the old separate Nostr Compose icon (its UI now lives inside this one)."
fi
if [ -d "$OLD_COMPOSE_TARGET" ]; then
  rm -rf "$OLD_COMPOSE_TARGET"
  echo "Removed the retired plugin files at $OLD_COMPOSE_TARGET."
fi
if omarchy plugin disable tim.nostr-signer 2>/dev/null; then
  echo "Removed the pre-rename tim.nostr-signer icon (this plugin is now tim.omostrich)."
fi
if [ -d "$OLD_SIGNER_TARGET" ]; then
  rm -rf "$OLD_SIGNER_TARGET"
  echo "Removed the pre-rename plugin files at $OLD_SIGNER_TARGET."
fi

if omarchy bar put tim.omostrich; then
  echo "Omostrich widget is on your bar (right section)."
else
  echo "Could not auto-add it to the bar; add it yourself with:"
  echo "  omarchy bar put tim.omostrich"
fi

# Confirmed by direct testing on this machine (see omarchy-hermes-chat): the
# plugins-dir inotify watcher and `shell rescanPlugins` do not reliably force
# Quickshell to recompile a changed QML file. A full shell restart is the
# only thing observed to actually pick up an edit. This restarts just the
# Omarchy shell chrome (bar/panels); other running apps are unaffected.
omarchy restart shell
echo "Restarted the Omarchy shell so this change is actually live."
