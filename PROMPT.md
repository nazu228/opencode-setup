Установи мой OpenCode setup из GitHub: https://github.com/nazu228/opencode-setup.

1. Скачай https://github.com/nazu228/opencode-setup/archive/refs/heads/main.zip в `%TEMP%\opencode-setup.zip` и распакуй в `%TEMP%\opencode-setup`.
2. Запусти `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\opencode-setup\opencode-setup-main\install.ps1"`.
3. Если Context7 попросит подтвердить устройство — покажи мне код и ссылку, дождись подтверждения и продолжи.
4. Не трогай `service.json` и не перезаписывай существующие `AGENTS.md` / `DECISIONS.md` — только добавь отсутствующее.
5. Не добавляй API-ключи и пароли в файлы бандла.
6. В конце проверь `opencode plugin list`, `graphify --version`, `plannotator --version`, `opencode debug agents` и скажи, что нужно перезапустить TUI.
7. Если провайдер ещё не подключён — напомни мне выполнить `opencode auth login`.

Если установщик упадёт — покажи ошибку и продолжи по разделу «Ручная установка» в README репозитория.
