import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "About.js" as About

// The dropdown's About page: who made Omostrich, its version and license,
// where to get help, and what it does with your key and your data.
// Panel.qml swaps it in for the main controls (the info button in the
// header). It never talks to the signer daemon, so it works locked.
Column {
  id: root

  property color foreground: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property string version: ""
  property string licenseText: ""
  property string quickshellVersion: ""
  property string qtVersion: ""
  property bool showLicense: false
  property string notice: ""

  signal backRequested()

  readonly property color dim: Qt.darker(foreground, 1.4)
  readonly property string details: About.details(root.version, root.quickshellVersion, root.qtVersion,
    (Quickshell.env("XDG_CURRENT_DESKTOP") || "unknown desktop") + ", " + Qt.platform.pluginName)
  readonly property real labelWidth: Style.space(64)
  readonly property real valueWidth: width - labelWidth - Style.space(10)

  function copy(text, what) {
    Quickshell.clipboardText = text
    root.notice = what + " copied"
    noticeTimer.restart()
  }

  spacing: Style.space(12)
  onVisibleChanged: if (!visible) { root.showLicense = false; root.notice = "" }

  Timer { id: noticeTimer; interval: 2500; onTriggered: root.notice = "" }

  component AboutLabel: Text {
    width: root.labelWidth
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  component AboutValue: Text {
    width: root.valueWidth
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Item {
    width: parent.width
    height: backButton.implicitHeight

    Button {
      id: backButton
      objectName: "aboutBack"
      iconText: "󰁍"
      text: "Back"
      tooltipText: "Back to Omostrich (Esc)"
      foreground: root.foreground
      accent: root.accent
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      onClicked: root.backRequested()
    }
  }

  Row {
    width: parent.width
    spacing: Style.space(14)

    LockIcon {
      id: appIcon
      iconSize: Style.space(40)
      color: root.accent
      locked: false
      anchors.verticalCenter: parent.verticalCenter
    }

    Column {
      width: parent.width - appIcon.width - parent.spacing
      spacing: Style.space(3)
      anchors.verticalCenter: parent.verticalCenter

      Text {
        textFormat: Text.PlainText
        text: About.NAME
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }
      Text {
        width: parent.width
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        text: About.TAGLINE
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }
      Text {
        objectName: "aboutVersion"
        textFormat: Text.PlainText
        text: "Version " + (root.version || "unknown")
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  PanelSeparator { foreground: root.foreground }

  Grid {
    width: parent.width
    columns: 2
    columnSpacing: Style.space(10)
    rowSpacing: Style.space(8)

    AboutLabel { text: "Made by" }
    AboutValue { objectName: "aboutOrganization"; text: About.ORGANIZATION }

    AboutLabel { text: "Created" }
    AboutValue { text: About.CREATED }

    AboutLabel { text: "License" }
    Column {
      width: root.valueWidth
      spacing: Style.space(4)
      AboutValue { text: About.licenseSummary(root.licenseText) || "MIT License" }
      Button {
        objectName: "aboutLicense"
        text: root.showLicense ? "Hide license" : "Read license"
        foreground: root.foreground
        accent: root.accent
        fontFamily: root.fontFamily
        fontSize: Style.font.caption
        onClicked: root.showLicense = !root.showLicense
      }
    }

    AboutLabel { text: "Support" }
    Column {
      width: root.valueWidth
      spacing: Style.space(4)
      AboutValue { text: About.SUPPORT_EMAIL }
      Flow {
        width: parent.width
        spacing: Style.space(6)
        Button {
          text: "Email"
          tooltipText: "Opens your mail app with the version details filled in"
          bordered: true
          foreground: root.foreground
          accent: root.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onClicked: Qt.openUrlExternally(About.mailto(root.version, root.details))
        }
        Button {
          text: "Copy"
          bordered: true
          foreground: root.foreground
          accent: root.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onClicked: root.copy(About.SUPPORT_EMAIL, "Address")
        }
        Button {
          objectName: "aboutCopyDetails"
          text: "Copy version details"
          bordered: true
          foreground: root.foreground
          accent: root.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.caption
          onClicked: root.copy(root.details, "Version details")
        }
      }
      Text {
        visible: root.notice !== ""
        textFormat: Text.PlainText
        text: root.notice
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    AboutLabel { text: "Built with" }
    AboutValue {
      objectName: "aboutBuiltWith"
      text: About.builtWith(root.quickshellVersion, root.qtVersion)
      color: root.dim
      font.pixelSize: Style.font.caption
    }
  }

  Rectangle {
    width: parent.width
    height: Style.space(150)
    visible: root.showLicense
    color: "transparent"
    radius: Style.cornerRadius
    border.width: 1
    border.color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.25)

    Flickable {
      id: licenseView
      anchors.fill: parent
      anchors.margins: Style.space(8)
      clip: true
      contentHeight: licenseBody.implicitHeight
      boundsBehavior: Flickable.StopAtBounds

      Text {
        id: licenseBody
        objectName: "aboutLicenseText"
        width: licenseView.width
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        text: About.licenseBody(root.licenseText) || "LICENSE could not be read from the plugin folder."
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  PanelSeparator { foreground: root.foreground }

  Text {
    width: parent.width
    textFormat: Text.PlainText
    text: "PRIVACY"
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
    font.letterSpacing: 1.2
  }
  Text {
    objectName: "aboutPrivacy"
    width: parent.width
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    text: About.PRIVACY
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }
}
