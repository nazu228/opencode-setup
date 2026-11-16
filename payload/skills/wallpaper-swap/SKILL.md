---
name: wallpaper-swap
description: "Quickly change the OpenCode TUI wallpaper in the mitsuha-wallpaper plugin from a GIF, image, video, or folder of frames, restore the previous wallpaper, and tune pre-dim/brightness. Use when the user asks to swap, change, update, or restore the animated background/wallpaper."
---

# Wallpaper swap

Replace the frame data for the OpenCode TUI wallpaper plugin without touching
the theme or `cli.json`.

## Fast path

From PowerShell:

```powershell
python "$env:USERPROFILE\.config\opencode\skills\wallpaper-swap\scripts\swap.py" "C:\path\to\wallpaper.gif"
```

The script:

- converts GIF/video/image/folder input to **480x270 RGBA** frames;
- pre-dims by **34%** toward `#070c18` (the current readable look);
- writes `~/.config/opencode/plugins/mitsuha-wallpaper/frames.bin` atomically;
- backs up the old file to `frames.bin.bak`;
- touches `tui.ts` so the plugin hot-reloads.

Wait a few seconds. If the wallpaper does not change, run `/reload` or restart
OpenCode.

## Inputs

- GIF (all frames, resampled down to `--frames`)
- video: `.mp4`, `.webm`, `.mov`, `.mkv`, `.avi` (uses `ffmpeg`)
- still image: `.png`, `.jpg`, `.webp`, ... (one frame; the plugin stops its
  animation timer for a single-frame file)
- folder of image frames (sorted by filename)

## Options

```text
--frames 56          maximum frames (default 56)
--fps 25             video sampling FPS
--dim 0.34           pre-dim strength, 0..1 (0 = original brightness)
--dim-color 070c18   color to dim toward
--no-backup          do not write frames.bin.bak
--no-touch           do not touch tui.ts
--output PATH        write somewhere else, useful for testing
--plugin-dir PATH    non-default plugin directory
--restore            copy frames.bin.bak back and reload
```

Examples:

```powershell
# Another GIF, keep the current brightness
python "$env:USERPROFILE\.config\opencode\skills\wallpaper-swap\scripts\swap.py" "C:\Users\admin\Downloads\another.gif"

# Video at 25 fps, darker
python "$env:USERPROFILE\.config\opencode\skills\wallpaper-swap\scripts\swap.py" "D:\clips\scene.mp4" --fps 25 --dim 0.28

# Static image
python "$env:USERPROFILE\.config\opencode\skills\wallpaper-swap\scripts\swap.py" "D:\pictures\wall.png"

# Restore the previous wallpaper
python "$env:USERPROFILE\.config\opencode\skills\wallpaper-swap\scripts\swap.py" --restore
```

## Current plugin facts

- Path: `~/.config/opencode/plugins/mitsuha-wallpaper`
- Renderer: post-process, Braille 2x4 (8 dots per cell), 25 fps, no pauses in
  the current customized version, `BRIGHTNESS = 1.15`, panel glass and icon
  opacity settings.
- `frames.bin` format: `MTSH`, version `1`, frame count, width, height, then
  RGBA frames. The reader hard-checks **480x270**; do not change `--width` /
  `--height` unless you also update `FRAME_W` / `FRAME_H` in `tui.ts`.
- `frames.bin` is not an import, so the plugin's watcher does not see it by
  itself. The script's `tui.ts` marker is what triggers the reload.
- The theme `~/.config/opencode/themes/mitsuha.json` and `cli.json` are not
  touched by this skill.

## Tuning after a swap

- `/wallpaper` toggles the wallpaper.
- `/wallpaper panel 45` gives more glass (the current default is 60% panel /
  40% background).
- `/wallpaper icons 65` changes icon opacity (0-100).
- To change playback speed, edit `FPS` in `tui.ts` (25 = native GIF speed;
  18-20 lowers CPU).
- To change global brightness, edit `BRIGHTNESS` in `tui.ts`; to change the
  source dim, use `--dim` in the script. Do not double-dim and then raise
  `BRIGHTNESS` unless that is the intent.

## Verify

1. Check the OpenCode log for `plugin reconciliation completed`.
2. Look at the TUI: wallpaper visible, text readable, panels still glassy.
3. Measure CPU if the terminal is large: 25 fps is the heaviest setting. Lower
   `FPS` to 18-20 if needed.
4. If Braille dots show as boxes, the terminal font lacks Braille glyphs.
   Change the font or ask to revert the renderer to quadrants; do not silently
   change the plugin's look.

## Restore

`--restore` restores `frames.bin.bak`. If no backup exists, re-run the script
with the original source.
