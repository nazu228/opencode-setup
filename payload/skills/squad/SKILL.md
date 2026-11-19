---
name: squad
description: "Use before every OpenCode Squad / /squad / squad tool call. Turns a vague coding request into a safe Squad brief: decides whether Squad fits, splits work into independent vertical slices, assigns analyst/executor/visual-executor/critic roles, defines file ownership, contracts, dependencies and checks, and writes the exact task prompt for Lid. Also use when the user says «запусти сквад», «распредели роли», «сделай параллельно», «squad», or when Squad output looks chaotic."
---

# Squad: планирование и запуск

Ты — **диспетчер**, а не планировщик. Твоя задача — превратить запрос пользователя в такой brief, чтобы Lid собрал корректный план, а агенты не мешали друг другу. **Никогда не вызывай `squad` с одной vague-строкой.** Одна строка — главная причина каши: Lid сам придумывает роли, файлы, зависимости и проверки.

> Этот skill предназначен для parent-модели, которая вызывает `squad`. Если его читает Lid, используй разделы 3–6 как чек-лист плана, но не вызывай `squad` повторно.

## Быстрый алгоритм

1. Прочитай репозиторий и `AGENTS.md`; не спрашивай то, что можно найти.
2. Реши, нужен ли вообще Squad; маленькую/последовательную задачу не дроби.
3. Нарисуй ownership map: задача → файлы → роль → зависимости → checks.
4. Выбери минимум ролей; shared-файлы — один владелец или contract.
5. Напиши структурированный brief с acceptance и проверками.
6. Только теперь вызывай `squad`; `agents` = задачи + contract-слот.
7. После run проверь `squad_status`, отчёт, gate, diff и warnings.

## 0. Жёсткий gate перед запуском

Не вызывай `squad`, пока не можешь ответить на все пункты:

1. Есть **2+ независимых потока работ** с непересекающимися файлами, **или** один сложный builder, которому нужен отдельный analyst/critic, **или** это явно read-only исследование.
2. Для каждого builder-а известна зона файлов: точный путь или `путь/**`.
3. Известны реальные команды проверки.
4. Понятно, какие роли нужны и какие не нужны.
5. Известны ветка/база, бюджет и лимит времени.
6. Ты прочитал `AGENTS.md`, `DECISIONS.md` (если есть), скрипты пакета и, если есть, `graphify-out/GRAPH_REPORT.md`.
7. `squad_status` не показывает активный run, который конфликтует с этим parent; `git status` не содержит чужих незакоммиченных изменений, а base ref существует.

Если пункт неизвестен — сначала исследуй репозиторий. Спроси пользователя только то, что нельзя узнать из кода/конфига, и не больше 3 вопросов за раз. Если задача маленькая или последовательная — **не запускай Squad**, используй обычного агента.

## 1. Подходит ли Squad

| Ситуация | Решение |
|---|---|
| Одна небольшая правка, один модуль, < 2 независимых потоков | обычный агент, не Squad |
| Несколько модулей/фич, разные файлы, можно делать параллельно | Squad, обычный режим |
| Все шаги строго последовательны и меняют одни файлы | один `executor` + при необходимости `critic`, без искусственного параллелизма |
| Много однотипных независимых правок | `--batch`, только builders |
| Только исследование/аудит, без правок | `--analysis-only` (`allow_readonly: true`), analysts/critics |
| Общие типы/интерфейсы у 2+ builders | Contract-First, `contracts: true` |
| UI + core в одном продукте | отдельные зоны: `visual-executor` и `executor`, без пересечения файлов |
| Задача требует push/deploy/merge | Squad не делает это; вынести в отдельный шаг после ревью |

Не увеличивай число агентов «для скорости». Больше агентов — больше токенов, конфликтов и ложных зависимостей. Обычно достаточно **2–5 задач**; 8–12 — только если действительно есть 8–12 независимых зон.

## 2. Что выяснить до brief

Сначала посмотри в код, потом спрашивай:

- **Цель:** какой наблюдаемый результат должен работать.
- **Границы:** что входит и что явно не входит.
- **Файлы:** где живёт код, тесты, UI, конфиги; какие файлы общие.
- **Контракты:** общие типы, API, схемы, события, design tokens.
- **Проверки:** `package.json` scripts, `Cargo.toml`, `go.mod`, `pyproject.toml`, CI, `AGENTS.md`.
- **Риски:** миграции, секреты, generated-код, lock-файлы, публичные API.
- **Ограничения:** ветка, бюджет, время, «не трогать X».
- **UI:** есть ли визуальная часть и кто её владелец.

Полезные источники: `AGENTS.md`, `DECISIONS.md`, `graphify-out/GRAPH_REPORT.md`, `package.json`, `Makefile`, `.github/workflows`, существующие тесты. Если `graphify-out` есть — сначала `graphify query`/`path`/`explain`, а не гадай по именам.

## 3. Роли: кого и зачем

`team-lid` — внутренняя роль оркестратора. **Не назначай её task-ролью** и не проси несколько Lid.

| Роль | Когда использовать | Права | Чего не делать |
|---|---|---|---|
| `analyst` | незнакомый код, аудит, поиск причин, сбор фактов | read-only, без `files` | не писать код и не обещать файлы |
| `executor` | core-логика, API, данные, рефакторинг, тесты модуля | edit/shell в своём worktree | не брать UI-зону и чужие файлы |
| `visual-executor` | UI/UX, компоненты, стили, вёрстка, доступность | edit/shell в своём worktree | не менять core-логику без нужды |
| `critic` | независимый review после интеграции | read-only, без `files` | не исправлять код, только findings |

Правила:

- Implementation и его тесты — **один builder**. Не создавай отдельную test-задачу с теми же файлами.
- Документацию/README/ADR пишет `executor`, а не `analyst`: analyst read-only и не может создать файл.
- `visual-executor` и `executor` не должны владеть одним компонентом/стилями. Если UI и логика связаны — раздели по файлам или сделай одну задачу.
- Analyst нужен, когда есть реальная неопределённость. Если ты уже знаешь код — не добавляй его «для солидности».
- Critic нужен для нетривиального изменения. Он выполняется после integration и может дать `blocking: true`.
- Роли в tool `roles` — это **разрешённое множество**, а не количество агентов. Количество задач задаёт Lid в плане; ограничивай его через `agents`.

## 4. Декомпозиция: вертикальные slices

Хорошая задача — это **работающий инкремент**, а не «слой»:

- Плохо: `types`, `service`, `controller`, `tests` как четыре отдельные задачи.
- Хорошо: `auth-core` (логика + unit-тесты), `auth-api` (endpoint + integration-тест), `auth-ui` (форма + component-тест), `review` (critic).

Правила файлов:

- `files`: только **точный путь**, `путь/**` или `**`. Запрещены `*.ts`, `**/auth.ts`, `src/auth*`.
- Только относительные пути внутри проекта: без absolute paths и без `..`; регистр должен совпадать с файлами на диске.
- Для директории используй `src/auth/**`; exact path `src/auth` означает файл, не директорию.
- Зоны builder-ов не должны пересекаться. Проверяй это до запуска.
- `package.json`, lock-файлы, `Cargo.toml`, миграции, generated-код, общие конфиги — **shared**. Один владелец или contract-задача.
- Analyst/critic: `files` всегда пустой.
- Не давай всем `**`: это отключает ownership и снова превращает run в кашу.

Зависимости:

- `dependsOn` — только реальная зависимость по коду/контракту, не «чтобы было по порядку».
- Если B нужен результат A — B зависит от A. Если B зависит от A и C — перечисли оба.
- Независимые задачи не должны иметь `dependsOn`, иначе теряется параллелизм.
- Contract-задача автоматически становится зависимостью builders. Не добавляй её вручную в `dependsOn`, если она создаётся плагином.
- Помни: `agents` — это максимум задач, и synthetic contract-задача тоже занимает слот. При contracts задавай `agents` = число планируемых задач + 1.

Contract-First:

- Включай, когда 2+ builder-а делят типы, интерфейсы, API-контракт или общий модуль.
- `contracts` — точные пути contract-файлов; они **не должны** входить в `files` builders.
- Contract-задача пишет только контракты и не реализует бизнес-логику.
- Обычно contract-задачу создаёт плагин; не заказывай её отдельно. Если задача всё же явная, у неё `contract: true`, `files` = только контракты, без business logic.
- Если contract-задача меняет lock/generated-файлы, перечисли и их; иначе strict ownership даст `ownership_violation`.
- Не включай contracts в batch.

Batch:

- Только `executor`/`visual-executor`, только независимые задачи.
- `dependsOn: []`, непересекающиеся `files`, без shared-файлов, без contracts.
- `checks` обязательны у каждой задачи.
- Batch не запускает analysts/critics; review делай отдельным обычным run при необходимости.

## 5. Формула task prompt

Ты не пишешь промпт каждому executor напрямую: ты даёшь brief Lid, а Lid создаёт `instructions` для задач. Поэтому в brief должны быть все факты, которые обязаны попасть в эти `instructions`.

Каждая задача должна быть самодостаточной для агента, который не видел твой чат. В brief для Lid (и в итоговом `instructions`) должны быть:

1. **Контекст/зачем** — какую проблему решаем.
2. **Что именно сделать** — поведение, а не только имя файла.
3. **Границы** — какие файлы/модули можно менять, что нельзя.
4. **Подход/ограничения** — существующие паттерны, API, стиль, совместимость.
5. **Edge cases** — ошибки, пустые состояния, конкурентность, миграции.
6. **Тесты** — какие сценарии покрыть и где.
7. **Acceptance** — 2–5 наблюдаемых критериев.
8. **Checks** — точные команды, локальные для задачи.
9. **Out of scope** — что специально не делать.

`acceptance` — это проверяемый результат, не «сделай хорошо». Плохо: «код качественный». Хорошо: «повторный login с тем же refresh token возвращает 401», «форма показывает ошибку при пустом email».

`checks` — реальные команды, которые можно выполнить в worktree:

- `npm test -- test/auth`
- `npm run typecheck`
- `cargo test -p auth`
- `go test ./internal/auth/...`
- `pytest tests/auth`
- `bun test src/auth`

Не пиши `cd ...`, не используй глобальные команды, не выдумывай скрипты. Если не знаешь — прочитай `package.json`/CI. Глобальная проверка задаётся отдельно в `verify`.

`requiresTests: true` ставь только для задач, меняющих поведение. Если включён `strict_tests`, тестовый файл должен реально измениться в diff; иначе задача упадёт.

## 6. Brief для Lid

Передавай в `squad.task` не одну строку, а структурированный бриф. Не вставляй туда готовый JSON-план: Lid сам вернёт JSON. Brief — это текст с требованиями и предлагаемой декомпозицией; JSON ниже в skill используй для self-check и как образец того, что должен получить Lid.

Шаблон:

```text
Цель:
<наблюдаемый результат>

Контекст:
<где код, какие паттерны, что уже есть>

База:
origin/dev

Границы:
- Входит: ...
- Не входит: ...

Роли и зоны (предлагаемая декомпозиция):
1) executor auth-core
   files: src/auth/core/**, test/auth/core/**
   dependsOn: []
   сделать: ...
   acceptance: ...
   checks: ...
2) executor auth-api
   files: src/api/auth/**, test/api/auth/**
   dependsOn: auth-core
   ...
3) visual-executor auth-ui
   files: src/ui/auth/**, test/ui/auth/**
   dependsOn: auth-api
   ...
4) critic review
   files: []
   dependsOn: [все builder-ы]

Контракты:
- src/auth/types.ts
(использовать contract-first; contract-файлы не включать в files builders)

Общие файлы:
- package.json / lockfile: <кто владелец или contract>

Проверки:
- глобально: npm test, npm run typecheck
- локально: ...

Бюджет/время:
max_cost_usd=..., max_run_minutes=...

Не делать:
- не трогать ...
- не делать push/deploy
```

Поясняй Lid, что декомпозиция **предлагаемая**, но ограничения по файлам, контрактам и ролям обязательны. Если Lid добавит лишние задачи или пересечёт файлы — это ошибка плана, а не повод запускать.

## 7. Вызов `squad`

Предпочитай tool `squad`; `/squad` — для TUI, не запускай его через shell. Если пользователь вводит `/squad` напрямую, команда уходит в плагин без участия модели — этот skill тогда не применяется. Чтобы он сработал, попроси модель подготовить brief и вызвать tool; либо вставь готовый структурированный brief в `/squad`. Типовой вызов:

```json
{
  "task": "<структурированный brief выше>",
  "agents": 5,
  "roles": "executor,visual-executor,critic",
  "concurrency": 4,
  "timeout_minutes": 30,
  "base": "origin/dev",
  "verify": ["npm test", "npm run typecheck"],
  "contracts": true,
  "local_gate": "auto",
  "build_concurrency": 2,
  "max_cost_usd": 5,
  "max_run_minutes": 60
}
```

Параметры:

- `agents` — максимум задач; normal 1–12, batch 1–20. Не ставь 8 «на всякий случай».
- `roles` — множество разрешённых ролей; если critic не нужен, не включай его.
- `concurrency` — параллельные задачи, 1–12; для тяжёлых сборок начинай с 2–4.
- `timeout_minutes` — таймаут агента, 1–120; для больших сборок 30–60.
- `base` — `origin/dev` по умолчанию; проверь, что ref существует.
- `verify` — глобальные команды; если не указаны, plugin попробует определить сам.
- `contracts` — boolean; пути контрактов идут в brief/плане, не в этот параметр.
- `batch` — только для независимых builder-задач; analysts/critics/contracts запрещены.
- `local_gate` — `auto` выполняет `task.checks`; `strict` использует checks, а при их отсутствии — global verification; `off` отключает локальный gate, но integration gate остаётся.
- `strict_tests` — только если реально меняются тесты; иначе будут ложные `tests_missing`.
- `build_concurrency` — общий лимит локальных/integration gate; 2–3 для тяжёлых сборок.
- `max_cost_usd`, `max_total_tokens`, `max_run_minutes` — бюджет; ставь явно для больших run.
- `ideal` — до 8 раундов исправлений вместо 2; только для действительно сложных задач, это дороже.
- `cleanup_on_failure` — удалить worktrees/ветки даже при failed run; не включай, если нужен разбор.
- `keep_worktrees` — для отладки; иначе cleanup.
- `allow_readonly` — для analysis-only run без builders.

Model routing читается из `squad.json`; если файла нет, роли наследуют parent model. Не обещай «дешёвый» routing, пока конфиг не настроен.

## 8. Проверка плана перед запуском

Пройди self-check:

- [ ] Каждая builder-задача имеет непустой `files`.
- [ ] Ни одна пара builder-файлов не пересекается.
- [ ] Нет `*.ts`, `**/auth.ts`, `src/auth*`; директории — только `путь/**`.
- [ ] Analyst/critic имеют `files: []`.
- [ ] Shared-файлы имеют одного владельца или contract.
- [ ] Contract-файлы не входят в `files` builders.
- [ ] `agents` = число задач + contract-слот (если хочешь контроль, не завышай лимит).
- [ ] `dependsOn` отражает только реальные зависимости.
- [ ] У каждого builder-а есть `checks` или понятная глобальная проверка.
- [ ] `acceptance` наблюдаемый, а не «сделай качественно».
- [ ] `requiresTests` не противоречит `strict_tests`.
- [ ] Есть бюджет/время.
- [ ] Нет push/deploy/merge в задаче.

Если чек-лист не проходит — исправь brief **до** `squad`. Не проси Lid «как-нибудь разобраться».

## 9. После run

1. `squad_status` — проверь `delivered`/`failed`, gate, spend, задачи.
2. Прочитай `SQUAD_REPORT.md` и `.squad/runs/<id>/`.
3. Проверь ветку и diff; не доверяй только summary.
4. Учти warnings `ownership_violation`, `tests_missing`, provider errors.
5. Для critic findings: blocking=true означает, что run не должен считаться принятым.
6. Не делай push/deploy/merge без отдельного решения пользователя.
7. Если run failed — не перезапускай ту же vague-задачу; сначала пойми, что сломалось в плане.

## 10. Анти-паттерны

- `squad({task: "сделай auth"})` — Lid сам придумает всё, включая конфликтующие файлы.
- «Поставь 8 агентов, будет быстрее» — больше координации, не больше скорости.
- Один и тот же файл у `executor` и `visual-executor`.
- Analyst с `files` или ожиданием, что он создаст документацию; для docs нужен `executor`.
- Critic, который «заодно исправит».
- Отдельная test-задача на те же файлы, что implementation.
- `dependsOn` на всё подряд — параллелизм исчезает.
- Фиктивные `checks` (`npm test` в проекте без npm) — gate падает или врёт.
- `contracts` без перечисления lock/generated-файлов — strict ownership ловит violation.
- Batch с `package.json`, contracts или shared-стилями.
- `strict_tests`, когда тесты не меняются.
- `files: ["**"]` у нескольких задач — ownership бессмысленен.
- Запуск `/squad` рекурсивно из squad-агента.

## 11. Короткий пример

Пользователь: «Добавь JWT-авторизацию, раздели work».

Плохо:

```text
squad({task: "Добавь JWT-авторизацию, 4 агента"})
```

Хорошо:

```json
{
  "task": "Цель: JWT login/refresh с тестами и UI формой.\nБаза: origin/dev.\nГраницы: только src/auth/**, src/api/auth/**, src/ui/auth/**, test/**. Не трогать billing и migrations.\nПредлагаемые задачи:\n1) executor auth-core: files src/auth/core/**, test/auth/core/**; dependsOn []; checks npm test -- test/auth/core; acceptance ...\n2) executor auth-api: files src/api/auth/**, test/api/auth/**; dependsOn [auth-core]; checks npm test -- test/api/auth; acceptance ...\n3) visual-executor auth-ui: files src/ui/auth/**, test/ui/auth/**; dependsOn [auth-api]; checks npm test -- test/ui/auth; acceptance ...\n4) critic review: files []; dependsOn [auth-core,auth-api,auth-ui]; findings JSON.\nКонтракты: src/auth/types.ts; contract-файл не включать в files builders.\nПроверки: npm test, npm run typecheck.\nБюджет: max_run_minutes=60, max_cost_usd=5.\nНе делать: push/deploy, изменения billing.",
  "agents": 5,
  "roles": "executor,visual-executor,critic",
  "concurrency": 3,
  "base": "origin/dev",
  "verify": ["npm test", "npm run typecheck"],
  "contracts": true,
  "local_gate": "auto",
  "build_concurrency": 2,
  "max_run_minutes": 60,
  "max_cost_usd": 5
}
```

`agents: 5` — четыре задачи + contract-слот. Если contract не нужен, `agents: 4`.

## 12. Главное правило

**Сначала ownership map и acceptance, потом запуск.** Если ты не можешь нарисовать таблицу «задача → файлы → проверка → зависимость», ты ещё не готов вызывать Squad.
