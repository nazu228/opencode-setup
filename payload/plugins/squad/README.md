# squad plugin v2

Server-плагин OpenCode V2. Регистрирует:

- команду `/squad` — запуск автономного отряда;
- команду `/squad-status` — компактный статус run;
- команду `/squad-answer` — ответ на вопрос агента;
- команду `/squad-cancel` — отмена активного run;
- инструмент `squad` — то же, что `/squad`, для вызова из агента;
- инструмент `squad_status` — статус run;
- инструмент `squad_board` — общая доска агентов.

Точка входа — `index.ts`. Модули в `src/`:

- `args.ts` — парсинг флагов и tool input;
- `config.ts` — `squad.json`, модели по ролям, бюджеты;
- `plan.ts` — JSON-план Lid, валидация, ownership/DAG, contracts;
- `scheduler.ts` — DAG с concurrency;
- `concurrency.ts` — семафор локальных/integration gate;
- `event-store.ts` — `state.json` + `events.jsonl`;
- `active-store.ts` — активные run и восстановление после рестарта;
- `file-lock.ts` — сериализация записи состояния;
- `git.ts` — worktrees, baseline, patch, cherry-pick, cleanup;
- `gate.ts` — verification-команды и local gate;
- `triage.ts` — разбор упавшего gate и адресация фикса задаче;
- `test-detect.ts` — проверка наличия тестов;
- `prompts.ts` — prompt-шаблоны;
- `session.ts` — дочерние сессии и таймауты;
- `questions.ts` — 60s -> Lid escalation, доска;
- `registry.ts` — активные run, session map, отмена;
- `metrics.ts` — стоимость, токены, тайминги фаз;
- `opencode-adapter.ts` — мост к OpenCode SDK;
- `orchestrator.ts` — полный цикл;
- `report.ts` — summary/report/status.

Плагин не делает push/deploy/merge и не меняет основное рабочее дерево. Результат — integration-ветка, `SQUAD_REPORT.md` и артефакты в `.squad/runs/<run-id>/`.

Полная документация: `~/.config/opencode/SQUAD.md`.
