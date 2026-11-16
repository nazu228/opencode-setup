# Visual setup

This bundle includes the terminal visuals built for OpenCode on Windows 11:

- **Mitsuha animated wallpaper** for the OpenCode TUI — 28-frame GIF, Braille
  2x4 rendering, per-cell details, glass panels, icon opacity, and the
  `wallpaper-swap` skill for changing the source quickly.
- **Mitsuha theme** — dark base, glass raised surfaces, cyan/blue accents.
- **oc-stats-patched** — the right sidebar dashboard with the clutter removed:
  no project spend, no period spend, no streak/steps, no `/oc_stats` link.
  The session section keeps spend/tokens/cache; the period section keeps
  tokens/calls. Limits are in a blue glass footer.
- **Glass** — the whole right sidebar uses a stronger glass mix; the
  `/oc_stats` window uses glass while it is open.
- **Windows Terminal** is installed when `winget` is available.

## Install

Requirements: Windows 10/11, PowerShell, Node.js 22+, Python 3.10+, Git,
winget, and OpenCode 2.x.

```powershell
$zip = "$env:TEMP\opencode-setup.zip"
$dir = "$env:TEMP\opencode-setup"
Invoke-WebRequest "https://github.com/nazu228/opencode-setup/archive/refs/heads/main.zip" -OutFile $zip
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $dir -Force
& "$dir\opencode-setup-main\install.ps1"
```

The installer backs up `~/.config/opencode`, copies the visual plugins, the
`mitsuha` theme, and the `wallpaper-swap` skill, merges `cli.json`, and tries
to install Windows Terminal.

Finish Context7 authorization if it shows a device code, then open a new
**Windows Terminal** tab and run:

```powershell
wt.exe -d "C:\path\to\project" opencode
```

Alternatively open Windows Terminal and run `opencode` there. A TUI restart
loads the theme and TUI plugins.

## Controls

- `/wallpaper` — toggle the animated background.
- `/wallpaper icons 0-100` — icon opacity (default 65).
- `/wallpaper panel 0-100` — normal panel opacity (default 60; sidebar and
  stats dialog use a stronger glass mix internally).
- `/oc_stats` or the command palette — open the stats dashboard.
- Ask the `wallpaper-swap` skill to change the wallpaper from a GIF, video,
  image, or folder. It writes `frames.bin` and hot-reloads the plugin.

The current wallpaper plugin uses Braille 2x4 at 25 fps and `BRIGHTNESS = 1.15`.
For lower CPU, set `FPS` to 18-20 in
`~/.config/opencode/plugins/mitsuha-wallpaper/tui.ts`. If Braille renders as
boxes, use a font with Braille coverage or revert to quadrants.

## Files

- `~/.config/opencode/plugins/mitsuha-wallpaper/` — wallpaper plugin and
  `frames.bin`.
- `~/.config/opencode/themes/mitsuha.json` — theme.
- `~/.config/opencode/plugins/oc-stats-patched/` — stats sidebar and
  `/oc_stats`.
- `~/.config/opencode/skills/wallpaper-swap/` — swap skill and script.
- `~/.config/opencode/cli.json` — theme selection (`mitsuha`, dark).
