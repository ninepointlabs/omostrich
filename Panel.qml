import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// One Nostr bar chip: composes and posts a kind-1 note, unlocks/locks the
// local signer, and reviews pending NIP-46 approvals / authorized apps /
// relays — all in a single dropdown instead of two separate icons.
//
// This plugin holds no key material itself. Every action shells out to the
// omostrich control-socket CLI (bin/ctl.mjs), which is the only
// process that ever touches the decrypted key. Merged 2026-09-01 from what
// were previously two plugins (tim.nostr-signer + tim.nostr-compose, the
// latter now retired) per feedback that a second icon just for composing
// was one chip too many for what this actually does. Renamed 2026-09-03
// to the product name Omostrich (id tim.omostrich, was tim.nostr-signer;
// repo moved ~/Projects/omarchy-nostr-signer -> ~/Projects/omostrich) —
// same signer daemon underneath, same control socket, same everything
// except the name.
Panel {
  id: root
  moduleName: "tim.omostrich"
  ipcTarget: "tim.omostrich"
  manageIpc: false

  // Bare "node" resolved via PATH, not a hardcoded install location.
  // Was previously hardcoded to a mise-managed shim path
  // (~/.local/share/mise/shims/node) — that's one specific Node
  // installer's layout, not something every Omarchy install has. On a
  // machine using the system package, nvm, fnm, or volta instead, that
  // path simply doesn't exist and the chip silently never lights up
  // with no clear reason why. This resolves correctly on any Omarchy
  // install, not just this machine's own setup: Omarchy's own default
  // Hyprland autostart (default/hypr/autostart.lua) runs `systemctl
  // --user import-environment $(env | cut -d'=' -f 1)` at every
  // session start, which imports the full session PATH — whatever the
  // user's Node installer put on it — into the systemd --user manager
  // Quickshell itself runs under. Confirmed live: this machine's
  // running daemon process (`cat /proc/<pid>/environ`) already carries
  // the mise shims dir in its PATH via exactly that mechanism. Every
  // other Omarchy-shipped plugin spawns bare command names the same
  // way rather than an absolute interpreter path, for the same reason.
  readonly property string nodeBin: "node"
  readonly property string ctlPath: Quickshell.env("HOME") + "/Projects/omostrich/bin/ctl.mjs"

  property bool locked: true
  property bool vaultExists: false
  property string npub: ""
  property var relays: []
  property var clients: ({})
  property var pendingList: []
  property bool daemonReachable: false
  property var profile: null
  property string bunkerUrl: ""

  property bool busy: false
  property string errorText: ""
  property string statusText: ""
  property string _actionOutput: ""

  property string setupNsec: ""
  property string setupPassphrase: ""
  property string setupPassphraseConfirm: ""
  property string unlockPassphrase: ""
  property string relaysText: ""
  property string blossomUrl: ""
  property string blossomText: ""
  property string attachPath: ""
  property var attachedBlob: null
  property string pastePath: Quickshell.env("HOME") + "/.local/state/omarchy/omostrich/clipboard.png"
  property bool settingsExpanded: false
  property bool autoLockUserPicked: false
  // What the picker currently shows. Seeded from the daemon's last-known
  // autoLockMinutes each time the dropdown opens (so it reflects Tim's
  // last actual choice, persisted daemon-side in config.json — see the
  // submitUnlock persistence note below), then left alone once he taps a
  // chip so a slow status refresh mid-choice can't silently revert it.
  property string selectedAutoLockMinutes: "15"
  function autoLockLabel(minutes) {
    for (var i = 0; i < root.autoLockOptions.length; i++)
      if (root.autoLockOptions[i].value === String(minutes)) return root.autoLockOptions[i].label
    return minutes + "m"
  }
  property bool notificationsEnabled: true
  property int autoLockMinutes: 15
  // 5 fixed choices per spec — not free-form, so users always land on one
  // of these regardless of whatever the daemon's config default was set
  // to before this slice existed. Value is the literal minutes count sent
  // straight to `set_autolock`; label is what the chip displays.
  readonly property var autoLockOptions: [
    { value: "5", label: "5m" },
    { value: "30", label: "30m" },
    { value: "60", label: "1h" },
    { value: "720", label: "12h" },
    { value: "1440", label: "24h" }
  ]
  property bool nip46ManualExpand: false
  readonly property bool nip46Expanded: root.nip46ManualExpand || root.pendingList.length > 0
  readonly property string nip46Summary: "Remote signing" + (root.pendingList.length > 0 ? " · " + root.pendingList.length + " pending" : "")

  // --- Compose state ---------------------------------------------------
  property string draft: ""
  // v1 is kind-1 text only — no replies, zaps, media, or feeds. This is a
  // soft guide matching common client conventions, not a protocol limit;
  // relays can and do accept longer notes, so this only warns, it never
  // blocks Post.
  readonly property int softLimit: 700
  readonly property string identityTitle: {
    var p = root.profile
    if (p && p.nip05) return p.nip05
    if (p && p.displayName) return p.displayName
    if (p && p.name) return p.name
    if (root.vaultExists && root.npub) return root.shortKey(root.npub)
    return "Omostrich"
  }
  readonly property string profilePicture: (root.profile && root.profile.picture) ? root.profile.picture : ""
  readonly property bool canPost: !root.locked && root.vaultExists && root.daemonReachable && !root.busy && (root.draft.trim().length > 0 || !!(root.attachedBlob && root.attachedBlob.url))

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color barIconColor: !daemonReachable ? urgent : (locked ? Qt.darker(barForeground, 1.5) : barForeground)

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function shortKey(s) {
    var v = String(s || "")
    return v.length > 20 ? v.slice(0, 12) + "…" + v.slice(-6) : v
  }

  readonly property string settingsSummary: "Settings"

  function applyStatus(data) {
    root.daemonReachable = true
    root.locked = !!data.locked
    root.vaultExists = !!data.vaultExists
    root.npub = data.npub || ""
    root.relays = data.relays || []
    if (!relaysField.activeFocus) root.relaysText = root.relays.join(", ")
    root.blossomUrl = data.blossomUrl || ""
    if (!blossomField.activeFocus) root.blossomText = root.blossomUrl
    root.clients = data.clients || {}
    root.pendingList = data.pending || []
    root.profile = data.profile || null
    root.bunkerUrl = data.bunkerUrl || ""
    if (typeof data.notificationsEnabled === "boolean") root.notificationsEnabled = data.notificationsEnabled
    if (Number(data.autoLockMinutes) > 0) {
      root.autoLockMinutes = Number(data.autoLockMinutes)
      if (!root.autoLockUserPicked) root.selectedAutoLockMinutes = String(root.autoLockMinutes)
    }
  }

  function refreshStatus() {
    runAction("status", undefined, function(res) {
      if (res.ok) root.applyStatus(res.data)
      else root.daemonReachable = false
    }, false)
  }

  function runAction(cmd, payload, onDone, markBusy) {
    if (markBusy !== false) root.busy = true
    root.errorText = ""
    root.statusText = ""
    // Audit item 1 (HIGH): payload goes over stdin now, never argv — a
    // literal JSON.stringify(payload) argv element used to put nsec/
    // passphrase in plain sight of /proc/<pid>/cmdline and `ps aux` for
    // any other process running as this user, for the life of the child.
    // Matches the stock network plugin's own enterpriseConnect Process
    // (Panel.qml in omarchy's network widget): stdinEnabled + write() on
    // onStarted, same "password never touches argv" reasoning. ctl.mjs
    // reads one line from stdin (or races a short timeout if nothing
    // arrives) since Quickshell's Process has no stdin-close/EOF API to
    // signal "that's everything" from QML.
    actionProcess.pendingPayload = payload !== undefined ? JSON.stringify(payload) + "\n" : ""
    actionProcess.onDoneCallback = onDone
    actionProcess.command = [root.nodeBin, root.ctlPath, cmd]
    actionProcess.running = true
  }

  function submitImport() {
    if (root.setupPassphrase.length < 8) { root.errorText = "Passphrase must be at least 8 characters."; return }
    if (root.setupPassphrase !== root.setupPassphraseConfirm) { root.errorText = "Passphrases don't match."; return }
    var wasReplace = root.vaultExists
    runAction("import", { nsec: root.setupNsec, passphrase: root.setupPassphrase, replace: wasReplace }, function(res) {
      if (res.ok) {
        root.setupNsec = ""
        root.setupPassphrase = ""
        root.setupPassphraseConfirm = ""
        root.refreshStatus()
      } else {
        root.errorText = res.error
      }
    })
  }

  function submitUnlock() {
    // set_autolock first, then unlock — two calls to the existing daemon
    // commands, no daemon.mjs change needed (per the explicit "if you
    // must change daemon.mjs, stop" instruction: this doesn't). Ordered
    // this way on purpose: unlockWith() already calls touchActivity()
    // internally to start the very first auto-lock countdown, so the
    // duration needs to be saved to config *before* that happens or the
    // first countdown after this unlock would run on the old value.
    var minutes = Number(root.selectedAutoLockMinutes) || 15
    runAction("set_autolock", { minutes: minutes }, function(setRes) {
      if (!setRes.ok) {
        root.errorText = setRes.error
        return
      }
      root.autoLockMinutes = minutes
      runAction("unlock", { passphrase: root.unlockPassphrase }, function(res) {
        root.unlockPassphrase = ""
        if (res.ok) root.refreshStatus()
        else root.errorText = res.error
      }, false)
    })
  }

  function setAutoLock(minutesStr) {
    root.autoLockUserPicked = true
    root.selectedAutoLockMinutes = minutesStr
    // Only push to the daemon immediately if already unlocked — while
    // locked there's nothing running to reset yet; submitUnlock() sends
    // this exact value at unlock time instead.
    if (!root.locked) {
      var minutes = Number(minutesStr) || 15
      runAction("set_autolock", { minutes: minutes }, function(res) {
        if (res.ok) {
          root.autoLockMinutes = minutes
          root.statusText = "Auto-lock set to " + root.autoLockLabel(minutes) + "."
        } else {
          root.errorText = res.error
        }
      }, false)
    }
  }

  function lockNow() {
    runAction("lock", undefined, function(res) { root.refreshStatus() })
  }

  function saveRelays() {
    var list = root.relaysText.split(",").map(function(s) { return s.trim() }).filter(function(s) { return s.length > 0 })
    if (list.length === 0) { root.errorText = "At least one relay is required."; return }
    runAction("set_relays", { relays: list }, function(res) {
      if (res.ok) root.refreshStatus()
      else root.errorText = res.error
    })
  }

  function saveBlossom() {
    runAction("set_blossom", { url: root.blossomText }, function(res) {
      if (res.ok) {
        root.blossomUrl = (res.data && res.data.blossomUrl) || ""
        root.blossomText = root.blossomUrl
        root.statusText = root.blossomUrl ? "Blossom server saved." : "Blossom server cleared."
      } else {
        root.errorText = res.error
      }
    })
  }

  function setNotifications(enabled) {
    runAction("set_notifications", { enabled: !!enabled }, function(res) {
      if (res.ok) {
        root.notificationsEnabled = !!(res.data && res.data.notificationsEnabled)
        root.statusText = root.notificationsEnabled ? "Desktop alerts on." : "Desktop alerts off."
      } else {
        root.errorText = res.error
      }
    }, false)
  }

  function clearAttach() {
    root.attachedBlob = null
  }

  function uploadFromPath(filePath) {
    var p = String(filePath || "").trim()
    if (!p) { root.errorText = "Pick a file path first."; return }
    if (!root.blossomUrl) { root.errorText = "Set a Blossom server under settings below first."; return }
    runAction("blossom_upload", { path: p }, function(res) {
      if (res.ok && res.data && res.data.url) {
        root.attachedBlob = res.data
        root.statusText = "Uploaded. URL will be added to the note when you post."
      } else {
        root.errorText = describeBlossomError(res.error)
      }
    })
  }

  function pasteClipboardImage() {
    if (!root.blossomUrl) { root.errorText = "Set a Blossom server under settings below first."; return }
    pasteProcess.running = false
    pasteProcess.running = true
  }

  function pickImageFile() {
    if (!root.blossomUrl) { root.errorText = "Set a Blossom server under settings below first."; return }
    pickProcess.running = false
    pickProcess.running = true
  }

  function approve(id, remember) {
    runAction("approve", { id: id, remember: remember, label: "Approved app" }, function(res) { root.refreshStatus() })
  }

  function deny(id) {
    runAction("deny", { id: id }, function(res) { root.refreshStatus() })
  }

  function revokeClient(pubkey) {
    runAction("revoke_client", { pubkey: pubkey }, function(res) { root.refreshStatus() })
  }

  function copyBunkerUrl() {
    if (!root.bunkerUrl) return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(root.bunkerUrl) + " | wl-copy"])
    root.statusText = "Bunker URL copied."
  }

  // --- Compose actions ---------------------------------------------------
  function post() {
    var text = root.draft.trim()
    if (root.busy) return
    if (!text && !(root.attachedBlob && root.attachedBlob.url)) return
    root.errorText = ""
    root.statusText = ""
    var payload = { content: text }
    if (root.attachedBlob && root.attachedBlob.url) payload.blossom = root.attachedBlob
    runAction("publish", payload, function(res) {
      if (res.ok) {
        var okList = Array.isArray(res.data && res.data.publishedTo) ? res.data.publishedTo : []
        var failList = Array.isArray(res.data && res.data.failed) ? res.data.failed : []
        var okCount = okList.length
        var total = okCount + failList.length
        if (failList.length === 0) {
          root.draft = ""
          root.attachedBlob = null
          root.statusText = "Posted to " + okCount + " relay" + (okCount === 1 ? "" : "s") + "."
        } else if (okCount === 0) {
          // Nothing succeeded — keep the draft so the user doesn't have to
          // retype it before trying again.
          root.errorText = "Posted to 0 of " + total + " relays. Check the signer log."
        } else {
          root.draft = ""
          root.attachedBlob = null
          root.statusText = "Posted to " + okCount + " of " + total + " relays (" + failList.map(function(f) { return f.url }).join(", ") + " failed)."
        }
      } else {
        root.errorText = describePublishError(res.error)
      }
    })
  }

  function describeBlossomError(err) {
    var s = String(err || "")
    if (s === "locked") return "Signer is locked. Unlock it below first."
    if (s === "no blossom server configured") return "Set a Blossom server under settings below first."
    if (s.indexOf("file not readable") !== -1) return "Couldn't read that file."
    if (s === "daemon_not_running") return "Signer daemon isn't running."
    return s || "Upload failed."
  }

  function describePublishError(err) {
    var s = String(err || "")
    if (s === "locked") return "Signer is locked. Unlock it below first."
    if (s === "no vault; import a key first") return "No key configured. Set one up below first."
    if (s === "not connected to relays") return "Not connected to any relay yet. Try again in a moment."
    if (s === "content required") return "Nothing to post."
    if (s === "daemon_not_running") return "Signer daemon isn't running."
    return s || "Something went wrong."
  }

  onOpenedChanged: {
    if (opened) {
      root.errorText = ""
      root.statusText = ""
      // Force closed on every open, not just on close. The bar widget
      // can stay mapped (visible: false) between opens rather than
      // being destroyed/recreated, so a property that only reset on the
      // close path could survive across a whole open/close/open cycle
      // if that cycle ever skipped emitting the false edge for any
      // reason (e.g. the panel being toggled by the shell rather than
      // this dropdown's own close). Setting it unconditionally here
      // means every single open starts collapsed, full stop, regardless
      // of how it got there or what state it was left in before.
      root.settingsExpanded = false
      root.nip46ManualExpand = false
      root.autoLockUserPicked = false
      root.refreshStatus()
    } else {
      root.settingsExpanded = false
      root.nip46ManualExpand = false
      root.autoLockUserPicked = false
    }
  }

  Component.onCompleted: { root.refreshStatus(); watchProcess.running = true }

  Process {
    id: actionProcess
    property var onDoneCallback: null
    property string pendingPayload: ""
    running: false
    command: []
    stdinEnabled: true
    onStarted: {
      if (pendingPayload) write(pendingPayload)
      pendingPayload = ""
    }
    stdout: StdioCollector {
      id: actionStdout
      waitForEnd: true
      onStreamFinished: root._actionOutput = text
    }
    onExited: function(exitCode) {
      root.busy = false
      var response = null
      try { response = JSON.parse(String(root._actionOutput || "")) } catch (e) { response = null }
      if (!response) response = { ok: false, error: "signer daemon unreachable" }
      var cb = actionProcess.onDoneCallback
      actionProcess.onDoneCallback = null
      if (cb) cb(response)
    }
  }

  // Kit has no FileDialog and no image clipboard API. Clipboard.qml already
  // shells out to wl-paste for image/png; same here, write a temp file, then
  // blossom_upload by path so the plugin never sees the nsec.
  Process {
    id: pasteProcess
    running: false
    command: ["bash", "-c", "mkdir -p \"$(dirname \"$1\")\" && (wl-paste --type image/png > \"$1\" || wl-paste --type image/jpeg > \"$1\") && test -s \"$1\"", "_", root.pastePath]
    onExited: function(exitCode) {
      if (exitCode === 0) root.uploadFromPath(root.pastePath)
      else root.errorText = "No image on the clipboard (wl-paste found nothing)."
    }
  }

  // qs.Ui has no FileDialog. QtQuick.Dialogs / Qt.labs.platform FileDialog
  // from a Quickshell layer-shell panel is flaky on Hyprland. zenity is
  // installed on this box and talks to xdg-desktop-portal as its own
  // window — same "shell out" pattern as wl-paste above.
  Process {
    id: pickProcess
    running: false
    command: [
      "/usr/bin/zenity",
      "--file-selection",
      "--title=Attach image",
      "--filename=" + (Quickshell.env("HOME") + "/Pictures/"),
      "--file-filter=Images | *.png *.jpg *.jpeg *.webp *.gif"
    ]
    stdout: StdioCollector {
      id: pickStdout
      waitForEnd: true
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) return
      var p = String(pickStdout.text || "").trim()
      if (!p) { root.errorText = "No file selected."; return }
      root.attachPath = p
      root.uploadFromPath(p)
    }
  }

  Timer {
    interval: Math.max(2, root.setting("pollIntervalSec", 5)) * 1000
    running: true
    repeat: true
    onTriggered: if (!root.opened) root.refreshStatus()
  }

  // Streams status_changed / pending_added / pending_resolved pushes from
  // the daemon so the badge and open panel react immediately instead of
  // waiting for the next poll. Restarts on exit like the clipboard watchers.
  Process {
    id: watchProcess
    running: false
    command: [root.nodeBin, root.ctlPath, "watch"]
    stdout: SplitParser {
      onRead: function(data) {
        var msg = null
        try { msg = JSON.parse(data) } catch (e) { return }
        if (!msg) return
        if (msg.event === "status_changed" && msg.data) root.applyStatus(msg.data)
        else if (msg.event === "pending_added" || msg.event === "pending_resolved") root.refreshStatus()
      }
    }
    onExited: watchRestartTimer.restart()
  }

  Timer {
    id: watchRestartTimer
    interval: 2000
    repeat: false
    onTriggered: if (!watchProcess.running) watchProcess.running = true
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        LockIcon {
          anchors.centerIn: parent
          iconSize: Style.space(11)
          color: root.barIconColor
          badgeColor: root.urgent
          locked: root.locked
          pendingCount: root.pendingList.length
        }
      }
    }
    onPressed: function(buttonCode) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    // Land keyboard focus in the composer when there's something to type
    // into; fall back to the unlock/setup field, then the esc-catcher when
    // neither applies (e.g. daemon unreachable).
    focusTarget: (!root.locked && root.vaultExists && root.daemonReachable) ? draftField
      : (root.vaultExists && root.daemonReachable) ? unlockField
      : escCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(620))

    Item {
      id: escCatcher
      anchors.fill: parent
      focus: true
      Keys.onEscapePressed: root.close()

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: root.identityTitle
            meta: !root.daemonReachable ? "Signer daemon unreachable"
              : !root.vaultExists ? "No key configured"
              : root.locked ? "Locked"
              : root.busy ? "Working…"
              : "Unlocked"
            foreground: root.foreground
            fontFamily: root.fontFamily
            trailingControl: root.vaultExists && !root.locked ? lockNowButton : null
            iconComponent: root.profilePicture !== "" ? avatarComp : null
          }

          Component {
            id: avatarComp
            Rectangle {
              width: Style.space(28)
              height: Style.space(28)
              radius: width / 2
              clip: true
              color: Qt.darker(root.foreground, 2.4)
              Image {
                anchors.fill: parent
                source: root.profilePicture
                fillMode: Image.PreserveAspectCrop
                asynchronous: true
              }
            }
          }

          Component {
            id: lockNowButton
            Button {
              text: "Lock now"
              foreground: root.foreground
              bordered: true
              onClicked: root.lockNow()
            }
          }

          Text {
            visible: root.errorText !== ""
            width: parent.width
            text: root.errorText
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.errorText === "" && root.statusText !== ""
            width: parent.width
            text: root.statusText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // --- Compose, front and center when unlocked ---------------------
          Column {
            visible: root.daemonReachable && root.vaultExists && !root.locked
            width: parent.width
            spacing: Style.space(8)

            // qs.Ui has no TextArea — only single-line TextField. Qt Quick
            // Controls TextArea is the same primitive hey-calendar already
            // uses for journal edit; chrome copied from qs.Ui.TextField
            // (BorderSurface + controlSpec) so it doesn't look like a
            // foreign widget. Grows with wrapped content up to
            // composeMaxHeight, then the TextArea scrolls internally.
            // Enter posts; Shift+Enter inserts a newline.
            TextArea {
              id: draftField
              width: parent.width
              wrapMode: TextArea.Wrap
              placeholderText: "What's happening?"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
              selectedTextColor: root.foreground
              placeholderTextColor: Qt.darker(root.foreground, 1.6)
              selectByMouse: true
              enabled: !root.busy
              text: root.draft
              onTextChanged: root.draft = text

              readonly property real composeMinHeight: Style.space(48)
              readonly property real composeMaxHeight: Style.space(180)
              readonly property bool _focused: activeFocus
              readonly property bool _hot: hovered
              readonly property var _borderSpec: Border.controlSpec(_focused ? "focus" : (_hot ? "hover-cursor" : "normal"), root.foreground, Color.accent)

              leftPadding: Style.spacing.controlPaddingX + Border.left(_borderSpec)
              rightPadding: Style.spacing.controlPaddingX + Border.right(_borderSpec)
              topPadding: Style.spacing.inputPaddingY + Border.top(_borderSpec)
              bottomPadding: Style.spacing.inputPaddingY + Border.bottom(_borderSpec)

              height: {
                var wanted = contentHeight + topPadding + bottomPadding
                return Math.min(composeMaxHeight, Math.max(composeMinHeight, wanted))
              }

              background: BorderSurface {
                color: Style.controlFill(draftField._focused, draftField._hot, root.foreground, Color.accent)
                borderSpec: draftField._borderSpec
                radius: Style.cornerRadius
              }

              Keys.onPressed: (event) => {
                if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter)
                  return
                if (event.modifiers & Qt.ShiftModifier) {
                  event.accepted = false
                  return
                }
                event.accepted = true
                root.post()
              }
            }

            Row {
              width: parent.width
              Text {
                text: root.draft.length + (root.draft.length > root.softLimit ? " (long note)" : "")
                color: root.draft.length > root.softLimit ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            Text {
              visible: !root.blossomUrl
              width: parent.width
              wrapMode: Text.WordWrap
              text: "Set a Blossom server under settings below to attach images."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Column {
              visible: !!root.blossomUrl
              width: parent.width
              spacing: Style.space(6)

              TextField {
                width: parent.width
                placeholderText: "Or paste a path"
                foreground: root.foreground
                enabled: !root.busy
                text: root.attachPath
                onTextChanged: root.attachPath = text
                Keys.onReturnPressed: root.uploadFromPath(root.attachPath)
              }

              Row {
                spacing: Style.space(6)
                Button {
                  text: "Choose image"
                  foreground: root.foreground
                  bordered: true
                  enabled: !root.busy
                  onClicked: root.pickImageFile()
                }
                Button {
                  text: "Paste image"
                  foreground: root.foreground
                  bordered: true
                  enabled: !root.busy
                  onClicked: root.pasteClipboardImage()
                }
                Button {
                  visible: root.attachPath.trim().length > 0 && !(root.attachedBlob && root.attachedBlob.url)
                  text: "Upload path"
                  foreground: root.foreground
                  bordered: true
                  enabled: !root.busy
                  onClicked: root.uploadFromPath(root.attachPath)
                }
                Button {
                  visible: !!(root.attachedBlob && root.attachedBlob.url)
                  text: "Remove"
                  foreground: root.urgent
                  bordered: true
                  onClicked: root.clearAttach()
                }
              }

              Row {
                visible: !!(root.attachedBlob && root.attachedBlob.url)
                width: parent.width
                spacing: Style.space(8)

                Image {
                  width: Style.space(48)
                  height: Style.space(48)
                  fillMode: Image.PreserveAspectFit
                  source: (root.attachedBlob && root.attachedBlob.url) ? root.attachedBlob.url : ""
                  asynchronous: true
                }

                Text {
                  width: parent.width - Style.space(56)
                  wrapMode: Text.WrapAnywhere
                  text: (root.attachedBlob && root.attachedBlob.url) ? root.attachedBlob.url : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }

            Button {
              text: root.busy ? "Posting…" : "Post"
              foreground: root.foreground
              bordered: true
              enabled: root.canPost
              onClicked: root.post()
            }

            PanelSeparator { foreground: root.foreground }
          }

          // --- Setup / replace key -------------------------------------
          Column {
            visible: !root.vaultExists
            width: parent.width
            spacing: Style.space(8)

            Text {
              width: parent.width
              text: "Import an existing nsec. It's encrypted at rest with the passphrase below and only ever decrypted in memory while unlocked."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            TextField {
              width: parent.width
              password: true
              placeholderText: "nsec1…"
              foreground: root.foreground
              text: root.setupNsec
              onTextChanged: root.setupNsec = text
            }

            TextField {
              width: parent.width
              password: true
              placeholderText: "Passphrase"
              foreground: root.foreground
              text: root.setupPassphrase
              onTextChanged: root.setupPassphrase = text
            }

            TextField {
              width: parent.width
              password: true
              placeholderText: "Confirm passphrase"
              foreground: root.foreground
              text: root.setupPassphraseConfirm
              onTextChanged: root.setupPassphraseConfirm = text
              Keys.onReturnPressed: root.submitImport()
            }

            Button {
              text: root.busy ? "Importing…" : "Import key"
              foreground: root.foreground
              bordered: true
              enabled: !root.busy && root.setupNsec.length > 0
              onClicked: root.submitImport()
            }
          }

          // --- Unlock -----------------------------------------------------
          Column {
            visible: root.vaultExists && root.locked
            width: parent.width
            spacing: Style.space(8)

            TextField {
              id: unlockField
              width: parent.width
              password: true
              placeholderText: "Passphrase"
              foreground: root.foreground
              text: root.unlockPassphrase
              onTextChanged: root.unlockPassphrase = text
              Keys.onReturnPressed: root.submitUnlock()
            }

            Text {
              text: "Stay unlocked for"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            ButtonGroup {
              width: parent.width
              options: root.autoLockOptions
              value: root.selectedAutoLockMinutes
              foreground: root.foreground
              accent: root.foreground
              fontFamily: root.fontFamily
              onChanged: function(v) { root.setAutoLock(v) }
            }

            Button {
              text: root.busy ? "Unlocking…" : "Unlock"
              foreground: root.foreground
              bordered: true
              enabled: !root.busy && root.unlockPassphrase.length > 0
              onClicked: root.submitUnlock()
            }
          }

          // --- Unlocked: NIP-46 bunker connection --------------------------
          Column {
            visible: root.vaultExists && !root.locked && root.bunkerUrl !== ""
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { foreground: root.foreground }

            MouseArea {
              width: parent.width
              height: nip46SummaryText.height
              cursorShape: Qt.PointingHandCursor
              onClicked: root.nip46ManualExpand = !root.nip46ManualExpand

              Text {
                id: nip46SummaryText
                width: parent.width
                text: root.nip46Summary
                color: root.pendingList.length > 0 ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: root.pendingList.length > 0
                elide: Text.ElideRight
              }
            }

            Column {
              visible: root.nip46Expanded
              width: parent.width
              spacing: Style.space(6)

              PanelSectionHeader { text: "REMOTE SIGNING (NIP-46)"; foreground: root.foreground; fontFamily: root.fontFamily }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                text: "Paste this into a NIP-46 client (Amber, nsec.app, etc.) to request signatures from this signer. Every request still needs your approve/deny below."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Row {
                width: parent.width
                spacing: Style.space(6)

                Text {
                  width: parent.width - copyBunkerButton.width - parent.spacing
                  text: root.bunkerUrl
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  elide: Text.ElideMiddle
                }

                Button {
                  id: copyBunkerButton
                  text: "Copy"
                  foreground: root.foreground
                  bordered: true
                  onClicked: root.copyBunkerUrl()
                }
              }

              // --- Pending requests --------------------------------------
              Column {
                visible: root.pendingList.length > 0
                width: parent.width
                spacing: Style.space(8)

                PanelSectionHeader { text: "PENDING REQUESTS"; foreground: root.foreground; fontFamily: root.fontFamily }

                Repeater {
                  model: root.pendingList
                  delegate: Column {
                    required property var modelData
                    width: column.width
                    spacing: Style.space(4)

                    Text {
                      width: parent.width
                      text: root.shortKey(modelData.pubkey) + " — " + modelData.method
                        + (modelData.kind !== null && modelData.kind !== undefined ? " (kind " + modelData.kind + ")" : "")
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                    }

                    // Audit item 3 (MEDIUM): only ever populated for
                    // sign_event (the one method that produces a public,
                    // permanent artifact) — see permitCallback's own
                    // comment in daemon.mjs. Approving anything else
                    // (connect/get_public_key/ping/switch_relays) never
                    // had content to preview in the first place, so this
                    // row simply doesn't render for those.
                    Text {
                      visible: modelData.contentPreview !== undefined && modelData.contentPreview !== ""
                      width: parent.width
                      wrapMode: Text.WordWrap
                      text: "“" + modelData.contentPreview + "”"
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.italic: true
                    }

                    Row {
                      spacing: Style.space(6)
                      Button { text: "Approve once"; foreground: root.foreground; bordered: true; onClicked: root.approve(modelData.id, false) }
                      // Audit item 3 (MEDIUM): scoped to this one method
                      // now, not every method forever — label says so
                      // plainly rather than leaving that a surprise
                      // buried in daemon.mjs. See resolvePending() there.
                      Button { text: "Always allow " + modelData.method; foreground: root.foreground; bordered: true; onClicked: root.approve(modelData.id, true) }
                      Button { text: "Deny"; foreground: root.urgent; bordered: true; onClicked: root.deny(modelData.id) }
                    }
                  }
                }
              }

              // --- Authorized apps ----------------------------------------
              Column {
                visible: Object.keys(root.clients).length > 0
                width: parent.width
                spacing: Style.space(8)

                PanelSectionHeader { text: "AUTHORIZED APPS"; foreground: root.foreground; fontFamily: root.fontFamily }

                Repeater {
                  model: Object.keys(root.clients)
                  delegate: Row {
                    required property string modelData
                    width: column.width
                    spacing: Style.space(8)

                    Text {
                      width: parent.width - revokeButton.width - Style.space(8)
                      text: (root.clients[modelData].label || "Unnamed app") + " — " + root.shortKey(modelData)
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                    }

                    Button {
                      id: revokeButton
                      text: "Revoke"
                      foreground: root.urgent
                      bordered: true
                      onClicked: root.revokeClient(modelData)
                    }
                  }
                }
              }
            }
          }

          // --- Unlocked: relays / blossom, collapsed while composing ------
          Column {
            visible: root.vaultExists && !root.locked
            width: parent.width
            spacing: Style.space(8)

            PanelSeparator { foreground: root.foreground }

            MouseArea {
              width: parent.width
              // Real click target, not just the text glyph height — a
              // single line of bodySmall text is a very thin hit box to
              // land a click on reliably. Padding top+bottom gives a
              // proper touch/click target the full width of the row,
              // matching the row-height convention other clickable
              // summary rows in this file use (Style.spacing tokens,
              // not a bespoke pixel guess).
              height: settingsSummaryText.height + Style.spacing.controlPaddingY * 2
              cursorShape: Qt.PointingHandCursor
              onClicked: root.settingsExpanded = !root.settingsExpanded

              Text {
                id: settingsSummaryText
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                text: root.settingsSummary
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }
            }

            Column {
              visible: root.settingsExpanded
              width: parent.width
              spacing: Style.space(8)

              PanelSectionHeader { text: "RELAYS"; foreground: root.foreground; fontFamily: root.fontFamily }

              TextField {
                id: relaysField
                width: parent.width
                foreground: root.foreground
                text: root.relaysText
                onTextChanged: root.relaysText = text
              }

              Button {
                text: "Save relays"
                foreground: root.foreground
                bordered: true
                onClicked: root.saveRelays()
              }

              PanelSectionHeader { text: "BLOSSOM"; foreground: root.foreground; fontFamily: root.fontFamily }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                text: "One media server for v1. Leave blank to disable uploads."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              TextField {
                id: blossomField
                width: parent.width
                placeholderText: "https://blossom.example"
                foreground: root.foreground
                text: root.blossomText
                onTextChanged: root.blossomText = text
                Keys.onReturnPressed: root.saveBlossom()
              }

              Button {
                text: "Save blossom server"
                foreground: root.foreground
                bordered: true
                onClicked: root.saveBlossom()
              }

              PanelSectionHeader { text: "ALERTS"; foreground: root.foreground; fontFamily: root.fontFamily }

              Toggle {
                width: parent.width
                label: "Desktop notifications"
                description: "Mentions, DMs, and zaps. Off silences toasts."
                checked: root.notificationsEnabled
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.setNotifications(!root.notificationsEnabled)
              }

              PanelSectionHeader { text: "AUTO-LOCK"; foreground: root.foreground; fontFamily: root.fontFamily }

              Text {
                width: parent.width
                text: "Currently locks after " + root.autoLockLabel(root.autoLockMinutes) + " idle."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              ButtonGroup {
                width: parent.width
                options: root.autoLockOptions
                value: root.selectedAutoLockMinutes
                foreground: root.foreground
                accent: root.foreground
                fontFamily: root.fontFamily
                onChanged: function(v) { root.setAutoLock(v) }
              }
            }
          }
        }
      }
    }
  }
}
