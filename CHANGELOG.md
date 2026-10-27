# Changelog

Earlier versions are described on the
[GitHub releases page](https://github.com/ninepointlabs/omostrich/releases).

## 0.3.2

- **Profile picture metadata is stripped before the panel loads it**
  (marketplace review [#12494](https://github.com/omacom/omarchy-plugin-marketplace/issues/12494)).
  Qt/libpng inflate a PNG's compressed text chunks while reading its
  header, before `sourceSize` applies, so a sub-1 MB, 32×32 PNG with
  ~150 zTXt chunks took a Qt process to ~4 GB. The daemon now caches
  only what drawing the picture needs:
  - PNG: IHDR, PLTE, tRNS, gAMA, cHRM, sRGB, IDAT and IEND. Text, ICC,
    EXIF, APNG and private chunks are dropped; an unknown critical
    chunk is refused.
  - JPEG: COM and APP1–APP13/APP15 (EXIF, ICC, XMP, Photoshop) are
    dropped; JFIF (APP0) and Adobe (APP14) stay.
  - GIF: the first frame and its graphic control block only.
  - WebP: still images only (VP8/VP8L, plus ALPH); ICCP, EXIF and XMP
    are dropped. Animated WebP is refused, so the placeholder shows.
  - Anything after the end of the image is dropped. A picture cached by
    0.3.1 is fetched again.
