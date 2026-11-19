import { RunStore } from "./event-store.ts"
import type { RunStatus, SquadQuestion } from "./types.ts"
import {
  findActiveRun,
  mutateActiveState,
  readActiveStateResult,
  removeActiveRun,
  upsertActiveRun,
  updateActiveRun,
  type ActiveRunRecord,
} from "./active-store.ts"
import { nowIso } from "./metrics.ts"

export interface RunContext {
  runId: string
  project: string
  store: RunStore
  parentSessionID: string
  lidSessionID?: string
  taskSessions: Map<string, string>
  extraSessions?: Set<string>
}

const runs = new Map<string, RunContext>()
const sessions = new Map<string, { runId: string; taskId?: string }>()
const activeParents = new Set<string>()
const cancelledRuns = new Set<string>()
const recoveredProjects = new Set<string>()

const INTERRUPT_AFTER_MS = 30 * 60_000

function recordOf(run: RunContext): ActiveRunRecord {
  return {
    runId: run.runId,
    project: run.project,
    parentSessionID: run.parentSessionID,
    lidSessionID: run.lidSessionID,
    taskSessions: Object.fromEntries(run.taskSessions),
    extraSessions: run.extraSessions ? [...run.extraSessions] : [],
    status: run.store.state.status,
    startedAt: run.store.state.createdAt,
    updatedAt: nowIso(),
  }
}

export async function registerRun(context: RunContext): Promise<void> {
  runs.set(context.runId, context)
  if (context.parentSessionID) activeParents.add(context.parentSessionID)
  await upsertActiveRun(context.project, recordOf(context))
}

export async function unregisterRun(runId: string): Promise<void> {
  const context = runs.get(runId)
  if (context) {
    const parent = context.parentSessionID
    if (parent && ![...runs.values()].some((run) => run.runId !== runId && run.parentSessionID === parent)) {
      activeParents.delete(parent)
    }
    runs.delete(runId)
    await removeActiveRun(context.project, runId)
  } else {
    for (const [sessionID, value] of sessions) {
      if (value.runId === runId) sessions.delete(sessionID)
    }
  }
  for (const [sessionID, value] of sessions) {
    if (value.runId === runId) sessions.delete(sessionID)
  }
}

export async function registerSession(sessionID: string, runId: string, taskId?: string): Promise<void> {
  sessions.set(sessionID, { runId, taskId })
  const context = runs.get(runId)
  if (!context) return
  if (taskId) {
    context.taskSessions.set(taskId, sessionID)
  } else if (!context.lidSessionID) {
    context.lidSessionID = sessionID
  } else if (context.lidSessionID !== sessionID) {
    context.extraSessions ??= new Set()
    context.extraSessions.add(sessionID)
  }
  await updateActiveRun(context.project, runId, {
    taskSessions: Object.fromEntries(context.taskSessions),
    extraSessions: context.extraSessions ? [...context.extraSessions] : [],
    lidSessionID: context.lidSessionID,
  })
}

export function unregisterSession(sessionID: string): void {
  sessions.delete(sessionID)
}

export function sessionContext(sessionID: string): { run: RunContext; taskId?: string } | undefined {
  const value = sessions.get(sessionID)
  if (!value) return undefined
  const run = runs.get(value.runId)
  return run ? { run, taskId: value.taskId } : undefined
}

export function runContext(runId: string): RunContext | undefined {
  return runs.get(runId)
}

export function findQuestion(questionId: string): { run: RunContext; question: SquadQuestion } | undefined {
  for (const run of runs.values()) {
    const question = run.store.state.questions.find((item) => item.id === questionId)
    if (question) return { run, question }
  }
  return undefined
}

export function isActiveParent(sessionID: string): boolean {
  return activeParents.has(sessionID)
}

export function activeRuns(): RunContext[] {
  return [...runs.values()]
}

export function markRunCancelled(runId: string): void {
  cancelledRuns.add(runId)
}

export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId)
}

export function clearRunCancelled(runId: string): void {
  cancelledRuns.delete(runId)
}

export function runSessionIDs(run: RunContext): string[] {
  return [...new Set([
    run.lidSessionID,
    ...run.taskSessions.values(),
    ...(run.extraSessions ? [...run.extraSessions] : []),
  ].filter((id): id is string => Boolean(id)))]
}

export async function syncActiveRun(run: RunContext): Promise<void> {
  if (!runs.has(run.runId)) return
  await updateActiveRun(run.project, run.runId, {
    status: run.store.state.status,
    lidSessionID: run.lidSessionID,
    taskSessions: Object.fromEntries(run.taskSessions),
    extraSessions: run.extraSessions ? [...run.extraSessions] : [],
  })
}

export interface RecoveryResult {
  interrupted: string[]
  terminal: string[]
  restoredRuns: string[]
  restoredQuestions: number
  warnings: string[]
}

export async function recoverActiveState(project: string): Promise<RecoveryResult> {
  if (recoveredProjects.has(project)) {
    return { interrupted: [], terminal: [], restoredRuns: [], restoredQuestions: 0, warnings: [] }
  }
  recoveredProjects.add(project)
  const read = await readActiveStateResult(project)
  const state = read.state
  const result: RecoveryResult = {
    interrupted: [],
    terminal: [],
    restoredRuns: [],
    restoredQuestions: 0,
    warnings: read.warning ? [read.warning] : [],
  }
  const inFlight: RunStatus[] = ["planning", "running", "verifying"]
  const terminal: RunStatus[] = ["delivered", "failed", "cancelled", "interrupted"]
  for (const record of state.runs) {
    const store = await RunStore.open(project, record.runId)
    const status = store?.state.status ?? record.status
    if (terminal.includes(status)) {
      await removeActiveRun(project, record.runId)
      result.terminal.push(record.runId)
      continue
    }
    const updated = Date.parse(record.updatedAt)
    const stale = !Number.isFinite(updated) || Date.now() - updated > INTERRUPT_AFTER_MS
    if (stale && inFlight.includes(status)) {
      if (store) {
        await store.setStatus("interrupted", "Run прерван: плагин перезагружен, состояние устарело.")
      }
      await mutateActiveState(project, (active) => {
        const existing = active.runs.find((run) => run.runId === record.runId)
        active.runs = active.runs.filter((run) => run.runId !== record.runId)
        if (existing?.parentSessionID) {
          const stillUsed = active.runs.some((run) => run.parentSessionID === existing.parentSessionID)
          if (!stillUsed) active.parents = active.parents.filter((parent) => parent !== existing.parentSessionID)
        }
        for (const question of active.questions) {
          if (question.runId === record.runId) question.needsAttention = true
        }
      })
      result.interrupted.push(record.runId)
      continue
    }
    if (!store) {
      await removeActiveRun(project, record.runId)
      continue
    }
    const context: RunContext = {
      runId: record.runId,
      project,
      store,
      parentSessionID: record.parentSessionID,
      lidSessionID: record.lidSessionID,
      taskSessions: new Map(Object.entries(record.taskSessions)),
      extraSessions: new Set(record.extraSessions ?? []),
    }
    runs.set(context.runId, context)
    if (context.parentSessionID) activeParents.add(context.parentSessionID)
    if (context.lidSessionID) sessions.set(context.lidSessionID, { runId: context.runId })
    for (const [taskId, sessionID] of context.taskSessions) sessions.set(sessionID, { runId: context.runId, taskId })
    for (const sessionID of context.extraSessions ?? []) sessions.set(sessionID, { runId: context.runId })
    result.restoredRuns.push(record.runId)
  }
  result.restoredQuestions = state.questions.length
  if (read.warning) {
    try {
      const latest = await RunStore.read(project)
      if (latest) {
        const store = await RunStore.open(project, latest.runId)
        if (store) await store.addWarning(read.warning)
      }
    } catch {
      // Warning is best-effort; recovery still resets active.json safely.
    }
  }
  return result
}

export function resetRecoveryCache(): void {
  recoveredProjects.clear()
}

export function resetRegistryMemory(): void {
  runs.clear()
  sessions.clear()
  activeParents.clear()
  cancelledRuns.clear()
  recoveredProjects.clear()
}

export interface InterruptContext {
  session: {
    interrupt(input: { sessionID: string; resume: boolean }): Promise<unknown>
  }
}

export interface CancelResult {
  runId?: string
  sessions: number
  found: boolean
}

export async function cancelRunById(
  project: string,
  runId: string | undefined,
  ctx: InterruptContext,
  onCancel?: (runId: string) => void,
): Promise<CancelResult> {
  const live = runId ? runs.get(runId) : [...runs.values()].at(-1)
  if (live) {
    markRunCancelled(live.runId)
    const ids = runSessionIDs(live)
    for (const sessionID of ids) {
      await ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
    }
    await live.store.setStatus("cancelled", "Отменён пользователем.")
    await updateActiveRun(project, live.runId, { status: "cancelled" })
    onCancel?.(live.runId)
    await unregisterRun(live.runId)
    return { runId: live.runId, sessions: ids.length, found: true }
  }

  const record = await findActiveRun(project, runId)
  if (!record) return { sessions: 0, found: false }
  const store = await RunStore.open(project, record.runId)
  if (!store) {
    await removeActiveRun(project, record.runId)
    return { sessions: 0, found: false }
  }
  const ids = [
    record.lidSessionID,
    ...Object.values(record.taskSessions),
    ...(record.extraSessions ?? []),
  ].filter((id): id is string => Boolean(id))
  for (const sessionID of ids) {
    await ctx.session.interrupt({ sessionID, resume: false }).catch(() => undefined)
  }
  await store.setStatus("cancelled", "Отменён пользователем.")
  onCancel?.(record.runId)
  await removeActiveRun(project, record.runId)
  return { runId: record.runId, sessions: ids.length, found: true }
}
