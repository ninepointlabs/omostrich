import QtQuick
import QtQuick.Effects
import qs.Commons
import qs.Ui

// Bar icon for the Nostr widget: the ostrich silhouette Tim supplied,
// recolored to match the bar's current foreground/locked-state color via
// MultiEffect colorization — the same technique Tray.qml's TrayIcon
// component uses to recolor symbolic tray icons, not a new pattern. A flat
// `Image` alone would just show whatever raster color the PNG has baked in
// (black) regardless of theme or locked state; colorization lets this icon
// keep behaving like the rest of the bar's icons, which all follow
// root.barIconColor (dim when locked, urgent-colored when the daemon is
// unreachable).
//
// Previously a hand-drawn padlock (LockIcon's original name/shape); kept
// the file/component name LockIcon to avoid touching every reference site
// in Panel.qml, but the drawing itself is now this silhouette.
//
// pendingCount adds a small numeric badge (same visual pattern as
// TailscaleIcon.qml's warning badge) for outstanding NIP-46 approval
// requests, so the merged Nostr widget can surface "something needs your
// attention" without opening the dropdown. Unchanged from the padlock
// version.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  property bool locked: true
  property int pendingCount: 0

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  Image {
    id: silhouette
    anchors.fill: parent
    fillMode: Image.PreserveAspectFit
    smooth: true
    // Decode at physical pixels so the icon stays crisp on HiDPI displays
    // instead of upscaling a smaller raster — same reasoning Tray.qml uses
    // for its own icons.
    sourceSize.width: Math.round(root.iconSize * Screen.devicePixelRatio)
    sourceSize.height: Math.round(root.iconSize * Screen.devicePixelRatio)
    source: "ostrich.png"
    visible: false
    layer.enabled: true
  }

  MultiEffect {
    anchors.fill: silhouette
    source: silhouette
    colorization: 1.0
    colorizationColor: root.color
  }

  BorderSurface {
    visible: root.pendingCount > 0
    width: Math.max(7, parent.width * 0.46)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.topMargin: -parent.height * 0.06
    anchors.rightMargin: -parent.width * 0.06
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      anchors.centerIn: parent
      text: root.pendingCount > 9 ? "9+" : String(root.pendingCount)
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * (root.pendingCount > 9 ? 0.5 : 0.72))
      font.bold: true
    }
  }
}
