#!/usr/bin/env node
// Reads one QR code from the laptop camera and prints its text on stdout.
//
//   scan-qr.mjs [--prefix nostrconnect://] [--device /dev/video0] [--timeout 120]
//
// Exit 0 with the code on stdout; 1 if cancelled (preview window closed,
// SIGTERM) or timed out; 2 if the camera or a tool could not be started,
// with the reason on stderr.
//
// Replaces `zbarcam`, which hands zbar the raw 720p frame. A nostrconnect://
// code from Amethyst is ~470 characters (a 77-module QR), and a fixed-focus
// laptop webcam can't get it both big enough and sharp enough for that:
// in a simulation (code shrunk and blurred into a 1280x720 frame) zbar on
// the raw frame needed it 260-340px tall and nearly sharp. Upscaling 2x and
// sharpening before zbar read it at 200px with blur that defeated the raw
// frame. So one ffmpeg process owns the camera and produces two streams:
//   - a small mirrored preview with a guide box, piped to ffplay (its window
//     is how the user aims, and closing it cancels the scan)
//   - 5 grayscale frames a second, upscaled 2x, as a mild and a strong
//     sharpen stacked into one image, so one zbarimg pass gets both chances.
// Frames go to zbarimg over stdin and are never written to disk.

import { spawn } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const prefix = arg("--prefix", "");
const device = arg("--device", "/dev/video0");
const timeoutSec = Number(arg("--timeout", "120"));

const SCAN_FILTER = [
  "[0:v]split=2[pv][dv]",
  "[pv]hflip,scale=640:-2,drawbox=x=(iw-ih*0.7)/2:y=ih*0.15:w=ih*0.7:h=ih*0.7:color=white@0.8:t=3,format=yuv420p[preview]",
  "[dv]fps=5,format=gray,scale=iw*2:ih*2:flags=bicubic,split=2[a][b]",
  "[a]unsharp=9:9:2.5[a2]",
  "[b]unsharp=13:13:3.5[b2]",
  "[a2][b2]vstack[scan]",
].join(";");

const children = new Set();
let finished = false;

// Waits (up to a second, then SIGKILL) for ffmpeg to let go of the camera
// before exiting, so the camera is off by the time the caller sees a result.
function finish(code, out) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const live = [...children].filter((c) => c.exitCode === null && c.signalCode === null);
  for (const c of live) c.kill("SIGTERM");
  const exited = Promise.all(live.map((c) => new Promise((resolve) => c.once("exit", resolve))));
  const grace = new Promise((resolve) => setTimeout(resolve, 1000));
  Promise.race([exited, grace]).then(() => {
    for (const c of live) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    if (out) process.stdout.write(out + "\n");
    process.exit(code);
  });
}

function fail(message) {
  process.stderr.write(message + "\n");
  finish(2);
}

process.on("SIGTERM", () => finish(1));
process.on("SIGINT", () => finish(1));
const timer = setTimeout(() => finish(1), timeoutSec * 1000);

const preview = spawn(
  "ffplay",
  [
    "-hide_banner", "-loglevel", "error",
    "-window_title", "Omostrich: hold the QR code inside the box",
    "-fflags", "nobuffer", "-flags", "low_delay", "-framedrop", "-autoexit",
    "-f", "nut", "-i", "pipe:0",
  ],
  { stdio: ["pipe", "ignore", "ignore"] },
);
children.add(preview);
preview.on("error", (err) => fail(`could not start ffplay: ${err.message}`));
preview.on("exit", () => finish(1)); // window closed = cancel
preview.stdin.on("error", () => {}); // EPIPE once the window is gone

let gotFrame = false;

// MJPEG gives this webcam 30 fps at 1280x720 (raw YUYV only 10), so less
// motion blur. A camera without MJPEG gets one retry on its default format.
// A --device outside /dev is read as a looping video file (for testing).
function startCamera(withMjpeg) {
  const input = !device.startsWith("/dev/")
    ? ["-re", "-stream_loop", "-1", "-i", device]
    : withMjpeg
    ? ["-f", "v4l2", "-input_format", "mjpeg", "-video_size", "1280x720", "-framerate", "30", "-i", device]
    : ["-f", "v4l2", "-i", device];
  const cam = spawn(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      ...input,
      "-filter_complex", SCAN_FILTER,
      "-map", "[preview]", "-c:v", "rawvideo", "-f", "nut", "pipe:1",
      "-map", "[scan]", "-c:v", "pgm", "-f", "image2pipe", "pipe:3",
    ],
    { stdio: ["ignore", preview.stdin, "pipe", "pipe"] },
  );
  children.add(cam);
  let errText = "";
  cam.stderr.on("data", (d) => (errText += d).length > 4000 && (errText = errText.slice(-4000)));
  cam.on("error", (err) => fail(`could not start ffmpeg: ${err.message}`));
  cam.on("exit", () => {
    children.delete(cam);
    if (finished) return;
    if (!gotFrame && withMjpeg) return startCamera(false);
    fail(`camera stopped: ${errText.trim().split("\n").pop() || device}`);
  });
  readFrames(cam.stdio[3]);
}

// image2pipe PGM: "P5 <w> <h> <maxval>\n" + w*h bytes, back to back.
function readFrames(stream) {
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 64).toString("latin1"));
      if (!m) return;
      const size = m[0].length + Number(m[1]) * Number(m[2]);
      if (buf.length < size) return;
      gotFrame = true;
      offer(buf.subarray(0, size));
      buf = buf.subarray(size);
    }
  });
  stream.on("error", () => {});
}

// One zbarimg at a time; frames arriving meanwhile are dropped except the
// newest, so decoding never falls behind the camera.
let busy = false;
let next = null;

function offer(frame) {
  if (finished) return;
  if (busy) {
    next = Buffer.from(frame);
    return;
  }
  decode(Buffer.from(frame));
}

function decode(frame) {
  busy = true;
  const z = spawn("zbarimg", ["-q", "--raw", "-Sdisable", "-Sqrcode.enable", "-"], { stdio: ["pipe", "pipe", "ignore"] });
  children.add(z);
  let out = "";
  z.stdout.on("data", (d) => (out += d));
  z.stdin.on("error", () => {});
  z.on("error", (err) => fail(`could not start zbarimg (install zbar): ${err.message}`));
  z.on("close", () => {
    children.delete(z);
    busy = false;
    if (finished) return;
    // Both stacked halves may decode; any line that matches will do.
    const hit = out.split("\n").map((l) => l.trim()).find((l) => l && l.startsWith(prefix));
    if (hit) return finish(0, hit);
    if (next) {
      const f = next;
      next = null;
      decode(f);
    }
  });
  z.stdin.end(frame);
}

startCamera(true);
