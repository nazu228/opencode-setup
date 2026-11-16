Ты — агент на Windows 11. Разверни мой OpenCode visual setup из GitHub-репозитория:

https://github.com/nazu228/opencode-setup

Цель: установить OpenCode 2.x со всеми моими настройками, TUI-плагинами, анимированным фоном, темой, статистикой, скиллом для смены фона и Windows Terminal.

Требования: Windows 11, PowerShell, Node.js 22+, Python 3.10+, Git, winget, OpenCode 2.x. Если OpenCode не установлен — установи его штатным способом и проверь `opencode --version`.

Порядок:

1. Скачай и распакуй репозиторий:
   ```powershell
   $zip = "$env:TEMP\opencode-setup.zip"
   $dir = "$env:TEMP\opencode-setup"
   Invoke-WebRequest "https://github.com/nazu228/opencode-setup/archive/refs/heads/main.zip" -OutFile $zip
   Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
   Expand-Archive $zip $dir -Force
   ```
2. Запусти установщик:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$dir\opencode-setup-main\install.ps1"
   ```
3. Установщик должен:
   - сделать backup `~/.config/opencode`;
   - поставить `cc-safety-net`, `@plannotator/opencode`, `squad`, `oc-stats-patched`, `graphifyy`, Context7 и глобальный `wallpaper-swap` skill;
   - скопировать плагин `mitsuha-wallpaper` с `frames.bin` и темой `mitsuha`;
   - смержить `cli.json` (тема `mitsuha`, dark, animations);
   - поставить Windows Terminal через winget, если его ещё нет.
4. Заверши device-code авторизацию Context7, если установщик её запросит.
5. Открой **Windows Terminal** и запусти OpenCode в проекте:
   ```powershell
   wt.exe -d "C:\path\to\project" opencode
   ```
   Либо открой Windows Terminal и выполни `opencode`.
6. Проверь визуал:
   - фон Mitsuha анимируется;
   - правая панель статистики полупрозрачная, в ней нет Project / period spend / Серия / Шаги / «открыть /oc_stats»;
   - лимиты аккаунтов внизу синие, без мигания, с широкими полосами;
   - `/oc_stats` открывается и тоже выглядит стеклянным;
   - `/wallpaper`, `/wallpaper icons 65`, `/wallpaper panel 60` работают;
   - курсор в prompt не дёргается.
7. Если что-то не установилось — покажи точную ошибку, проверь `README.md`, `VISUALS.md`, `opencode plugin list`, `opencode service status`. Не ломай существующие проекты и не коммить ничего в мои репозитории без запроса.

В конце дай краткий отчёт: что установлено, какие версии, где лежат плагины/тема/скилл, какие проверки прошли, и что осталось сделать вручную (например, авторизация или перезапуск TUI).
