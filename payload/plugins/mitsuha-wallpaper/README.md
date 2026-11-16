# Mitsuha wallpaper

Animated terminal wallpaper for the OpenCode TUI, built from
`99px_ru_animacii_42596_za_mig_do_katastrofi_micuha_mijamidzu__mitsuha.gif`.

## How it works

- `frames.bin` stores 28 pre-dimmed 480x270 RGBA frames. No PNG decoding
  happens while the TUI is running.
- `tui.ts` registers a `renderer.addPostProcessFn` compositor. It replaces
  only neutral background cells with pre-computed quadrant-block art; text,
  panels, dialogs, selections and diff colors are preserved.
- The animation advances at 4 fps when idle, 1 fps while an agent or subagent
  is working, 2 fps after 30 s without activity, and freezes for 1.2 s after
  any keypress. It also stops while the terminal window is not focused.
- Panels get a glass tint (`panel`, default 60% panel / 40% wallpaper).
- Icon-like Unicode symbols (arrows, geometric shapes, dingbats, technical
  symbols, braille spinners, PUA) are blended toward their cell background
  (`icons`, default 65% opacity). Box drawing, block elements and regular text
  are left alone.
- The cursor cell is never painted over.
- No transparent-root hack and no theme requirement: this works over the
  normal OpenCode background.

## Commands

- `/wallpaper` or **Mitsuha wallpaper** in `Ctrl+P` — toggle on/off.
- `/wallpaper on` / `/wallpaper off`
- `/wallpaper icons 0-100` — icon opacity.
- `/wallpaper panel 0-100` — panel opacity (100 = fully opaque panels).

Settings persist through restarts.

## Terminal

Windows Terminal is installed. It batches frames with synchronized output, so
the prompt cursor stays steady while the wallpaper animates. Classic conhost
can still show the upstream per-frame cursor hide/show from OpenTUI; the
typing pause and low FPS make it much less visible there.

To use it, open Windows Terminal and run `opencode` (or
`wt.exe -d <project> opencode`). A TUI restart also applies the bundled
`mitsuha` theme (`~/.config/opencode/themes/mitsuha.json`) with an opaque base
and glass panels.

## Tuning

- `IDLE_FPS`, `BUSY_FPS`, `SAVER_FPS`, `INPUT_PAUSE_MS` in `tui.ts`.
- `IDLE_MS` (30 s) controls when saver mode starts.
- Rebuild `frames.bin` if you want different brightness or source frames.
- `tui.image.bak` is the previous `ImageRenderable` implementation, kept only
  as a rollback reference; it is not loaded.
