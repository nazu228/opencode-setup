import { promptSession, type AgentContext } from "./session.ts"
import { lidQuestionPrompt } from "./prompts.ts"
import { findQuestion, runContext, type RunContext } from "./registry.ts"
import { RunStore } from "./event-store.ts"
import {
  addActiveQuestion,
  findActiveQuestion,
  findActiveRun,
  readActiveState,
  removeActiveQuestion,
  updateActiveQuestion,
} from "./active-store.ts"
import type { SquadQuestion } from "./types.ts"

export const USER_QUESTION_TIMEOUT_MS = 60_000
export const LID_QUESTION_TIMEOUT_MS = 120_000

interface PendingEntry {
  runId: string
  questionId: string
  parentSessionID?: string
  taskSessionID?: string
  timer?: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingEntry>()
const byParent = new Map<string, string[]>()

function addPending(parentSessionID: string, entry: PendingEntry): void {
  pending.set(entry.questionId, entry)
  const list = byParent.get(parentSessionID) ?? []
  list.push(entry.questionId)
  byParent.set(parentSessionID, list)
}

function removePending(questionId: string): PendingEntry | undefined {
  const entry = pending.get(questionId)
  if (!entry) return undefined
  pending.delete(questionId)
  if (entry.timer) clearTimeout(entry.timer)
  for (const [parentID, list] of byParent) {
    const next = list.filter((id) => id !== questionId)
    if (next.length) byParent.set(parentID, next)
    else byParent.delete(parentID)
  }
  return entry
}

async function notify(ctx: AgentContext, sessionID: string | undefined, text: string): Promise<void> {
  if (!sessionID) return
  try {
    await ctx.session.synthetic({ sessionID, text, description: "squad" })
  } catch {
    // A closed child session must not break the run.
  }
}

async function finalizeWithoutLid(run: RunContext, question: SquadQuestion): Promise<void> {
  const answer = question.destructive
    ? "STOP: вопрос destructive, а ответа нет. Остановись и опиши блокер."
    : "Продолжай с самым простым обратимым assumption; явно запиши его в отчёте и на доске."
  await run.store.answerQuestion(question.id, answer, "squad", question.destructive ? "stopped" : "assumed")
  await removeActiveQuestion(run.project, question.id)
}

async function escalate(ctx: AgentContext, run: RunContext, questionID: string): Promise<void> {
  const current = run.store.state.questions.find((item) => item.id === questionID)
  if (!current || (current.status !== "pending" && current.status !== "needs_attention")) {
    removePending(questionID)
    await removeActiveQuestion(run.project, questionID)
    return
  }
  if (!run.lidSessionID) {
    await finalizeWithoutLid(run, current)
    removePending(questionID)
    return
  }
  const answer = await promptSession(
    ctx,
    run.lidSessionID,
    lidQuestionPrompt({
      state: run.store.state,
      from: current.from,
      taskId: current.taskId,
      question: current.text,
      destructive: current.destructive,
    }),
    LID_QUESTION_TIMEOUT_MS,
  )
  if (answer.status === "ok" && answer.text.trim()) {
    const text = answer.text.trim()
    const stopped = /^STOP\b/i.test(text)
    await run.store.answerQuestion(current.id, text, "Lid", stopped ? "stopped" : "answered")
    await removeActiveQuestion(run.project, current.id)
    await notify(ctx, run.parentSessionID, `Squad: Lid ответил на вопрос ${current.id}: ${text}`)
    await notify(ctx, pending.get(current.id)?.taskSessionID, `Squad: ответ на твой вопрос ${current.id}: ${text}`)
  } else {
    await finalizeWithoutLid(run, current)
    await notify(ctx, run.parentSessionID, `Squad: ответа на вопрос ${current.id} нет; зафиксирован assumption/stop.`)
  }
  removePending(questionID)
}

export async function askQuestion(
  ctx: AgentContext,
  run: RunContext,
  input: {
    from: string
    text: string
    destructive: boolean
    taskId?: string
    taskSessionID?: string
    parentSessionID?: string
  },
): Promise<SquadQuestion> {
  const question = await run.store.addQuestion({
    from: input.from,
    text: input.text,
    destructive: input.destructive,
    taskId: input.taskId,
  })
  const parentSessionID = input.parentSessionID ?? run.parentSessionID
  await addActiveQuestion(run.project, {
    id: question.id,
    runId: run.runId,
    from: input.from,
    text: input.text,
    destructive: input.destructive,
    taskId: input.taskId,
    taskSessionID: input.taskSessionID,
    deadline: new Date(Date.now() + USER_QUESTION_TIMEOUT_MS).toISOString(),
  })
  await notify(
    ctx,
    parentSessionID,
    `Squad question ${question.id} от ${input.from}${input.taskId ? ` (${input.taskId})` : ""}:\n${input.text}\n\nОтвет: /squad-answer ${question.id} <текст>`,
  )
  const timer = setTimeout(() => {
    void escalate(ctx, run, question.id).catch((error) => {
      void notify(
        ctx,
        parentSessionID,
        `Squad: ошибка эскалации вопроса ${question.id}: ${String((error as Error)?.message ?? error)}`,
      )
    })
  }, USER_QUESTION_TIMEOUT_MS)
  timer.unref?.()
  addPending(parentSessionID, {
    runId: run.runId,
    questionId: question.id,
    parentSessionID,
    taskSessionID: input.taskSessionID,
    timer,
  })
  return question
}

export async function answerQuestion(
  ctx: AgentContext,
  project: string,
  questionId: string,
  text: string,
  by: string,
): Promise<boolean> {
  const found = findQuestion(questionId)
  if (found) {
    const entry = removePending(questionId)
    await found.run.store.answerQuestion(questionId, text, by, "answered")
    await removeActiveQuestion(found.run.project, questionId)
    await notify(ctx, found.run.parentSessionID, `Squad: вопрос ${questionId} отвечен (${by}): ${text}`)
    await notify(
      ctx,
      entry?.taskSessionID ?? found.run.taskSessions.get(found.question.taskId ?? ""),
      `Squad: ответ на твой вопрос ${questionId}: ${text}`,
    )
    return true
  }

  const active = await findActiveQuestion(project, questionId)
  if (!active) return false
  const store = await RunStore.open(project, active.runId)
  if (!store) return false
  const question = await store.answerQuestion(questionId, text, by, "answered")
  if (!question) return false
  const entry = removePending(questionId)
  await removeActiveQuestion(project, questionId)
  const runRecord = await findActiveRun(project, active.runId)
  await notify(ctx, runRecord?.parentSessionID, `Squad: вопрос ${questionId} отвечен (${by}): ${text}`)
  await notify(
    ctx,
    entry?.taskSessionID ?? active.taskSessionID,
    `Squad: ответ на твой вопрос ${questionId}: ${text}`,
  )
  return true
}

export function pendingForParent(parentSessionID: string): string[] {
  return [...(byParent.get(parentSessionID) ?? [])]
}

export function cleanupRun(runId: string): void {
  for (const [questionID, entry] of pending) {
    if (entry.runId === runId) removePending(questionID)
  }
}

export async function hydratePendingQuestions(
  ctx: AgentContext,
  project: string,
): Promise<{ restored: number; needsAttention: number }> {
  const state = await readActiveState(project)
  let restored = 0
  let needsAttention = 0
  for (const question of state.questions) {
    const runRecord = state.runs.find((run) => run.runId === question.runId)
    let missingTaskSession = false
    if (question.taskSessionID) {
      try {
        await ctx.session.get({ sessionID: question.taskSessionID })
      } catch {
        missingTaskSession = true
      }
    }
    if (missingTaskSession || question.needsAttention) {
      needsAttention++
      await updateActiveQuestion(project, question.id, { needsAttention: true })
      const store = await RunStore.open(project, question.runId)
      if (store) await store.markQuestionNeedsAttention(question.id, "Task session не найдена после перезагрузки.")
    }
    addPending(runRecord?.parentSessionID ?? "", {
      runId: question.runId,
      questionId: question.id,
      parentSessionID: runRecord?.parentSessionID,
      taskSessionID: question.taskSessionID,
    })
    restored++
    const live = runContext(question.runId)
    if (live && !question.needsAttention && !missingTaskSession) {
      const remaining = Math.max(0, Date.parse(question.deadline) - Date.now())
      const timer = setTimeout(() => {
        void escalate(ctx, live, question.id).catch(() => undefined)
      }, remaining)
      timer.unref?.()
      const entry = pending.get(question.id)
      if (entry) entry.timer = timer
    }
  }
  return { restored, needsAttention }
}
