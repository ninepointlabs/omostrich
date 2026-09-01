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
// omarchy-nostr-signer control-socket CLI (bin/ctl.mjs), which is the only
// process that ever touches the decrypted key. Merged 2026-09-01 from what
// were previously two plugins (tim.nostr-signer + tim.nostr-compose, the
// latter now retired) per feedback that a second icon just for composing
// was one chip too many for what this actually does.
Panel {
  id: root
  moduleName: "tim.nostr-signer"
  ipcTarget: "tim.nostr-signer"
  manageIpc: false

  readonly property string nodeBin: Quickshell.env("HOME") + "/.local/share/mise/shims/node"
  readonly property string ctlPath: Quickshell.env("HOME") + "/Projects/omarchy-nostr-signer/bin/ctl.mjs"

  property bool locked: true
  property bool vaultExists: false
  property string npub: ""
  property var relays: []
  property var clients: ({})
  property var pendingList: []
  property bool daemonReachable: false

  property bool busy: false
  property string errorText: ""
  property string statusText: ""
  property string _actionOutput: ""

  property string setupNsec: ""
  property string setupPassphrase: ""
  property string setupPassphraseConfirm: ""
  property string unlockPassphrase: ""
  property string relaysText: ""

  // --- Compose state ---------------------------------------------------
  property string draft: ""
  // v1 is kind-1 text only — no replies, zaps, media, or feeds. This is a
  // soft guide matching common client conventions, not a protocol limit;
  // relays can and do accept longer notes, so this only warns, it never
  // blocks Post.
  readonly property int softLimit: 700
  readonly property bool canPost: !root.locked && root.vaultExists && root.daemonReachable && !root.busy && root.draft.trim().length > 0

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

  function applyStatus(data) {
    root.daemonReachable = true
    root.locked = !!data.locked
    root.vaultExists = !!data.vaultExists
    root.npub = data.npub || ""
    root.relays = data.relays || []
    if (!relaysField.activeFocus) root.relaysText = root.relays.join(", ")
    root.clients = data.clients || {}
    root.pendingList = data.pending || []
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
    var args = [root.nodeBin, root.ctlPath, cmd]
    if (payload !== undefined) args.push(JSON.stringify(payload))
    actionProcess.onDoneCallback = onDone
    actionProcess.command = args
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
    runAction("unlock", { passphrase: root.unlockPassphrase }, function(res) {
      root.unlockPassphrase = ""
      if (res.ok) root.refreshStatus()
      else root.errorText = res.error
    })
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

  function approve(id, remember) {
    runAction("approve", { id: id, remember: remember, label: "Approved app" }, function(res) { root.refreshStatus() })
  }

  function deny(id) {
    runAction("deny", { id: id }, function(res) { root.refreshStatus() })
  }

  function revokeClient(pubkey) {
    runAction("revoke_client", { pubkey: pubkey }, function(res) { root.refreshStatus() })
  }

  // --- Compose actions ---------------------------------------------------
  function post() {
    var text = root.draft.trim()
    if (!text || root.busy) return
    root.errorText = ""
    root.statusText = ""
    runAction("publish", { content: text }, function(res) {
      if (res.ok) {
        var okList = Array.isArray(res.data && res.data.publishedTo) ? res.data.publishedTo : []
        var failList = Array.isArray(res.data && res.data.failed) ? res.data.failed : []
        var okCount = okList.length
        var total = okCount + failList.length
        if (failList.length === 0) {
          root.draft = ""
          root.statusText = "Posted to " + okCount + " relay" + (okCount === 1 ? "" : "s") + "."
        } else if (okCount === 0) {
          // Nothing succeeded — keep the draft so the user doesn't have to
          // retype it before trying again.
          root.errorText = "Posted to 0 of " + total + " relays. Check the signer log."
        } else {
          root.draft = ""
          root.statusText = "Posted to " + okCount + " of " + total + " relays (" + failList.map(function(f) { return f.url }).join(", ") + " failed)."
        }
      } else {
        root.errorText = describePublishError(res.error)
      }
    })
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
      root.refreshStatus()
    }
  }

  Component.onCompleted: { root.refreshStatus(); watchProcess.running = true }

  Process {
    id: actionProcess
    property var onDoneCallback: null
    running: false
    command: []
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
            title: root.vaultExists ? (root.npub ? root.shortKey(root.npub) : "Nostr") : "Nostr"
            meta: !root.daemonReachable ? "Signer daemon unreachable"
              : !root.vaultExists ? "No key configured"
              : root.locked ? "Locked"
              : root.busy ? "Working…"
              : "Unlocked"
            foreground: root.foreground
            fontFamily: root.fontFamily
            trailingControl: root.vaultExists && !root.locked ? lockNowButton : null
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

            Button {
              text: root.busy ? "Unlocking…" : "Unlock"
              foreground: root.foreground
              bordered: true
              enabled: !root.busy && root.unlockPassphrase.length > 0
              onClicked: root.submitUnlock()
            }
          }

          // --- Unlocked: pending requests ----------------------------------
          Column {
            visible: root.vaultExists && !root.locked && root.pendingList.length > 0
            width: parent.width
            spacing: Style.space(8)

            PanelSeparator { foreground: root.foreground }
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
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                Row {
                  spacing: Style.space(6)
                  Button { text: "Approve once"; foreground: root.foreground; bordered: true; onClicked: root.approve(modelData.id, false) }
                  Button { text: "Always allow"; foreground: root.foreground; bordered: true; onClicked: root.approve(modelData.id, true) }
                  Button { text: "Deny"; foreground: root.urgent; bordered: true; onClicked: root.deny(modelData.id) }
                }
              }
            }
          }

          // --- Unlocked: authorized apps ------------------------------------
          Column {
            visible: root.vaultExists && !root.locked && Object.keys(root.clients).length > 0
            width: parent.width
            spacing: Style.space(8)

            PanelSeparator { foreground: root.foreground }
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

          // --- Unlocked: relays ----------------------------------------------
          Column {
            visible: root.vaultExists && !root.locked
            width: parent.width
            spacing: Style.space(8)

            PanelSeparator { foreground: root.foreground }
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
          }
        }
      }
    }
  }
}
