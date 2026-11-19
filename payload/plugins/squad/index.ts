import { Plugin } from "@opencode/plugin"
import path from "node:path"
import {
  parseAnswerArgs,
  parseCancelArgs,
  parseSquadArgs,
  parseStatusArgs,
  parseToolInput,
  ANSWER_USAGE,
  CANCEL_USAGE,
  STATUS_USAGE,
} from "./src/args.ts"
import { RunStore } from "./src/event-store.ts"
import { orchestrate } from "./src/orchestrator.ts"
import { renderStatus } from "./src/report.ts"
import { answerQuestion, askQuestion, cleanupRun, hydratePendingQuestions } from "./src/questions.ts"
import { cancelRunById, isActiveParent, recoverActiveState, sessionContext } from "./src/registry.ts"
import type { AgentContext } from "./src/session.ts"
import type { BoardEntry } from "./src/types.ts"

function projectOf(ctx: { location?: { project?: { canonical?: string; id?: string }; directory?: string } }): string {
  return ctx.location?.project?.canonical || ctx.location?.directory || process.cwd()
}

function projectIdOf(ctx: { location?: { project?: { id?: string } } }, project: string): string {
  return ctx.location?.project?.id || path.basename(project)
}

function setupProjectOf(ctx: { location?: { project?: { canonical?: string }; directory?: string } }): string | undefined {
  return ctx.location?.project?.canonical || ctx.location?.directory
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

const hydrated = new Set<string>()

async function ensureRecovery(project: string, agentContext: AgentContext): Promise<void> {
  try {
    await recoverActiveState(project)
    if (hydrated.has(project)) return
    hydrated.add(project)
    await hydratePendingQuestions(agentContext, project)
  } catch {
    // Recovery is best-effort; live operations keep working without it.
  }
}

function boardLine(entry: BoardEntry, maxChars = 200): string {
  return `- ${entry.id} | ${entry.type} | ${entry.from}${entry.to ? ` -> ${entry.to}` : ""} | ${entry.taskId ?? "-"} | ${entry.text.replace(/\r?\n/g, " ").slice(0, maxChars)}`
}

export default Plugin.define({
  id: "squad",
  async setup(ctx) {
    const agentContext = ctx as unknown as AgentContext
    const initialProject = setupProjectOf(ctx)
    if (initialProject) await ensureRecovery(initialProject, agentContext)

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "squad",
        description:
          "Запускает автономный отряд: Lid планирует, агенты работают в git worktrees, проверки идут через жёсткий gate, результат — отдельная ветка и отчёт.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "Задача для отряда" },
            agents: { type: "integer", minimum: 1, maximum: 20, description: "Максимум задач/агентов. По умолчанию 8; batch — до 20." },
            roles: { type: "string", description: "Роли через запятую: analyst, executor, visual-executor, critic" },
            concurrency: { type: "integer", minimum: 1, maximum: 12, description: "Параллельных задач. По умолчанию 8." },
            timeout_minutes: { type: "integer", minimum: 1, maximum: 120, description: "Таймаут одного агента. По умолчанию 15." },
            ideal: { type: "boolean", description: "До 8 раундов доработки вместо 2." },
            base: { type: "string", description: "Базовая ветка/ref. По умолчанию origin/dev, затем origin HEAD, затем HEAD." },
            verify: { type: "array", items: { type: "string" }, description: "Команды verification. Если пусто — из плана/CI/package.json." },
            keep_worktrees: { type: "boolean", description: "Оставить worktrees после run." },
            contracts: { type: "boolean", description: "Opt-in Contract-First. По умолчанию авто при >1 builder и непустых contracts." },
            batch: { type: "boolean", description: "Independent batch-режим (opt-in): без dependsOn/shared-файлов, checks обязательны." },
            local_gate: { type: "string", enum: ["auto", "strict", "off"], description: "Локальный gate builders." },
            cleanup_on_failure: { type: "boolean", description: "Удалить worktrees/ветки даже при failed run." },
            allow_readonly: { type: "boolean", description: "Разрешить read-only run без builders." },
            strict_tests: { type: "boolean", description: "Падать, если requiresTests, а тестов нет." },
            build_concurrency: { type: "integer", minimum: 1, maximum: 12, description: "Семафор локальных/integration gate." },
            max_cost_usd: { type: "number", description: "Бюджет стоимости run." },
            max_total_tokens: { type: "integer", description: "Бюджет токенов run." },
            max_run_minutes: { type: "integer", description: "Бюджет времени run." },
          },
          required: ["task"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "squad",
            resources: ["run"],
            save: ["run"],
          })
          const project = projectOf(ctx)
          await ensureRecovery(project, agentContext)
          if (isActiveParent(context.sessionID) || sessionContext(context.sessionID)) {
            throw new Error("Рекурсивный /squad запрещён.")
          }
          const options = parseToolInput(input)
          const parent = await ctx.session.get({ sessionID: context.sessionID }).catch(() => undefined)
          const model = (parent as { model?: unknown } | undefined)?.model
          const result = await orchestrate({
            ctx: agentContext,
            options,
            project,
            projectId: projectIdOf(ctx, project),
            parentSessionID: context.sessionID,
            model,
            progress: async (status) => {
              try {
                await context.progress({ status })
              } catch {
                // Progress is best-effort.
              }
            },
          })
          return { content: result.summary }
        },
      })

      editor.add({
        name: "squad_status",
        description: "Показывает статус запуска squad: задачи, ветка, gate, вопросы, spend и ошибки.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            run_id: { type: "string", description: "ID запуска. Без него показывается последний." },
          },
          additionalProperties: false,
        },
        execute: async (input) => {
          const project = projectOf(ctx)
          await ensureRecovery(project, agentContext)
          const state = await RunStore.read(project, (input as { run_id?: string }).run_id)
          if (!state) return { content: "Squad: запусков не найдено." }
          return { content: renderStatus(state) }
        },
      })

      editor.add({
        name: "squad_board",
        description: "Общая доска squad: read (индекс/id/поиск), post, ask, answer, status. Доступна только агентам внутри активного run.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["read", "post", "ask", "answer", "status"] },
            text: { type: "string", description: "Текст заметки, вопроса или ответа." },
            to: { type: "string", description: "Адресат заметки." },
            task_id: { type: "string", description: "ID задачи, если нужно явно." },
            question_id: { type: "string", description: "ID вопроса для answer." },
            destructive: { type: "boolean", description: "Вопрос про необратимое действие." },
            id: { type: "string", description: "ID записи доски для полного чтения." },
            query: { type: "string", description: "Поиск по text/from/taskId/tags." },
            tag: { type: "string", description: "Фильтр/тег доски." },
            type: { type: "string", description: "Тип записи доски." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const project = projectOf(ctx)
          await ensureRecovery(project, agentContext)
          const found = sessionContext(context.sessionID)
          if (!found) return { content: "Squad board доступна только агенту внутри активного run." }
          const { run, taskId } = found
          const value = input as {
            action: string
            text?: string
            to?: string
            task_id?: string
            question_id?: string
            destructive?: boolean
            id?: string
            query?: string
            tag?: string
            type?: string
          }
          const from = value.task_id || taskId || "agent"
          if (value.action === "read") {
            if (value.id) {
              const entry = run.store.boardEntry(value.id)
              if (!entry) return { content: `Запись ${value.id} не найдена.` }
              const text = await run.store.boardText(value.id)
              return {
                content: `# ${entry.id} | ${entry.type} | ${entry.from}${entry.to ? ` -> ${entry.to}` : ""} | ${entry.taskId ?? "-"}\n${entry.ts}${entry.artifact ? `\nartifact: ${entry.artifact}` : ""}\n\n${text ?? entry.text}`,
              }
            }
            if (value.query || value.tag || value.type || value.task_id) {
              const entries = run.store.boardSearch(value.query ?? "", value.task_id, value.type, value.tag)
              return {
                content: entries.length
                  ? entries.map((entry) => boardLine(entry)).join("\n")
                  : "Записей по фильтру не найдено.",
              }
            }
            const decisions = run.store.decisionDigest(10)
            return {
              content: `${renderStatus(run.store.state)}\n\n## Board index\n${run.store.boardIndex(30, 200)}\n\n## Decisions\n${decisions || "_Решений нет._"}\n\n## Questions\n${run.store.questionDigest() || "_нет открытых вопросов_"}`,
            }
          }
          if (value.action === "status") return { content: renderStatus(run.store.state) }
          if (value.action === "post") {
            const text = String(value.text ?? "").trim()
            if (!text) throw new Error("text обязателен для post.")
            const allowed = new Set(["note", "decision", "assumption", "status", "dependency", "answer"])
            const type = value.type && allowed.has(value.type) ? value.type : "note"
            const entry = await run.store.addBoard({
              from,
              type: type as BoardEntry["type"],
              text,
              to: value.to,
              taskId: taskId ?? value.task_id,
              tags: value.tag ? [value.tag] : undefined,
            })
            return { content: `Записано: ${entry.id}${entry.artifact ? ` (artifact: ${entry.artifact})` : ""}` }
          }
          if (value.action === "ask") {
            const text = String(value.text ?? "").trim()
            if (!text) throw new Error("text обязателен для ask.")
            const question = await askQuestion(agentContext, run, {
              from,
              text,
              destructive: value.destructive === true,
              taskId: taskId ?? value.task_id,
              taskSessionID: context.sessionID,
              parentSessionID: run.parentSessionID,
            })
            return { content: `Вопрос ${question.id} поставлен. Если ответа нет, через 60 секунд его увидит Lid.` }
          }
          if (value.action === "answer") {
            const questionID = String(value.question_id ?? "").trim()
            const text = String(value.text ?? "").trim()
            if (!questionID || !text) throw new Error("question_id и text обязательны для answer.")
            const ok = await answerQuestion(agentContext, project, questionID, text, from)
            return { content: ok ? `Ответ на ${questionID} записан.` : `Вопрос ${questionID} не найден.` }
          }
          throw new Error(`Неизвестное действие squad_board: ${value.action}`)
        },
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "squad",
        description: "Запустить автономный отряд: /squad [--agents N] [--roles a,b] [--ideal] <задача>",
        execute: async ({ sessionID, prompt }) => {
          try {
            const project = projectOf(ctx)
            await ensureRecovery(project, agentContext)
            if (isActiveParent(sessionID) || sessionContext(sessionID)) {
              throw new Error("Рекурсивный /squad запрещён: эта сессия уже участвует в squad run.")
            }
            const options = parseSquadArgs(prompt?.text || "")
            const parent = await ctx.session.get({ sessionID }).catch(() => undefined)
            const model = (parent as { model?: unknown } | undefined)?.model
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: старт. Задача: ${options.task.slice(0, 160)}`,
              description: "squad",
            })
            const result = await orchestrate({
              ctx: agentContext,
              options,
              project,
              projectId: projectIdOf(ctx, project),
              parentSessionID: sessionID,
              model,
              progress: async (status) => {
                try {
                  await ctx.session.synthetic({ sessionID, text: status, description: "squad" })
                } catch {
                  // The user may have closed the session; the run keeps going.
                }
              },
            })
            await ctx.session.synthetic({
              sessionID,
              text: `${result.summary}\n\nОтчёт: ${result.reportPath}\nВетка: ${result.branch}`,
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ошибка — ${errorMessage(error)}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })

      editor.add({
        name: "squad-status",
        description: "Показать статус squad: /squad-status [run-id]",
        execute: async ({ sessionID, prompt }) => {
          try {
            const project = projectOf(ctx)
            await ensureRecovery(project, agentContext)
            const { runId } = parseStatusArgs(prompt?.text || "")
            const state = await RunStore.read(project, runId)
            await ctx.session.synthetic({
              sessionID,
              text: state ? renderStatus(state) : "Squad: запусков не найдено.",
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ${errorMessage(error)}\n${STATUS_USAGE}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })

      editor.add({
        name: "squad-answer",
        description: "Ответить на вопрос squad: /squad-answer <question-id> <ответ>",
        execute: async ({ sessionID, prompt }) => {
          try {
            const project = projectOf(ctx)
            await ensureRecovery(project, agentContext)
            const { questionId, text } = parseAnswerArgs(prompt?.text || "")
            const ok = await answerQuestion(agentContext, project, questionId, text, "user")
            await ctx.session.synthetic({
              sessionID,
              text: ok ? `Squad: ответ на ${questionId} записан.` : `Squad: вопрос ${questionId} не найден.`,
              description: "squad",
            })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ${errorMessage(error)}\n${ANSWER_USAGE}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })

      editor.add({
        name: "squad-cancel",
        description: "Отменить активный squad run: /squad-cancel [run-id]",
        execute: async ({ sessionID, prompt }) => {
          try {
            const project = projectOf(ctx)
            await ensureRecovery(project, agentContext)
            const { runId } = parseCancelArgs(prompt?.text || "")
            const result = await cancelRunById(project, runId, agentContext, cleanupRun)
            const text = result.found
              ? `Squad: run ${result.runId} отменён. Прервано сессий: ${result.sessions}. Артефакты сохранены.`
              : `Squad: активный run${runId ? ` ${runId}` : ""} не найден.`
            await ctx.session.synthetic({ sessionID, text, description: "squad" })
          } catch (error) {
            await ctx.session.synthetic({
              sessionID,
              text: `Squad: ${errorMessage(error)}\n${CANCEL_USAGE}`,
              description: "squad",
            }).catch(() => undefined)
          }
        },
      })
    })
  },
})
