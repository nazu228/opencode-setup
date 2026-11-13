# OpenCode setup bundle

Переносимый набор моих плагинов, агентов, скиллов и команд для OpenCode 2 на Windows.

## Что внутри

| Компонент | Что делает |
|---|---|
| **CC Safety Net** | Блокирует `rm -rf`, `git reset --hard`, `curl \| bash`, чтение секретов. Режим `standard` |
| **Plannotator** | Визуальное ревью планов в браузере: аннотации, approve/request changes, plan diff |
| **Context7** | Скилл `find-docs`: актуальные доки библиотек через `ctx7` CLI |
| **graphify 0.9.108** | Граф кодовой базы: `graph.json`, `graph.html`, `query/path/explain` + скилл и плагин OpenCode |
| **squad v2** | Автономный оркестратор: Lid-план, DAG, отдельный worktree на задачу, verification gate, integration-ветка и отчёт + 5 агентов: `team-lid`, `analyst`, `executor`, `visual-executor`, `critic` |
| **oc-stats-patched** | Локальная исправленная и переведённая на русский версия `oc-stats`: статистика, стоимость, latency в сайдбаре + `/oc_stats` |
| **grilling** | Скилл «прожарки» планов + команда `/grill-me` |
| **graphify command** | Команда `/graphify` для запуска графа |
| **AGENTS.md / SQUAD.md** | Глобальные инструкции и документация squad |

## Требования

- Windows 10/11
- OpenCode 2.x (`opencode --version`)
- Node.js 22+ и npm
- Python 3.10+ (у меня 3.14)
- Git
- Браузер для Plannotator и Context7 OAuth

## Проверенные версии

| Компонент | Версия |
|---|---|
| OpenCode | 2.2.7 |
| cc-safety-net | 2.7.12 |
| @plannotator/opencode | 0.28.62 |
| graphifyy | 0.9.108 |
| oc-stats-patched | 0.2.0 (локальная сборка) |

Версии зафиксированы в `install.ps1` и `merge-config.mjs`. Если нужна свежая — замени `@x.y.z` на `@latest`.

## Установка с GitHub (одной командой)

```powershell
$zip = "$env:TEMP\opencode-setup.zip"; $dir = "$env:TEMP\opencode-setup"
Invoke-WebRequest "https://github.com/nazu228/opencode-setup/archive/refs/heads/main.zip" -OutFile $zip
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $dir -Force
& "$dir\opencode-setup-main\install.ps1"
```

Или вставь агенту содержимое `PROMPT.md` — он сделает то же самое.

## Установка из локальной папки

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

После установки:

```powershell
opencode auth login   # подключить OpenRouter / DeepSeek или другого провайдера
```

Затем перезапусти TUI (закрой и открой OpenCode), чтобы подхватились TUI-плагины.

Скрипт:

1. делает backup `~/.config/opencode`;
2. копирует агентов, команды, скилл `grilling`, плагины `squad` и `oc-stats-patched`;
3. ставит npm-плагины `cc-safety-net` и `@plannotator/opencode`;
4. мержит `opencode.json`, не перезаписывая остальные настройки;
5. ставит бинарник Plannotator;
6. запускает Context7 setup (нужно подтвердить device code в браузере);
7. ставит `graphifyy==0.9.108` и выполняет `graphify install --platform opencode`;
8. проверяет `opencode plugin list`, `graphify --version`, `plannotator --version`.

После установки **перезапусти TUI** (закрой и открой OpenCode), чтобы подхватились TUI-плагины.

## Ручная установка

Если скрипт где-то споткнулся:

```powershell
# 1. Скопировать payload
Copy-Item .\payload\agents\* "$env:USERPROFILE\.config\opencode\agents" -Force
Copy-Item .\payload\commands\* "$env:USERPROFILE\.config\opencode\commands" -Force
Copy-Item .\payload\skills\grilling "$env:USERPROFILE\.config\opencode\skills\grilling" -Recurse -Force
Copy-Item .\payload\plugins\squad "$env:USERPROFILE\.config\opencode\plugins\squad" -Recurse -Force
Copy-Item .\payload\plugins\oc-stats-patched "$env:USERPROFILE\.config\opencode\plugins\oc-stats-patched" -Recurse -Force

# 2. Плагины
opencode plugin add cc-safety-net@2.7.12
opencode plugin add "@plannotator/opencode@0.28.62"
node .\merge-config.mjs "$env:USERPROFILE\.config\opencode"

# 3. Plannotator binary
irm https://plannotator.ai/install.ps1 | iex

# 4. Context7
npx ctx7@latest setup --opencode --cli -y

# 5. graphify
python -m pip install --user graphifyy==0.9.108
python -m graphify install --platform opencode
```

## Что сознательно не входит

- `service.json` — содержит локальный пароль OpenCode, не переносится.
- `auth.json` / API-ключи провайдеров — настраиваются отдельно (`opencode auth`).
- Машинно-зависимые `permissions.external_directory` из моего `opencode.json` — добавь свои пути вручную.
- `opencode-mem` — не используем из-за конфликта с параллельными сессиями на Windows.
- `Alino/opencode-marketplace` — не нужен для solo-работы с глобальными скиллами.

## Примечания

- `oc-stats-patched` — локальная сборка `oc-stats-tui@0.2.0` с исправленным Solid-трансформом и русским UI. Лежит в `~/.config/opencode/plugins/oc-stats-patched`, подхватывается автоматически.
- Context7 при первом запуске попросит подтвердить устройство в браузере. Без этого скилл `find-docs` не получит API-ключ, но CLI всё равно работает с лимитами.
- Plannotator открывает локальный браузер. Если браузер не открылся, скопируй URL из вывода.
- После обновления `@plannotator/opencode` могут понадобиться его команды/скилл; установщик Plannotator обновляет их сам.
