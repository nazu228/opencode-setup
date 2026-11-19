import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { RunStatus } from "./types.ts"
import { nowIso } from "./metrics.ts"
import { withFileLock } from "./file-lock.ts"

export const ACTIVE_SCHEMA_VERSION = 1
export const ACTIVE_LOCK_STALE_MS = 30_000

export interface ActiveRunRecord {
  runId: string
  project: string
  parentSessionID: string
  lidSessionID?: string
  taskSessions: Record<string, string>
  extraSessions?: string[]
  status: RunStatus
  startedAt: string
  updatedAt: string
}

export interface ActiveQuestionRecord {
  id: string
  runId: string
  from: string
  text: string
  destructive: boolean
  taskId?: string
  taskSessionID?: string
  deadline: string
  needsAttention?: boolean
}

export interface ActiveState {
  schemaVersion: number
  runs: ActiveRunRecord[]
  parents: string[]
  questions: ActiveQuestionRecord[]
}

const queues = new Map<string, Promise<unknown>>()

export function emptyActiveState(): ActiveState {
  return {
    schemaVersion: ACTIVE_SCHEMA_VERSION,
    runs: [],
    parents: [],
    questions: [],
  }
}

export function activeStatePath(project: string): string {
  return path.join(project, ".squad", "active.json")
}

export function activeLockPath(project: string): string {
  return path.join(project, ".squad", "active.lock")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalize(value: unknown): ActiveState {
  if (!isRecord(value)) return emptyActiveState()
  const runs = Array.isArray(value.runs)
    ? value.runs.filter((item): item is ActiveRunRecord => {
        if (!isRecord(item)) return false
        return typeof item.runId === "string" && typeof item.project === "string"
      })
    : []
  const questions = Array.isArray(value.questions)
    ? value.questions.filter((item): item is ActiveQuestionRecord => {
        if (!isRecord(item)) return false
        return typeof item.id === "string" && typeof item.runId === "string"
      })
    : []
  return {
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : ACTIVE_SCHEMA_VERSION,
    runs: runs.map((run) => ({
      ...run,
      parentSessionID: typeof run.parentSessionID === "string" ? run.parentSessionID : "",
      taskSessions: isRecord(run.taskSessions) ? (run.taskSessions as Record<string, string>) : {},
      extraSessions: Array.isArray(run.extraSessions)
        ? run.extraSessions.filter((item): item is string => typeof item === "string")
        : [],
      status: typeof run.status === "string" ? run.status : "running",
      startedAt: typeof run.startedAt === "string" ? run.startedAt : nowIso(),
      updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : nowIso(),
    })),
    parents: Array.isArray(value.parents) ? value.parents.filter((item): item is string => typeof item === "string") : [],
    questions: questions.map((question) => ({
      ...question,
      from: typeof question.from === "string" ? question.from : "agent",
      text: typeof question.text === "string" ? question.text : "",
      destructive: question.destructive === true,
      deadline: typeof question.deadline === "string" ? question.deadline : nowIso(),
    })),
  }
}

export interface ActiveReadResult {
  state: ActiveState
  warning?: string
}

export async function readActiveStateResult(project: string): Promise<ActiveReadResult> {
  try {
    const value = JSON.parse(await readFile(activeStatePath(project), "utf8")) as unknown
    if (!isRecord(value)) {
      return {
        state: emptyActiveState(),
        warning: "active.json: ожидался JSON-объект; состояние сброшено.",
      }
    }
    return { state: normalize(value) }
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return { state: emptyActiveState() }
    return {
      state: emptyActiveState(),
      warning: `active.json повреждён: ${String((error as Error)?.message ?? error)}`,
    }
  }
}

export async function readActiveState(project: string): Promise<ActiveState> {
  return (await readActiveStateResult(project)).state
}

async function backupCorruptActive(project: string): Promise<void> {
  const file = activeStatePath(project)
  const backup = `${file}.corrupt-${Date.now()}`
  await rename(file, backup).catch(() => undefined)
}

async function writeActiveState(project: string, state: ActiveState): Promise<void> {
  const file = activeStatePath(project)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export async function mutateActiveState<T>(project: string, action: (state: ActiveState) => T | Promise<T>): Promise<T> {
  const previous = queues.get(project) ?? Promise.resolve()
  const next = previous.then(() => withFileLock(activeLockPath(project), async () => {
    const read = await readActiveStateResult(project)
    if (read.warning) await backupCorruptActive(project)
    const state = read.state
    const result = await action(state)
    state.schemaVersion = ACTIVE_SCHEMA_VERSION
    await writeActiveState(project, state)
    return result
  }, {
    staleMs: ACTIVE_LOCK_STALE_MS,
    label: "active.json",
  }))
  queues.set(project, next.catch(() => undefined))
  return next
}

export async function findActiveRun(project: string, runId?: string): Promise<ActiveRunRecord | undefined> {
  const state = await readActiveState(project)
  return runId ? state.runs.find((run) => run.runId === runId) : state.runs.at(-1)
}

export async function findActiveQuestion(project: string, questionId: string): Promise<ActiveQuestionRecord | undefined> {
  const state = await readActiveState(project)
  return state.questions.find((question) => question.id === questionId)
}

export async function upsertActiveRun(project: string, record: ActiveRunRecord): Promise<void> {
  await mutateActiveState(project, (state) => {
    const index = state.runs.findIndex((run) => run.runId === record.runId)
    if (index >= 0) state.runs[index] = record
    else state.runs.push(record)
    if (record.parentSessionID && !state.parents.includes(record.parentSessionID)) {
      state.parents.push(record.parentSessionID)
    }
  })
}

export async function removeActiveRun(project: string, runId: string): Promise<void> {
  await mutateActiveState(project, (state) => {
    const record = state.runs.find((run) => run.runId === runId)
    state.runs = state.runs.filter((run) => run.runId !== runId)
    state.questions = state.questions.filter((question) => question.runId !== runId)
    if (record?.parentSessionID) {
      const stillUsed = state.runs.some((run) => run.parentSessionID === record.parentSessionID)
      if (!stillUsed) state.parents = state.parents.filter((parent) => parent !== record.parentSessionID)
    }
  })
}

export async function updateActiveRun(
  project: string,
  runId: string,
  patch: Partial<Omit<ActiveRunRecord, "runId" | "project" | "startedAt">>,
): Promise<void> {
  await mutateActiveState(project, (state) => {
    const record = state.runs.find((run) => run.runId === runId)
    if (!record) return
    Object.assign(record, patch, { updatedAt: nowIso() })
  })
}

export async function addActiveQuestion(project: string, question: ActiveQuestionRecord): Promise<void> {
  await mutateActiveState(project, (state) => {
    state.questions = state.questions.filter((item) => item.id !== question.id)
    state.questions.push(question)
  })
}

export async function removeActiveQuestion(project: string, questionId: string): Promise<void> {
  await mutateActiveState(project, (state) => {
    state.questions = state.questions.filter((question) => question.id !== questionId)
  })
}

export async function updateActiveQuestion(
  project: string,
  questionId: string,
  patch: Partial<Omit<ActiveQuestionRecord, "id" | "runId">>,
): Promise<void> {
  await mutateActiveState(project, (state) => {
    const question = state.questions.find((item) => item.id === questionId)
    if (question) Object.assign(question, patch)
  })
}
