import QtQuick
import qs.Commons

// Custom-drawn padlock mark instead of a font glyph. The Nerd Font md-lock /
// md-lock_open codepoints (verified color-table-free with fontTools) still
// render with stray color fringing in this bar's tiny icon slot — some part
// of the Qt/Wayland text-rendering path outside the font file itself is
// responsible, and it wasn't worth chasing further. Drawing the mark from
// plain Rectangles sidesteps font/glyph rendering entirely, the same
// approach TailscaleIcon.qml already uses for the same reason.
//
// pendingCount adds a small numeric badge (same visual pattern as
// TailscaleIcon.qml's warning badge) for outstanding NIP-46 approval
// requests, so the merged Nostr widget can surface "something needs your
// attention" without opening the dropdown.
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

  readonly property real strokeWidth: Math.max(1.4, iconSize * 0.11)
  readonly property real shackleSize: iconSize * 0.58
  readonly property real bodyWidth: iconSize * 0.86
  readonly property real bodyHeight: iconSize * 0.5

  Item {
    id: shackleClip
    width: root.shackleSize
    height: root.shackleSize / 2 + root.strokeWidth / 2
    clip: true
    anchors.horizontalCenter: parent.horizontalCenter
    y: root.iconSize * 0.03
    transformOrigin: Item.BottomRight
    rotation: root.locked ? 0 : -32

    Rectangle {
      width: root.shackleSize
      height: root.shackleSize
      radius: width / 2
      color: "transparent"
      border.width: root.strokeWidth
      border.color: root.color
    }
  }

  Rectangle {
    width: root.bodyWidth
    height: root.bodyHeight
    radius: Math.min(width, height) * 0.22
    color: root.color
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: root.iconSize * 0.04

    Rectangle {
      width: Math.max(2, root.iconSize * 0.12)
      height: width
      radius: width / 2
      color: Qt.darker(root.color, 2.6)
      anchors.centerIn: parent
    }
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
