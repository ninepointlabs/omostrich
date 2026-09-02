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
  // The compose TextArea only exists in the visible tree once the async
  // status check (spawned in open()) actually returns — it can take
  // longer than any fixed timer would assume. draftField's own `visible`
  // binding tracks this directly (see its onVisibleChanged handler) so
  // the focus claim fires off the real state transition, not a guess at
  // how long the round-trip usually takes.
  readonly property bool composeReady: !root.checking && root.daemonReachable && root.vaultExists && !root.locked

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
    }, false)
  }

  // markBusy defaults true (publish/etc. should disable the field while
  // in flight) but status polls pass false — this was the second, worse
  // bug behind "cannot type": every refreshStatus() call set busy=true
  // and NOTHING ever reset it back to false for the status path, so
  // draftField's `enabled: !root.busy` binding left it permanently
  // disabled after the very first status check on open(). No focus fix
  // matters against a disabled TextArea — Qt won't route keys to it at
  // all regardless of who holds activeFocus. Caught by actually typing
  // into a live, unlocked instance via wtype and watching nothing
  // appear, not by reasoning about the QML alone. Matches Panel.qml's
  // existing runAction(cmd, payload, onDone, markBusy) signature, which
  // already had this right.
  //
  // Audit item 1 (HIGH): payload goes over stdin, not argv, matching
  // Panel.qml's runAction. This overlay is compose-only and never sends
  // an nsec/passphrase itself, but the note content still shouldn't sit
  // in /proc/<pid>/cmdline for the life of the process any more than it
  // has to, and keeping both runAction implementations on the identical
  // pattern means a future change to this file can't silently reopen the
  // argv exposure by copy-pasting the old shape.
  function runAction(cmd, payload, onDone, markBusy) {
    if (markBusy !== false) root.busy = true
    actionProcess.pendingPayload = payload !== undefined ? JSON.stringify(payload) + "\n" : ""
    actionProcess.onDoneCallback = onDone
    actionProcess.command = [root.nodeBin, root.ctlPath, cmd]
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

  // Bounded safety net under draftField's onVisibleChanged handler, for
  // exactly one class of case that a single forceActiveFocus() call can
  // still miss: Quickshell surfaces occasionally need more than one
  // event-loop turn to finish wiring up a freshly-visible item's Qt focus
  // scope after a fresh layer-shell surface maps (as opposed to Column
  // visibility toggling within an already-mapped, already-focused-once
  // surface, which callLater alone reliably covers). Unlike the old
  // "assume focus landed after N ms" bug this replaces, this checks the
  // REAL outcome each tick (draftField.activeFocus) and only re-fires
  // forceActiveFocus() if it's still false — it never just declares
  // victory on a timer elapsing. Capped at 10 tries (500ms total) so a
  // permanently-stuck focus state (e.g. overlay dismissed mid-retry)
  // can't spin forever; onVisibleChanged(false) also stops it outright.
  Timer {
    id: focusRetryTimer
    interval: 50
    repeat: true
    property int attempts: 0
    onTriggered: {
      attempts += 1
      if (!root.opened || !draftField.visible || draftField.activeFocus || attempts >= 10) {
        stop()
        return
      }
      draftField.forceActiveFocus()
    }
  }

  PanelWindow {
    id: panel
    visible: root.opened
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "tim-nostr-compose-overlay"
    WlrLayershell.layer: WlrLayer.Overlay
    // Prime with Exclusive so the compositor actually delivers keyboard
    // events to this surface at all — Hyprland won't send anything here
    // without it, per KeyboardPanel's own header comment. But unlike
    // KeyboardPanel/other Omarchy popups, we don't hand off to OnDemand on
    // a fixed timer: the compose TextArea only exists once an async
    // `status` round-trip over the control socket resolves (open() ->
    // refreshStatus()), and that can take longer than any fixed interval
    // — a timer-based handoff raced ahead of the field actually holding
    // Qt-level focus and silently lost every time (5eb213f, still failed
    // live: the TextArea rendered but never got keystrokes). Gate the
    // handoff on the real outcome instead: stay Exclusive until
    // draftField itself reports activeFocus === true (see draftField's
    // own onVisibleChanged below for what drives that), then relax to
    // OnDemand. No arbitrary "surely by now" delay anywhere in this path.
    WlrLayershell.keyboardFocus: root.opened
      ? (draftField.activeFocus ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.Exclusive)
      : WlrKeyboardFocus.None
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
        // Holds keyboard focus only while there's no TextArea to type into.
        // This was the actual bug: `focus: true` here unconditionally,
        // regardless of state, meant it always won the initial-focus race
        // against draftField.forceActiveFocus() once compose became ready
        // — so the field displayed but keystrokes never reached it. Now it
        // steps aside the moment composeReady flips true; draftField's own
        // Keys.onPressed already handles Escape (see below) once it holds
        // real focus, so there's no ancestor/descendant key-routing
        // ambiguity to reason about in either state.
        focus: !root.composeReady
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
            text: "Omostrich"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            text: "Post to Nostr"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
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
              // Bound directly (not just inheriting the parent Column's
              // effective visibility) so this item's own visibleChanged
              // signal actually fires when compose becomes available —
              // a child's `visible` property doesn't emit that signal
              // just because an ancestor's visibility changed, only when
              // its own property flips. `checking` is forced true again
              // at the top of every open()/refreshStatus() call before
              // the async status round-trip resolves, so this genuinely
              // goes false -> true on every single open, including
              // reopen/toggle while already unlocked from a prior
              // session — never a same-value non-edge.
              visible: root.composeReady
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

              // The real fix: claim Qt-level active focus from this item's
              // own visibility transition, not a fixed-delay timer racing
              // against it from outside. Qt.callLater defers one event-loop
              // turn so layout/anchoring has actually settled before the
              // focus call — a synchronous forceActiveFocus() here can
              // still land before Qt finishes wiring up the newly-visible
              // item's focus scope. focusRetryTimer is a bounded safety
              // net underneath this, not the primary mechanism — see its
              // own comment for why it's not the same mistake as before.
              onVisibleChanged: if (visible) {
                Qt.callLater(function() { if (root.opened) draftField.forceActiveFocus() })
                focusRetryTimer.attempts = 0
                focusRetryTimer.restart()
              } else {
                focusRetryTimer.stop()
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
