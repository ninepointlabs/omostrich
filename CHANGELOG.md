# Changelog

Earlier versions are described on the
[GitHub releases page](https://github.com/ninepointlabs/omostrich/releases).

## Unreleased

- **"Always allow" for `sign_event` is now per kind** (`sign_event:4`),
  so a DM grant no longer signs kind 1 notes or kind 0 profile changes
  silently. **Old plain `sign_event` grants (all kinds) are dropped on
  upgrade**; the log names the affected apps, and they ask again once
  per kind.
- Kind 14 and kind 1059 sign requests show a warning and can't be
  remembered.
- Encrypt/decrypt prompts show the peer as a shortened npub, and
  encrypt prompts preview the plaintext. Previews are held in memory
  for the prompt only and never logged.
- `get_public_key` is answered without a prompt only for a connected or
  remembered app; anyone else gets a prompt.
- A `notify-send` that can't be spawned no longer crashes the daemon;
  the failure is logged once (error code only).
- Kind 1059 notifications look back two days (NIP-59 backdating), and
  gift wraps already on the relays at unlock are marked seen rather
  than toasted.
- README: the security model documents the per-kind grants and the
  known gap that an app which never connected can still raise prompts.
- Approval logic moved to `daemon/approvals.mjs`, with new tests in
  `tests/approvals.test.mjs` and `tests/notify-watch.test.mjs`.

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
