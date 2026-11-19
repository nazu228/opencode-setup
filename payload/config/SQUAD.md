# Squad v2 — архитектура и эксплуатация

## Принципы

1. **Основное дерево неприкосновенно.** Все пишущие агенты работают в отдельных git worktree. В проект попадают только cherry-pick успешных коммитов в integration-ветку.
2. **Нет зелёного gate — нет успеха.** Run не может быть `delivered`, если verification не прошла.
3. **Упавший агент не интегрируется.** Патч таймаутного/упавшего builder остаётся в worktree для разбора, но не попадает в ветку.
4. **Lid планирует и отвечает.** Lid строит JSON-план, решает вопросы, чинит интеграционные ошибки. Он не пишет основную массу кода.
5. **Один run — один branch + artifacts.** Run закрывается после выдачи; правки — новый run поверх предыдущей ветки.

## Быстрый старт

```text
/squad 4 Добавь авторизацию через JWT и тесты
/squad --agents 6 --ideal --verify "npm test" Отрефактори модуль оплаты
/squad 5 --roles analyst,executor,visual-executor,critic Сделай страницу товара
```

Поддерживаются оба синтаксиса: `4 задача` и `--agents 4 задача`.

| Команда | Что делает |
| --- | --- |
| `/squad [флаги] <задача>` | Запуск отряда |
| `/squad-status [run-id]` | Статус последнего или указанного run |
| `/squad-answer <question-id> <ответ>` | Ответ на вопрос агента |
| `/squad-cancel [run-id]` | Отмена активного run |

## Флаги

| Флаг | Что делает |
| --- | --- |
| `--agents N` / `N` | Число задач, 1–12 (в `--batch` до 20). По умолчанию 8 |
| `--roles a,b,c` | Порядок ролей. По умолчанию `analyst,executor,visual-executor,critic` |
| `--concurrency N` | Параллельных задач, 1–12. По умолчанию 8 |
| `--timeout N` | Таймаут агента в минутах, 1–120. По умолчанию 15 |
| `--base ref` | Базовая ветка/ref |
| `--verify "cmd"` | Verification-команда; можно повторять |
| `--ideal` | До 8 раундов фиксов вместо 2 |
| `--contracts` / `--no-contracts` | Включить/выключить contract-фазу |
| `--batch` | Независимый batch-режим, до 20 задач |
| `--local-gate auto\|strict\|off` | Локальный gate builders. По умолчанию `auto` |
| `--cleanup-on-failure` | Удалять worktrees даже при failed run |
| `--analysis-only` / `--allow-readonly` | Run без builders |
| `--strict-tests` | Падать, если у задачи `requiresTests`, а тестов нет |
| `--build-concurrency N` | Семафор локальных/integration gate, 1–12 |
| `--max-cost USD` | Бюджет стоимости run |
| `--max-tokens N` | Бюджет токенов run |
| `--max-minutes N` | Бюджет времени run |

Инструмент `squad` принимает те же параметры в snake_case: `agents`, `roles`, `concurrency`, `timeout_minutes`, `ideal`, `base`, `verify`, `keep_worktrees`, `contracts`, `batch`, `local_gate`, `cleanup_on_failure`, `allow_readonly`, `strict_tests`, `build_concurrency`, `max_cost_usd`, `max_total_tokens`, `max_run_minutes`.

## Поток

```text
/squad
  -> assertSafeProject + git repo check
  -> resolveBase: origin/dev -> origin HEAD -> HEAD
  -> RunStore: .squad/runs/<run-id>/{state.json,events.jsonl}
  -> Lid plan (team-lid session)
  -> analysts (read-only, repo; в batch пропускаются)
  -> contract-фаза (если есть contracts)
  -> builders (DAG, per-task worktree+branch)
  -> local gate каждой задачи (checks в worktree)
  -> integration branch + cherry-pick successful commits
  -> verification gate
  -> triage упавшего gate + targeted fix
  -> Lid fix rounds (2 / 8 ideal)
  -> critics (read-only, integration worktree)
  -> SQUAD_REPORT.md + branch
  -> cleanup worktrees, keep branch + artifacts
```

## Роли

| Роль | Где работает | Права |
| --- | --- | --- |
| `team-lid` | проект / integration worktree | план, вопросы, фиксы интеграции |
| `analyst` | проект | read-only |
| `executor` | свой worktree | код, тесты |
| `visual-executor` | свой worktree | UI/UX, стили, доступность |
| `critic` | integration worktree | read-only ревью |

## План Lid

```json
{
  "summary": "кратко",
  "base": "origin/dev или null",
  "ideal": false,
  "verification": ["npm test"],
  "contracts": ["src/types/api.ts"],
  "tasks": [
    {
      "id": "api",
      "title": "Auth API",
      "role": "executor",
      "files": ["src/auth/**", "test/auth/**"],
      "dependsOn": [],
      "instructions": "что сделать",
      "acceptance": ["что должно быть верно"],
      "checks": ["npm test -- auth"],
      "requiresTests": true
    }
  ]
}
```

Валидация:

- 1–12 задач, в `--batch` до 20;
- роли только из разрешённых;
- `dependsOn` без циклов и неизвестных id;
- у builder-задач есть `files`;
- `files`/`contracts` — только точный путь, `путь/**` или `**`;
- владения builder-задач не пересекаются;
- `verification` может быть пустым — тогда команды определяются по project rules/CI/package.json.

## DAG

`runDag` запускает готовые задачи параллельно до `concurrency`. Задача с упавшей зависимостью получает `skipped`. Analyst-задачи выполняются до builders; critic — после gate.

## Contract-фаза

Если несколько builders используют общие интерфейсы/типы, добавь `contracts: ["путь"]` в план. Оркестратор создаёт отдельную задачу `contracts` перед builders:

- contract-задача пишет общие файлы;
- builders получают deny на edit этих файлов;
- нарушение contract ловится по diff и валит задачу с `contract_violation`;
- contract-файлы не перечисляются в `files` builder-задач.

Contract-фаза отключается `--no-contracts` и не создаётся в `--batch`.

## Batch-режим

`--batch` — независимые executor/visual-executor задачи без analysts/critics:

- `dependsOn: []` у всех задач;
- непересекающиеся `files`, без shared-файлов;
- `checks` обязательны;
- нужен бюджет: `--max-cost`, `--max-tokens` или `--max-minutes` (иначе ставится 60 минут);
- build concurrency автоматически 2–3.

## Verification и local gate

Команды gate берутся в порядке:

1. `--verify`;
2. `plan.verification`;
3. project rules;
4. `package.json` scripts (`test`, `lint`, `typecheck`, `build`);
5. известные стеки (`cargo test`, `go test ./...`, `pytest`, `mvn test`, `gradlew test`).

Local gate выполняется в worktree задачи по `checks`:

- `auto` — только если у задачи есть `checks`;
- `strict` — при отсутствии `checks` берёт общий verification;
- `off` — не запускается.

При красном local gate builder получает до 2 раундов фиксов; затем задача падает и не интегрируется. Integration gate выполняется в integration worktree. При красном gate оркестратор определяет виновную задачу по путям из вывода (triage), отправляет targeted fix, затем Lid чинит интеграцию. Раундов: 2 по умолчанию, 8 при `--ideal`/«идеально»/решении Lid.

## Git-модель

- База: `--base`, иначе `origin/dev`, иначе `origin HEAD`, иначе `HEAD`.
- Integration branch: `squad-<slug>-<short>`.
- Agent branch: `squad-<short>-<task>`.
- В worktree создаётся baseline-коммит с untracked-файлами; патч считается от baseline, поэтому untracked-файлы не попадают в патч.
- Успешный builder коммитит `squad(<task>): <title>`; Lid cherry-pick'ает коммит в integration branch.
- При конфликте cherry-pick отменяется, run помечается `failed`, integration worktree остаётся для разбора.

## Доска и вопросы

`squad_board` — инструмент агентов:

- `read` — статус, план, доска, вопросы; можно читать запись по `id` или искать по `query`;
- фильтры: `task_id`, `type`, `tag`;
- `post` — заметка;
- `ask` — вопрос с `destructive` флагом;
- `answer` — ответ;
- `status` — статус run.

Вопрос уходит в родительскую сессию. Если ответа нет 60 секунд, вопрос эскалируется Lid. Если Lid не ответил за 2 минуты: обратимый случай — assumption, destructive — stop.

## Event store, восстановление и отмена

`state.json` — снимок для `/squad-status`; `events.jsonl` — append-only журнал. Запись state атомарная (temp + rename), параллельные записи сериализуются file-lock. `RunStore.read` валидирует run-id, чтобы не было path traversal.

`active-store.ts` восстанавливает активные run и pending-вопросы после рестарта OpenCode. Прерванный run получает статус `interrupted`.

`/squad-cancel` отменяет активный run: агенты останавливаются, run получает статус `cancelled`, артефакты сохраняются.

## Бюджеты и метрики

Бюджеты (`--max-cost`, `--max-tokens`, `--max-minutes`) проверяются перед стартом задачи; при исчерпании run останавливается с ошибкой. Метрики (`metrics.ts`) пишут стоимость, токены, тайминги фаз, число запусков gate и fix-раундов в `state.json` и отчёт.

## Конфигурация `squad.json`

Читается из `~/.config/opencode/squad.json` и `<project>/.opencode/squad.json` (project переопределяет global):

```json
{
  "models": {
    "team-lid": "opencode-go/deepseek-v4.1-flash",
    "executor": "opencode-go/deepseek-v4.1-flash",
    "critic": "openrouter/anthropic/claude-sonnet-4",
    "fallback": "opencode-go/deepseek-v4.1-flash"
  },
  "buildConcurrency": 3,
  "maxCostUsd": 5,
  "maxTotalTokens": 2000000,
  "maxRunMinutes": 45,
  "sccache": true
}
```

`models` задаёт модель по роли и fallback; без него все агенты наследуют модель сессии. `fallback` используется при ошибке провайдера.

## Ограничения

- TUI live panel не реализован; есть `/squad-status` и tool `squad_status`.
- Локальные guards — best-effort permission rules, не sandbox.
- Вопросы не блокируют tool call: агент продолжает с assumption, ответ появляется на доске.
- Плагин не делает push/deploy/merge.

## Диагностика

```bash
opencode plugin list
opencode debug agents
opencode api get "/api/plugin?location[directory]=<project>"
opencode api get "/api/command?location[directory]=<project>"
```

Артефакты: `.squad/runs/<run-id>/`. Логи OpenCode: `~/.local/share/opencode/log/opencode.log`.
