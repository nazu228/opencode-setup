import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { withFileLock } from "./file-lock.ts"
import type {
  BoardEntry,
  BoardEntryType,
  BudgetLimits,
  GateResult,
  PlanTask,
  RunStatus,
  RunState,
  SquadPlan,
  SquadQuestion,
  StatusSnapshot,
  TaskState,
} from "./types.ts"
import { planToMarkdown } from "./plan.ts"
import { createRunMetrics, nowIso } from "./metrics.ts"

const MAX_BOARD_IN_STATE = 500
const BOARD_TEXT_LIMIT = 4_000
const BOARD_SUMMARY_LIMIT = 500
const RUN_STATUSES = new Set<RunStatus>([
  "planning",
  "running",
  "verifying",
  "delivered",
  "failed",
  "cancelled",
  "interrupted",
])

export const RUN_STATE_SCHEMA_VERSION = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asPartial(value: unknown): Partial<RunState> {
  return isRecord(value) ? (value as Partial<RunState>) : {}
}

export function createRunId(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0")
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${stamp}-${randomUUID().slice(0, 8)}`
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(temp, content, "utf8")
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function taskFromPlan(task: PlanTask): TaskState {
  return {
    id: task.id,
    title: task.title,
    role: task.role,
    status: "pending",
    dependsOn: [...task.dependsOn],
    files: [...task.files],
    requiresTests: task.requiresTests,
  }
}

function normalizeState(value: unknown, project: string, runIdHint?: string): RunState | undefined {
  const state = asPartial(value)
  const runId = typeof state.runId === "string" && state.runId ? state.runId : runIdHint
  if (!runId) return undefined
  const runDir = typeof state.artifacts?.runDir === "string"
    ? state.artifacts.runDir
    : path.join(project, ".squad", "runs", runId)
  const status = state.status && RUN_STATUSES.has(state.status) ? state.status : "failed"
  const createdAt = typeof state.createdAt === "string" ? state.createdAt : nowIso()
  return {
    ...state,
    schemaVersion: typeof state.schemaVersion === "number" ? state.schemaVersion : 1,
    revision: typeof state.revision === "number" ? state.revision : 0,
    runId,
    task: typeof state.task === "string" ? state.task : "",
    project: typeof state.project === "string" ? state.project : project,
    base: typeof state.base === "string" ? state.base : "HEAD",
    branch: typeof state.branch === "string" ? state.branch : `squad-${runId.slice(-8)}`,
    status,
    createdAt,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : createdAt,
    tasks: isRecord(state.tasks) ? (state.tasks as Record<string, TaskState>) : {},
    questions: Array.isArray(state.questions) ? state.questions : [],
    board: Array.isArray(state.board) ? state.board : [],
    artifacts: {
      runDir,
      report: typeof state.artifacts?.report === "string" ? state.artifacts.report : path.join(project, "SQUAD_REPORT.md"),
      summary: typeof state.artifacts?.summary === "string" ? state.artifacts.summary : path.join(runDir, "summary.md"),
      planJson: state.artifacts?.planJson,
      planMarkdown: state.artifacts?.planMarkdown,
      patch: state.artifacts?.patch,
    },
    warnings: Array.isArray(state.warnings) ? state.warnings : [],
    commits: Array.isArray(state.commits) ? state.commits : [],
    metrics: state.metrics,
    budget: state.budget,
    triage: state.triage,
  }
}

async function readStateFile(file: string, project: string, runId: string): Promise<RunState | undefined> {
  try {
    return normalizeState(JSON.parse(await readFile(file, "utf8")), project, runId)
  } catch {
    return undefined
  }
}

export class RunStore {
  readonly project: string
  readonly runDir: string
  readonly statePath: string
  readonly eventsPath: string
  readonly resultsDir: string
  readonly patchesDir: string
  readonly logsDir: string
  readonly boardDir: string
  state: RunState

  private writeQueue: Promise<void> = Promise.resolve()
  private lastPersistedRevision: number

  private constructor(project: string, state: RunState) {
    this.project = project
    this.runDir = state.artifacts.runDir
    this.statePath = path.join(this.runDir, "state.json")
    this.eventsPath = path.join(this.runDir, "events.jsonl")
    this.resultsDir = path.join(this.runDir, "results")
    this.patchesDir = path.join(this.runDir, "patches")
    this.logsDir = path.join(this.runDir, "logs")
    this.boardDir = path.join(this.runDir, "board")
    this.state = state
    this.lastPersistedRevision = state.revision ?? 0
  }

  static async create(input: {
    project: string
    task: string
    base: string
    baseCommit?: string
    baseSource?: string
    branch: string
    runId?: string
  }): Promise<RunStore> {
    const runId = input.runId ?? createRunId()
    const runDir = path.join(input.project, ".squad", "runs", runId)
    await Promise.all([
      ensureDir(path.join(runDir, "results")),
      ensureDir(path.join(runDir, "patches")),
      ensureDir(path.join(runDir, "logs")),
      ensureDir(path.join(runDir, "board")),
    ])
    const createdAt = nowIso()
    const state: RunState = {
      schemaVersion: RUN_STATE_SCHEMA_VERSION,
      revision: 0,
      runId,
      task: input.task,
      project: input.project,
      base: input.base,
      baseCommit: input.baseCommit,
      baseSource: input.baseSource,
      branch: input.branch,
      status: "planning",
      createdAt,
      updatedAt: createdAt,
      tasks: {},
      questions: [],
      board: [],
      artifacts: {
        runDir,
        report: path.join(input.project, "SQUAD_REPORT.md"),
        summary: path.join(runDir, "summary.md"),
      },
      warnings: [],
      commits: [],
      metrics: createRunMetrics(createdAt),
    }
    const store = new RunStore(input.project, state)
    await store.persist()
    await store.append("run.created", { task: input.task, base: input.base, branch: input.branch })
    return store
  }

  static async open(project: string, runId: string): Promise<RunStore | undefined> {
    const state = await RunStore.read(project, runId)
    return state ? new RunStore(project, state) : undefined
  }

  static async read(project: string, runId?: string): Promise<RunState | undefined> {
    const runsDir = path.join(project, ".squad", "runs")
    if (runId) {
      if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{8}$/.test(runId)) return undefined
      const file = path.join(runsDir, runId, "state.json")
      if (!existsSync(file)) return undefined
      return readStateFile(file, project, runId)
    }
    if (!existsSync(runsDir)) return undefined
    const entries = await readdir(runsDir, { withFileTypes: true })
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const dir of dirs) {
      const file = path.join(runsDir, dir, "state.json")
      if (!existsSync(file)) continue
      const state = await readStateFile(file, project, dir)
      if (state) return state
    }
    return undefined
  }

  static async list(project: string): Promise<RunState[]> {
    const runsDir = path.join(project, ".squad", "runs")
    if (!existsSync(runsDir)) return []
    const entries = await readdir(runsDir, { withFileTypes: true })
    const states: RunState[] = []
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const file = path.join(runsDir, entry.name, "state.json")
      if (!existsSync(file)) continue
      const state = await readStateFile(file, project, entry.name)
      if (state) states.push(state)
    }
    return states
  }

  static snapshot(state: RunState): StatusSnapshot {
    return {
      runId: state.runId,
      task: state.task,
      status: state.status,
      branch: state.branch,
      base: state.base,
      updatedAt: state.updatedAt,
      revision: state.revision,
      gate: state.gate,
      tasks: Object.values(state.tasks),
      questions: state.questions,
      commits: state.commits,
      error: state.error,
      metrics: state.metrics,
      budget: state.budget,
      triage: state.triage,
    }
  }

  persist(): Promise<void> {
    this.state.schemaVersion = this.state.schemaVersion ?? RUN_STATE_SCHEMA_VERSION
    this.state.revision = (this.state.revision ?? 0) + 1
    this.state.updatedAt = nowIso()
    const revision = this.state.revision
    const payload = `${JSON.stringify(this.state, null, 2)}\n`
    const write = this.writeQueue.then(() => withFileLock(
      path.join(this.runDir, "state.lock"),
      async () => {
        const disk = await readStateFile(this.statePath, this.project, this.state.runId)
        if (disk && (disk.revision ?? 0) !== this.lastPersistedRevision) {
          throw new Error(
            `state.json изменён другим процессом (disk revision ${disk.revision ?? 0}, expected ${this.lastPersistedRevision}). Run остановлен без перезаписи.`,
          )
        }
        await atomicWrite(this.statePath, payload)
        this.lastPersistedRevision = revision
      },
      { label: "state.json" },
    ))
    this.writeQueue = write.catch(() => undefined)
    return write
  }

  async append(type: string, data: Record<string, unknown> = {}): Promise<void> {
    const event = { ts: nowIso(), type, runId: this.state.runId, ...data }
    await ensureDir(this.runDir)
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8")
    await this.persist()
  }

  async setStatus(status: RunStatus, error?: string): Promise<void> {
    this.state.status = status
    if (error) this.state.error = error
    if (status === "delivered" || status === "failed" || status === "cancelled" || status === "interrupted") {
      this.state.finishedAt = nowIso()
      if (this.state.metrics) this.state.metrics.finishedAt = this.state.finishedAt
    }
    await this.append("run.status", { status, error })
  }

  async setBudget(limits: BudgetLimits): Promise<void> {
    this.state.budget = limits
    await this.persist()
  }

  async setPlan(plan: SquadPlan): Promise<void> {
    this.state.plan = plan
    this.state.tasks = Object.fromEntries(plan.tasks.map((task) => [task.id, taskFromPlan(task)]))
    const planJson = path.join(this.runDir, "plan.json")
    const planMarkdown = path.join(this.runDir, "plan.md")
    await ensureDir(this.runDir)
    await writeFile(planJson, `${JSON.stringify(plan, null, 2)}\n`, "utf8")
    await writeFile(planMarkdown, planToMarkdown(plan), "utf8")
    this.state.artifacts.planJson = planJson
    this.state.artifacts.planMarkdown = planMarkdown
    await this.append("plan.created", { tasks: plan.tasks.length, summary: plan.summary })
  }

  async setTask(id: string, patch: Partial<TaskState>): Promise<void> {
    const current = this.state.tasks[id]
    if (!current) throw new Error(`Неизвестная задача "${id}".`)
    this.state.tasks[id] = { ...current, ...patch }
    await this.append("task.updated", { taskId: id, ...patch })
  }

  async setGate(gate: GateResult): Promise<void> {
    this.state.gate = gate
    if (this.state.metrics) this.state.metrics.gateRuns++
    await this.append("gate.finished", { ok: gate.ok, commands: gate.commands })
  }

  async addBoard(input: {
    from: string
    type: BoardEntryType
    text: string
    to?: string
    taskId?: string
    tags?: string[]
  }): Promise<BoardEntry> {
    const id = `b-${randomUUID().slice(0, 10)}`
    let text = input.text
    let artifact: string | undefined
    if (text.length > BOARD_TEXT_LIMIT) {
      await ensureDir(this.boardDir)
      const file = path.join(this.boardDir, `${id}.md`)
      await writeFile(file, input.text, "utf8")
      artifact = file
      text = `${input.text.slice(0, BOARD_SUMMARY_LIMIT).trimEnd()}\n… [полный текст: ${file}]`
    }
    const entry: BoardEntry = {
      id,
      ts: nowIso(),
      from: input.from,
      type: input.type,
      text,
      to: input.to,
      taskId: input.taskId,
      tags: input.tags?.length ? [...input.tags] : undefined,
      artifact,
    }
    this.state.board.push(entry)
    if (this.state.board.length > MAX_BOARD_IN_STATE) {
      this.state.board = this.state.board.slice(-MAX_BOARD_IN_STATE)
    }
    await this.append("board.posted", { entry })
    return entry
  }

  async addQuestion(input: {
    from: string
    text: string
    destructive: boolean
    taskId?: string
  }): Promise<SquadQuestion> {
    const question: SquadQuestion = {
      id: `q-${randomUUID().slice(0, 10)}`,
      from: input.from,
      text: input.text,
      destructive: input.destructive,
      status: "pending",
      askedAt: nowIso(),
      taskId: input.taskId,
    }
    this.state.questions.push(question)
    await this.addBoard({
      from: input.from,
      type: "question",
      text: input.text,
      taskId: input.taskId,
    })
    await this.append("question.asked", { question })
    return question
  }

  async answerQuestion(
    id: string,
    answer: string,
    answeredBy: string,
    status: "answered" | "assumed" | "stopped" | "needs_attention" = "answered",
  ): Promise<SquadQuestion | undefined> {
    const question = this.state.questions.find((item) => item.id === id)
    if (!question) return undefined
    question.status = status
    question.answer = answer
    question.answeredBy = answeredBy
    question.answeredAt = nowIso()
    await this.addBoard({
      from: answeredBy,
      type: status === "answered" ? "answer" : "decision",
      text: answer,
      taskId: question.taskId,
    })
    await this.append("question.answered", { id, answer, answeredBy, status })
    return question
  }

  async markQuestionNeedsAttention(id: string, note: string): Promise<SquadQuestion | undefined> {
    const question = this.state.questions.find((item) => item.id === id)
    if (!question) return undefined
    question.status = "needs_attention"
    question.answer = note
    question.answeredAt = nowIso()
    await this.append("question.needs_attention", { id, note })
    return question
  }

  async addCommit(taskId: string, commit: string, title: string): Promise<void> {
    this.state.commits.push({ taskId, commit, title })
    await this.append("commit.created", { taskId, commit, title })
  }

  async addWarning(text: string): Promise<void> {
    this.state.warnings.push(text)
    await this.append("run.warning", { text })
  }

  async writeResult(id: string, text: string): Promise<string> {
    await ensureDir(this.resultsDir)
    const file = path.join(this.resultsDir, `${id}.md`)
    await writeFile(file, text, "utf8")
    return file
  }

  async writeLog(id: string, value: unknown): Promise<string> {
    await ensureDir(this.logsDir)
    const file = path.join(this.logsDir, `${id}.json`)
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    return file
  }

  async writePatch(id: string, patch: string): Promise<string> {
    await ensureDir(this.patchesDir)
    const file = path.join(this.patchesDir, `${id}.patch`)
    await writeFile(file, patch, "utf8")
    return file
  }

  async writeText(name: string, text: string): Promise<string> {
    await ensureDir(this.runDir)
    const file = path.join(this.runDir, name)
    await writeFile(file, text, "utf8")
    return file
  }

  boardIndex(limit = 30, maxChars = 200): string {
    const entries = this.state.board.slice(-limit)
    if (!entries.length) return "_Доска пуста._"
    return entries
      .map((entry) => {
        const text = entry.text.replace(/\r?\n/g, " ").slice(0, maxChars)
        const direction = `${entry.from}${entry.to ? ` -> ${entry.to}` : ""}`
        return `- ${entry.id} | ${entry.type} | ${direction} | ${entry.taskId ?? "-"} | ${text}`
      })
      .join("\n")
  }

  boardDigest(limit = 30): string {
    return this.boardIndex(limit)
  }

  boardEntry(id: string): BoardEntry | undefined {
    return this.state.board.find((entry) => entry.id === id)
  }

  async boardText(id: string): Promise<string | undefined> {
    const entry = this.boardEntry(id)
    if (!entry) return undefined
    if (!entry.artifact) return entry.text
    try {
      return await readFile(entry.artifact, "utf8")
    } catch {
      return entry.text
    }
  }

  boardSearch(query: string, taskId?: string, type?: string, tag?: string): BoardEntry[] {
    const needle = String(query ?? "").trim().toLowerCase()
    return this.state.board.filter((entry) => {
      if (taskId && entry.taskId !== taskId) return false
      if (type && entry.type !== type) return false
      if (tag && !(entry.tags ?? []).includes(tag)) return false
      if (!needle) return true
      const haystack = [entry.text, entry.from, entry.to ?? "", entry.taskId ?? "", ...(entry.tags ?? [])]
        .join("\n")
        .toLowerCase()
      return haystack.includes(needle)
    })
  }

  decisionDigest(limit = 10): string {
    const entries = this.state.board
      .filter((entry) => entry.type === "decision" || entry.type === "assumption" || entry.type === "answer")
      .slice(-limit)
    if (!entries.length) return ""
    return entries
      .map((entry) => `- [${entry.type}] ${entry.from}${entry.taskId ? ` (${entry.taskId})` : ""}: ${entry.text.slice(0, 400)}`)
      .join("\n")
  }

  questionDigest(): string {
    const questions = this.state.questions.filter(
      (question) => question.status === "pending" || question.status === "needs_attention",
    )
    if (!questions.length) return ""
    return questions
      .map((question) => `- ${question.id} [${question.status}] (${question.from}): ${question.text}`)
      .join("\n")
  }
}
