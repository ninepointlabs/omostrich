import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Ui

// Compose-only overlay for the same signer daemon Panel.qml talks to.
// Extra surface, not extra chrome: no second bar icon, no second identity.
// Same control-socket CLI (bin/ctl.mjs), same `publish` command, same
// "this plugin never holds an nsec" boundary as the dropdown. Bound to
// SUPER + N (confirmed unused via `omarchy menu keybindings --print`
// as of 2026-09-01) so summoning it doesn't need the bar icon open at all.
//
// v1 scope per the brief: compose text only. No attach/paste here — that
// UI already fights for space in the dropdown's fixed width; cramming it
// into a keyboard-first overlay is a fight for another day. Locked or
// unreachable states say so plainly and point at the ostrich instead of
// pretending to be a composer.
Item {
  id: root

  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null

  property bool opened: false
  property bool busy: false
  property bool checking: true
  property bool daemonReachable: false
  property bool vaultExists: false
  property bool locked: true
  property string errorText: ""
  property string statusText: ""
  property string draft: ""

  readonly property string nodeBin: Quickshell.env("HOME") + "/.local/share/mise/shims/node"
  readonly property string ctlPath: Quickshell.env("HOME") + "/Projects/omarchy-nostr-signer/bin/ctl.mjs"
  readonly property int softLimit: 700
  readonly property bool canPost: root.daemonReachable && root.vaultExists && !root.locked && !root.busy && root.draft.trim().length > 0

  property color background: Color.menu.background
  property color foreground: Color.menu.text
  property color border: Color.menu.border
  property var borderSpec: Border.surfaceSpec("menu", "border", border, Math.max(1, Style.space(2)))
  property color scrim: Color.menu.scrim
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property color urgent: Color.urgent
  property string fontFamily: Style.font.menuFamily
  readonly property int cornerRadius: Style.cornerRadius
  property int cardWidth: Math.min(Style.space(440), panel.width - Style.gapsOut * 2)

  function open(payloadJson) {
    root.opened = true
    root.errorText = ""
    root.statusText = ""
    root.refreshStatus()
    Qt.callLater(function() { draftField.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function")
      root.shell.hide((root.manifest && root.manifest.id) || "tim.nostr-signer")
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function refreshStatus() {
    root.checking = true
    runAction("status", undefined, function(res) {
      root.checking = false
      if (res.ok) {
        root.daemonReachable = true
        root.vaultExists = !!res.data.vaultExists
        root.locked = !!res.data.locked
      } else {
        root.daemonReachable = false
      }
    })
  }

  function runAction(cmd, payload, onDone) {
    root.busy = true
    var args = [root.nodeBin, root.ctlPath, cmd]
    if (payload !== undefined) args.push(JSON.stringify(payload))
    actionProcess.onDoneCallback = onDone
    actionProcess.command = args
    actionProcess.running = true
  }

  function post() {
    var text = root.draft.trim()
    if (!text || root.busy) return
    root.errorText = ""
    root.statusText = ""
    runAction("publish", { content: text }, function(res) {
      root.busy = false
      if (res.ok) {
        var okList = Array.isArray(res.data && res.data.publishedTo) ? res.data.publishedTo : []
        var failList = Array.isArray(res.data && res.data.failed) ? res.data.failed : []
        var okCount = okList.length
        var total = okCount + failList.length
        if (failList.length === 0) {
          root.draft = ""
          root.statusText = "Posted to " + okCount + " relay" + (okCount === 1 ? "" : "s") + "."
          dismissTimer.restart()
        } else if (okCount === 0) {
          root.errorText = "Posted to 0 of " + total + " relays. Check the signer log."
        } else {
          root.draft = ""
          root.statusText = "Posted to " + okCount + " of " + total + " relays."
          dismissTimer.restart()
        }
      } else {
        root.errorText = describeError(res.error)
      }
    })
  }

  function describeError(err) {
    var s = String(err || "")
    if (s === "locked") return "Signer is locked. Unlock it from the ostrich icon first."
    if (s === "no vault; import a key first") return "No key configured. Set one up from the ostrich icon first."
    if (s === "not connected to relays") return "Not connected to any relay yet. Try again in a moment."
    if (s === "content required") return "Nothing to post."
    if (s === "daemon_not_running") return "Signer daemon isn't running."
    return s || "Something went wrong."
  }

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
      var response = null
      try { response = JSON.parse(String(root._actionOutput || "")) } catch (e) { response = null }
      if (!response) response = { ok: false, error: "signer daemon unreachable" }
      var cb = actionProcess.onDoneCallback
      actionProcess.onDoneCallback = null
      if (cb) cb(response)
    }
  }
  property string _actionOutput: ""

  // Posting a note is done; give the user a beat to see the confirmation,
  // then close so the overlay doesn't linger over whatever they were doing.
  Timer {
    id: dismissTimer
    interval: 900
    repeat: false
    onTriggered: root.dismiss()
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "tim-nostr-compose-overlay"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: root.cardWidth
      implicitHeight: content.implicitHeight + card.contentTopInset + card.contentBottomInset
      anchors.centerIn: parent
      color: root.background
      borderSpec: root.borderSpec
      radius: root.cornerRadius
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        id: escCatcher
        anchors.fill: parent
        focus: true
        Keys.onEscapePressed: root.dismiss()

        Column {
          id: content
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: card.contentTopInset
          anchors.leftMargin: card.contentLeftInset
          anchors.rightMargin: card.contentRightInset
          spacing: Style.space(10)

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "Post to Nostr"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          // --- Locked / unreachable / no key: say so, point at the icon ---
          Column {
            visible: !root.checking && (!root.daemonReachable || !root.vaultExists || root.locked)
            width: parent.width
            spacing: Style.space(8)

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: !root.daemonReachable ? "Signer daemon unreachable. Check the service, then try again."
                : !root.vaultExists ? "No key configured yet. Open the ostrich icon on the bar to set one up."
                : "Signer is locked. Open the ostrich icon on the bar to unlock it, then reopen this."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Button {
              text: "Retry"
              foreground: root.foreground
              bordered: true
              onClicked: root.refreshStatus()
            }
          }

          Text {
            visible: root.checking
            width: parent.width
            text: "Checking signer…"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }

          // --- Compose, same wrap/grow field as the dropdown ---------------
          Column {
            visible: !root.checking && root.daemonReachable && root.vaultExists && !root.locked
            width: parent.width
            spacing: Style.space(8)

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

              readonly property real composeMinHeight: Style.space(64)
              readonly property real composeMaxHeight: Style.space(260)
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
                if (event.key === Qt.Key_Escape) {
                  root.dismiss()
                  event.accepted = true
                  return
                }
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

            Row {
              width: parent.width
              spacing: Style.space(8)

              Button {
                text: root.busy ? "Posting…" : "Post"
                foreground: root.foreground
                bordered: true
                enabled: root.canPost
                onClicked: root.post()
              }

              Button {
                text: "Cancel"
                foreground: root.dim
                bordered: true
                onClicked: root.dismiss()
              }
            }
          }

          Text {
            visible: root.errorText !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            text: root.errorText
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            visible: root.errorText === "" && root.statusText !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            text: root.statusText
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Esc to dismiss · Enter to post · Shift+Enter for a newline"
            color: Qt.darker(root.dim, 1.3)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
