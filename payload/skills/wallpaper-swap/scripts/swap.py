#!/usr/bin/env python3
"""Build a wallpaper frames file for the OpenCode Mitsuha wallpaper plugin.

The plugin reads frames.bin with this layout:
  4 bytes   magic "MTSH"
  uint16    version (1)
  uint16    frame count
  uint16    frame width
  uint16    frame height
  N frames  RGBA, row-major, width * height * 4 bytes each

Default: 480x270, up to 56 frames, pre-dimmed by 34% toward #070c18.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageOps, ImageSequence
except ImportError:
    sys.exit("Pillow is required: python -m pip install pillow")

DEFAULT_PLUGIN = Path.home() / ".config" / "opencode" / "plugins" / "mitsuha-wallpaper"
VIDEO = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
IMAGE = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
MARKER = re.compile(r"^// wallpaper-swap reload: .*$", re.MULTILINE)


def parse_hex(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise argparse.ArgumentTypeError("dim color must be a 6-digit hex color")
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def source_frames(source: Path, fps: int, limit: int) -> list[Image.Image]:
    if source.is_dir():
        files = sorted(p for p in source.iterdir() if p.suffix.lower() in IMAGE)
        if not files:
            raise SystemExit(f"no image files in {source}")
        return [Image.open(p) for p in files[:limit]]

    suffix = source.suffix.lower()
    if suffix in VIDEO:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise SystemExit("ffmpeg is required for video sources")
        with tempfile.TemporaryDirectory(prefix="wallpaper-") as directory:
            pattern = str(Path(directory) / "frame-%04d.png")
            command = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source),
                "-vf",
                f"fps={fps}",
                "-frames:v",
                str(limit),
                pattern,
            ]
            subprocess.run(command, check=True)
            files = sorted(Path(directory).glob("frame-*.png"))
            if not files:
                raise SystemExit(f"ffmpeg produced no frames from {source}")
            return [Image.open(p).copy() for p in files]

    image = Image.open(source)
    if getattr(image, "n_frames", 1) <= 1:
        return [image.copy()]
    frames = [frame.convert("RGB") for frame in ImageSequence.Iterator(image)]
    if len(frames) > limit:
        step = len(frames) / limit
        frames = [frames[int(i * step)] for i in range(limit)]
    return frames


def build(source: Path, destination: Path, width: int, height: int, limit: int, fps: int, dim: float, dim_color: tuple[int, int, int]) -> int:
    frames = source_frames(source, fps, limit)
    if not frames:
        raise SystemExit(f"no frames found in {source}")
    color = Image.new("RGB", (width, height), dim_color)
    out = bytearray(b"MTSH" + struct.pack("<HHHH", 1, len(frames), width, height))
    for index, frame in enumerate(frames):
        fitted = ImageOps.fit(frame.convert("RGB"), (width, height), method=Image.LANCZOS, centering=(0.5, 0.5))
        if dim > 0:
            fitted = Image.blend(color, fitted, max(0.0, min(1.0, dim)))
        out.extend(fitted.convert("RGBA").tobytes())
        if (index + 1) % 10 == 0:
            print(f"  {index + 1}/{len(frames)}", file=sys.stderr)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_bytes(out)
    temporary.replace(destination)
    return len(frames)


def touch_plugin(plugin: Path) -> None:
    entry = plugin / "tui.ts"
    if not entry.exists():
        print(f"warning: {entry} not found; skip reload marker", file=sys.stderr)
        return
    text = entry.read_text(encoding="utf-8")
    marker = f"// wallpaper-swap reload: {dt.datetime.now().isoformat(timespec='seconds')}"
    if MARKER.search(text):
        text = MARKER.sub(marker, text, count=1)
    else:
        text = text.rstrip() + "\n" + marker + "\n"
    entry.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Swap the OpenCode Mitsuha wallpaper.")
    parser.add_argument("source", nargs="?", help="GIF, image, video, or folder of frames")
    parser.add_argument("--plugin-dir", type=Path, default=DEFAULT_PLUGIN)
    parser.add_argument("--output", type=Path, help="write here instead of the plugin's frames.bin")
    parser.add_argument("--frames", type=int, default=56, help="maximum frames (default 56)")
    parser.add_argument("--fps", type=int, default=25, help="video sampling FPS (default 25)")
    parser.add_argument("--dim", type=float, default=0.34, help="pre-dim strength 0..1 (default 0.34)")
    parser.add_argument("--dim-color", type=parse_hex, default=parse_hex("070c18"))
    parser.add_argument("--width", type=int, default=480)
    parser.add_argument("--height", type=int, default=270)
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--no-touch", action="store_true")
    parser.add_argument("--restore", action="store_true", help="restore frames.bin.bak")
    args = parser.parse_args()

    plugin = args.plugin_dir.expanduser()
    frames_file = plugin / "frames.bin"
    backup = plugin / "frames.bin.bak"

    if args.restore:
        if not backup.exists():
            raise SystemExit(f"no backup at {backup}")
        shutil.copy2(backup, frames_file)
        if not args.no_touch:
            touch_plugin(plugin)
        print(f"Restored {frames_file} from {backup}")
        return

    if not args.source:
        parser.error("source is required unless --restore is set")

    source = Path(args.source).expanduser()
    if not source.exists():
        raise SystemExit(f"source not found: {source}")

    destination = args.output.expanduser() if args.output else frames_file
    if not args.output and frames_file.exists() and not args.no_backup:
        shutil.copy2(frames_file, backup)
        print(f"Backup: {backup}")

    count = build(source, destination, args.width, args.height, args.frames, args.fps, args.dim, args.dim_color)
    size = destination.stat().st_size
    print(f"Wrote {destination}")
    print(f"  frames: {count}")
    print(f"  size:   {args.width}x{args.height}, {size / (1024 * 1024):.1f} MiB")

    if not args.output and not args.no_touch:
        touch_plugin(plugin)
        print("Touched tui.ts; the plugin should hot-reload. If not, run /reload.")


if __name__ == "__main__":
    main()
