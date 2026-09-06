import QtQuick
import QtQuick.Effects
import qs.Commons
import qs.Ui

// Bar icon: ostrich silhouette tinted to Color.foreground / barIconColor,
// same as Tray.qml's symbolic TrayIcon (hidden-or-under raster + MultiEffect
// colorization 1.0). The PNG itself is white-on-transparent so if the
// effect fails or sits behind, the fallback is already light gray/white
// like bluetooth/audio — not a black blob.
//
// File/component name stays LockIcon so Panel.qml does not need a rewrite.
// pendingCount badge is the TailscaleIcon BorderSurface dot.
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
    sourceSize.width: Math.round(root.iconSize * Screen.devicePixelRatio)
    sourceSize.height: Math.round(root.iconSize * Screen.devicePixelRatio)
    source: "ostrich.png"
    // White raster as the fallback (visible underneath). Tray hides this
    // when colorizing; we keep it so a failed MultiEffect still shows a
    // light bird instead of a blank slot or a black one.
    visible: true
    z: 0
    layer.enabled: true
  }

  MultiEffect {
    id: tint
    anchors.fill: silhouette
    source: silhouette
    z: 1
    visible: silhouette.status === Image.Ready
    colorization: 1.0
    colorizationColor: root.color
  }

  BorderSurface {
    visible: root.pendingCount > 0
    z: 2
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
      textFormat: Text.PlainText
      anchors.centerIn: parent
      text: root.pendingCount > 9 ? "9+" : String(root.pendingCount)
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * (root.pendingCount > 9 ? 0.5 : 0.72))
      font.bold: true
    }
  }
}
