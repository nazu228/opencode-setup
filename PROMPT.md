Установи мой переносимый набор OpenCode из папки `C:\Users\admin\opencode-setup` (если папка лежит в другом месте — найди её рядом с этим файлом).

Прочитай `README.md` и `install.ps1`, затем выполни установку на Windows:

1. Сделай backup `~/.config/opencode`.
2. Запусти `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`.
3. Если Context7 попросит подтвердить устройство — покажи мне код и ссылку, дождись подтверждения и продолжи.
4. Не трогай `service.json` и не перезаписывай существующие `AGENTS.md` / `DECISIONS.md` — только добавь отсутствующее.
5. Не добавляй API-ключи и пароли в файлы бандла.
6. В конце проверь `opencode plugin list`, `graphify --version`, `plannotator --version`, `opencode debug agents` и скажи, что нужно перезапустить TUI.
7. Если провайдер ещё не подключён — напомни мне выполнить `opencode auth login`.

Если установщик упадёт — не гадай, покажи ошибку и продолжи по разделу «Ручная установка» в `README.md`.
