import path from "node:path"
import { writeFile } from "node:fs/promises"
import { createRunId, RunStore } from "./event-store.ts"
import {
  assertSafeProject,
  baselineWorktree,
  branchName,
  capturePatch,
  changedFiles as changedFilesInDiff,
  cherryPick,
  commitWorktree,
  createWorktree,
  currentHead,
  deleteBranch,
  diffPaths,
  diffStat,
  ensureExclude,
  pendingChangedFiles,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  resetWorktreeTo,
  resolveBase,
  safeName,
  squashToBaseline,
  syncUntracked,
  worktreeRoot,
  type BaseInfo,
} from "./git.ts"
import { readRules, repoBrief } from "./context.ts"
import { defaultPlan, parsePlan, pathOverlaps, planPrompt, planRetryPrompt } from "./plan.ts"
import { runDag, topologicalOrder } from "./scheduler.ts"
import {
  createLidSession,
  promptSessionWithFallback,
  runAgent,
  type AgentContext,
} from "./session.ts"
import { lidFixPrompt, localGateFixPrompt, targetedFixPrompt, taskPrompt } from "./prompts.ts"
import { detectVerification, gateEnvironment, runGate } from "./gate.ts"
import { agentResultMarkdown, renderReport, renderSummary } from "./report.ts"
import { cleanupRun } from "./questions.ts"
import {
  clearRunCancelled,
  isRunCancelled,
  registerRun,
  registerSession,
  runSessionIDs,
  syncActiveRun,
  unregisterRun,
  type RunContext,
} from "./registry.ts"
import { loadSquadConfig, resolveFallbackModel, type SquadConfig } from "./config.ts"
import { createOpenCodeAdapter, type OpenCodeAdapter } from "./opencode-adapter.ts"
import { triageGateFailure } from "./triage.ts"
import { configureGlobalBuildConcurrency, releaseGlobalBuildConcurrency, type Semaphore } from "./concurrency.ts"
import { hasTestFiles } from "./test-detect.ts"
import {
  budgetExceeded,
  costNumber,
  createRunMetrics,
  recordPhase,
  tokenNumber,
} from "./metrics.ts"
import type {
  AgentRunResult,
  BudgetLimits,
  GateResult,
  PermissionRule,
  PlanTask,
  RepoRules,
  RunMetrics,
  RunResult,
  RunState,
  RunStatus,
  SquadOptions,
  SquadPlan,
  TaskState,
} from "./types.ts"

const PLAN_TIMEOUT_MS = 6 * 60_000
const PLAN_ATTEMPTS = 3
const CRITIC_TIMEOUT_MS = 10 * 60_000
const LOCAL_GATE_ROUNDS = 2
const TARGETED_FIX_ATTEMPTS = 2

export interface OrchestratorInput {
  ctx: AgentContext
  options: SquadOptions
  project: string
  projectId: string
  parentSessionID?: string
  model?: unknown
  progress: (message: string) => Promise<void> | void
}

interface RuntimeBase {
  input: OrchestratorInput
  options: SquadOptions
  run: RunContext
  rules: RepoRules
  config: SquadConfig
  adapter: OpenCodeAdapter
  semaphore: Semaphore
  gateEnv: NodeJS.ProcessEnv
  baseInfo: BaseInfo
  stopReason?: string
}

interface Runtime extends RuntimeBase {
  plan: SquadPlan
  verification: string[]
}

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function builderRole(role: PlanTask["role"]): boolean {
  return role === "executor" || role === "visual-executor"
}

async function progress(rt: OrchestratorInput | { input: OrchestratorInput }, message: string): Promise<void> {
  const input = "input" in rt ? rt.input : rt
  try {
    await input.progress(message)
  } catch {
    // Progress is cosmetic; never fail the run because the client closed.
  }
}

function taskById(tasks: readonly PlanTask[], id: string): PlanTask | undefined {
  return tasks.find((task) => task.id === id)
}

function digestResults(results: Map<string, AgentRunResult>, max = 60_000): string {
  const parts: string[] = []
  let length = 0
  for (const [id, result] of results) {
    if (result.status !== "ok" || !result.text) continue
    const chunk = `### ${id}\n${result.text.slice(0, 6000)}\n`
    if (length + chunk.length > max) break
    parts.push(chunk)
    length += chunk.length
  }
  return parts.join("\n").trim()
}

function blockingCriticFindings(results: Map<string, AgentRunResult>): string[] {
  const warnings: string[] = []
  for (const [id, result] of results) {
    if (result.status !== "ok" || !result.text) continue
    for (const match of result.text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      try {
        const parsed = JSON.parse(match[1] ?? "") as unknown
        if (!Array.isArray(parsed)) continue
        for (const item of parsed) {
          if (!isRecord(item) || item.blocking !== true) continue
          const file = typeof item.file === "string" ? item.file : "-"
          const text = typeof item.text === "string" ? item.text : "blocking finding"
          warnings.push(`critic ${id}: ${file}: ${text}`)
        }
      } catch {
        // Critics may return prose; only structured findings become warnings.
      }
    }
  }
  return warnings
}

function boardPrompt(store: RunStore): string {
  const index = store.state.board.length ? store.boardIndex(30, 200) : "_Доска пуста._"
  const decisions = store.decisionDigest(10)
  return `${index}${decisions ? `\n\n### Decisions / assumptions\n${decisions}` : ""}`
}

function metricsOf(run: RunContext): RunMetrics {
  const metrics = run.store.state.metrics
  if (metrics) return metrics
  const created = createRunMetrics(run.store.state.createdAt)
  run.store.state.metrics = created
  return created
}

function budgetLimits(options: SquadOptions): BudgetLimits {
  return {
    maxCostUsd: options.maxCostUsd,
    maxTotalTokens: options.maxTotalTokens,
    maxRunMinutes: options.maxRunMinutes,
  }
}

function hasBudget(limits: BudgetLimits): boolean {
  return limits.maxCostUsd != null || limits.maxTotalTokens != null || limits.maxRunMinutes != null
}

async function assertRunnable(rt: RuntimeBase): Promise<void> {
  if (isRunCancelled(rt.run.runId)) {
    rt.stopReason = "cancelled"
    throw new Error("cancelled")
  }
  if (rt.stopReason) throw new Error(rt.stopReason)
  if (rt.run.store.state.providerError) {
    rt.stopReason = rt.run.store.state.providerError
    throw new Error(rt.stopReason)
  }
  const exceeded = budgetExceeded(rt.run.store.state, budgetLimits(rt.options))
  if (exceeded) {
    rt.stopReason = exceeded
    throw new Error(exceeded)
  }
}

async function assertBudget(rt: RuntimeBase): Promise<void> {
  const exceeded = budgetExceeded(rt.run.store.state, budgetLimits(rt.options))
  if (exceeded) {
    rt.stopReason = exceeded
    throw new Error(exceeded)
  }
}

async function setRunStatus(run: RunContext, status: RunStatus, error?: string): Promise<void> {
  await run.store.setStatus(status, error)
  await syncActiveRun(run).catch(() => undefined)
}

async function writeAgentArtifacts(store: RunStore, task: TaskState, result: AgentRunResult): Promise<void> {
  await store.writeResult(task.id, agentResultMarkdown(result, task))
  await store.writeLog(task.id, {
    sessionID: result.sessionID,
    status: result.status,
    error: result.error,
    errorKind: result.errorKind,
    rawError: result.rawError,
    info: result.info,
    messages: result.messages,
  })
}

async function interruptRun(rt: RuntimeBase): Promise<void> {
  for (const sessionID of runSessionIDs(rt.run)) {
    try {
      await rt.input.ctx.session.interrupt({ sessionID, resume: false })
    } catch {
      // Interrupt is best-effort; the run must finish with a useful error.
    }
  }
}

async function applyAgentResult(rt: RuntimeBase, task: PlanTask, result: AgentRunResult): Promise<void> {
  const stateTask = rt.run.store.state.tasks[task.id]!
  await writeAgentArtifacts(rt.run.store, stateTask, result)
  const metrics = metricsOf(rt.run)
  const cost = costNumber(result.cost)
  const tokens = tokenNumber(result.tokens)
  metrics.totalCost += cost
  metrics.totalTokens += tokens
  if (result.errorKind === "provider" || result.modelFallback) metrics.providerErrors++
  await rt.run.store.setTask(task.id, {
    sessionID: result.sessionID,
    cost,
    tokens,
    durationMs: Math.max(0, Math.round(result.durationMs || 0)),
  })
  if (result.modelFallback) {
    await rt.run.store.addWarning(`Model fallback использован для задачи ${task.id}.`)
  }
  if (result.errorKind === "provider") {
    rt.stopReason = result.error ?? "provider error"
    rt.run.store.state.providerError = rt.stopReason
    await rt.run.store.append("provider.error", {
      taskId: task.id,
      sessionID: result.sessionID,
      error: rt.stopReason,
    })
    await interruptRun(rt)
  }
}

async function recordSessionUsage(rt: RuntimeBase, sessionID: string): Promise<void> {
  try {
    const info = await rt.input.ctx.session.get({ sessionID })
    const record = isRecord(info) ? info : undefined
    const metrics = metricsOf(rt.run)
    metrics.totalCost += costNumber(record?.cost)
    metrics.totalTokens += tokenNumber(record?.tokens)
    await rt.run.store.persist()
  } catch {
    // Cost data is optional.
  }
}

interface UsageSnapshot {
  cost: number
  tokens: number
}

async function sessionUsage(rt: RuntimeBase, sessionID: string): Promise<UsageSnapshot> {
  try {
    const info = await rt.input.ctx.session.get({ sessionID })
    const record = isRecord(info) ? info : undefined
    return { cost: costNumber(record?.cost), tokens: tokenNumber(record?.tokens) }
  } catch {
    return { cost: 0, tokens: 0 }
  }
}

async function recordUsageDelta(
  rt: RuntimeBase,
  task: PlanTask,
  before: UsageSnapshot,
  after: UsageSnapshot,
): Promise<void> {
  const cost = Math.max(0, after.cost - before.cost)
  const tokens = Math.max(0, after.tokens - before.tokens)
  if (!cost && !tokens) return
  const metrics = metricsOf(rt.run)
  metrics.totalCost += cost
  metrics.totalTokens += tokens
  const taskState = rt.run.store.state.tasks[task.id]
  await rt.run.store.setTask(task.id, {
    cost: (taskState?.cost ?? 0) + cost,
    tokens: (taskState?.tokens ?? 0) + tokens,
  })
}

function modelFor(rt: RuntimeBase, role: string): unknown {
  return rt.adapter.resolveModel(role, rt.input.model)
}

function lidModel(rt: RuntimeBase): unknown {
  return modelFor(rt, "team-lid")
}

function fallbackModel(rt: RuntimeBase): unknown {
  return resolveFallbackModel(rt.config)
}

function contractPermissions(plan: SquadPlan, task: PlanTask): PermissionRule[] | undefined {
  if (!plan.contracts?.length || task.contract) return undefined
  return plan.contracts.map((resource) => ({ action: "edit", resource, effect: "deny" }))
}

function sessionCallback(run: RunContext, taskId?: string): (sessionID: string) => void {
  return (sessionID) => {
    void registerSession(sessionID, run.runId, taskId)
      .then(() => syncActiveRun(run))
      .catch(() => undefined)
  }
}

async function runReadOnlyPhase(
  rt: RuntimeBase & { plan: SquadPlan },
  input: {
    tasks: PlanTask[]
    location: string
    isWorktree: boolean
    analystDigest: string
    label: string
  },
): Promise<Map<string, AgentRunResult>> {
  const results = new Map<string, AgentRunResult>()
  if (!input.tasks.length) return results
  const ids = new Set(input.tasks.map((task) => task.id))
  const dagTasks = input.tasks.map((task) => ({
    id: task.id,
    dependsOn: task.dependsOn.filter((dependency) => ids.has(dependency)),
  }))
  await runDag(dagTasks, rt.options.concurrency, async (dagTask) => {
    const task = taskById(input.tasks, dagTask.id)!
    await assertRunnable(rt)
    await rt.run.store.setTask(task.id, { status: "running", startedAt: now() })
    await progress(rt, `Squad: ${input.label} ${task.id}`)
    const prompt = taskPrompt({
      task,
      plan: rt.plan,
      rules: rt.rules,
      analystDigest: input.analystDigest,
      boardDigest: boardPrompt(rt.run.store),
      project: rt.input.project,
      worktree: input.location,
      branch: rt.run.store.state.branch,
      isWorktree: input.isWorktree,
      runId: rt.run.runId,
      runDir: rt.run.store.state.artifacts.runDir,
    })
    const result = await runAgent(rt.input.ctx, {
      task,
      plan: rt.plan,
      prompt,
      location: input.location,
      parentSessionID: rt.input.parentSessionID,
      model: modelFor(rt, task.role),
      fallbackModel: fallbackModel(rt),
      timeoutMs: task.role === "critic" ? CRITIC_TIMEOUT_MS : rt.options.timeoutMinutes * 60_000,
      runId: rt.run.runId,
      phase: task.role === "critic" ? "critic" : "analyst",
      onSession: sessionCallback(rt.run, task.id),
    })
    results.set(task.id, result)
    await applyAgentResult(rt, task, result)
    const ok = result.status === "ok" && Boolean(result.text.trim())
    await rt.run.store.setTask(task.id, {
      status: ok ? "done" : "failed",
      error: result.error,
      finishedAt: now(),
    })
    await rt.run.store.addBoard({
      from: task.id,
      type: ok ? "status" : "decision",
      text: ok ? "готово" : `ошибка: ${result.error ?? result.status}`,
      taskId: task.id,
    })
    if (isRunCancelled(rt.run.runId)) {
      rt.stopReason = "cancelled"
      throw new Error("cancelled")
    }
    if (result.errorKind === "provider") {
      throw new Error(result.error ?? "provider error")
    }
    if (!ok) throw new Error(`${task.id}: ${result.error ?? result.status}`)
    await assertBudget(rt)
    return result
  }, {
    onStatus: async (taskID, status, error) => {
      if (status !== "skipped") return
      await rt.run.store.setTask(taskID, {
        status: "skipped",
        error: error ?? "Зависимость не выполнена.",
        finishedAt: now(),
      })
    },
    shouldStop: () => rt.stopReason,
  })
  if (rt.stopReason) throw new Error(rt.stopReason)
  return results
}

function crossPhaseFailed(task: PlanTask, plan: SquadPlan, state: RunState): boolean {
  return task.dependsOn.some((dependency) => {
    const dep = plan.tasks.find((item) => item.id === dependency)
    if (!dep) return false
    if (dep.role !== "analyst" && dep.role !== "critic") return false
    const status = state.tasks[dependency]?.status
    return status === "failed" || status === "skipped"
  })
}

function dependencyClosure(task: PlanTask, phaseTasks: readonly PlanTask[]): string[] {
  const byId = new Map(phaseTasks.map((item) => [item.id, item]))
  const ids = new Set<string>()
  const visit = (id: string): void => {
    if (ids.has(id) || !byId.has(id)) return
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    ids.add(id)
  }
  for (const dependency of task.dependsOn) visit(dependency)
  const subset = phaseTasks.filter((item) => ids.has(item.id)).map((item) => ({
    id: item.id,
    dependsOn: item.dependsOn.filter((dependency) => ids.has(dependency)),
  }))
  return topologicalOrder(subset).filter((id) => ids.has(id))
}

async function prepareWorktree(
  rt: RuntimeBase & { plan: SquadPlan },
  task: PlanTask,
  phaseTasks: readonly PlanTask[],
): Promise<{ worktree: string; branch: string; baseline: string }> {
  const shortRun = safeName(rt.run.runId.split("-").at(-1) ?? rt.run.runId, "run").slice(0, 8)
  const branch = `squad-${shortRun}-${safeName(task.id, "task")}`
  const worktree = path.join(worktreeRoot(rt.input.projectId, rt.run.runId), safeName(task.id, "task"))
  await rt.run.store.setTask(task.id, { worktree, branch })
  await createWorktree(rt.input.project, worktree, branch, rt.baseInfo.commit)
  await syncUntracked(rt.input.project, worktree)
  for (const dependency of dependencyClosure(task, phaseTasks)) {
    const dep = rt.run.store.state.tasks[dependency]
    if (!dep || dep.status !== "done") {
      const message = `dependency_missing: ${dependency} не выполнена`
      await rt.run.store.setTask(task.id, { status: "failed", error: message, finishedAt: now() })
      throw new Error(message)
    }
    if (!dep.commit) {
      const message = `dependency_missing: у ${dependency} нет коммита`
      await rt.run.store.setTask(task.id, { status: "failed", error: message, finishedAt: now() })
      throw new Error(message)
    }
    const picked = await cherryPick(worktree, dep.commit)
    if (!picked.ok) {
      const message = `dependency_conflict: ${dependency}: ${picked.error ?? "conflict"}`
      await rt.run.store.setTask(task.id, { status: "failed", error: message, finishedAt: now() })
      throw new Error(message)
    }
  }
  const baseline = await baselineWorktree(worktree)
  return { worktree, branch, baseline }
}

async function runLocalGate(
  rt: RuntimeBase & { plan: SquadPlan; verification: string[] },
  task: PlanTask,
  worktree: string,
  initialSessionID: string,
): Promise<void> {
  const mode = rt.options.localGate ?? "auto"
  if (mode === "off") return
  const checks = task.checks?.length
    ? task.checks
    : mode === "strict"
      ? rt.verification
      : []
  if (!checks.length) return
  const timeout = rt.options.timeoutMinutes * 60_000
  const rounds: Record<string, unknown>[] = []
  const save = async (gate: GateResult): Promise<void> => {
    const log = await rt.run.store.writeLog(`${task.id}.local-gate`, {
      checks,
      gate,
      rounds,
    })
    await rt.run.store.setTask(task.id, { localGate: gate, localGateLog: log })
  }
  let sessionID = initialSessionID
  let gate = await rt.semaphore.withSlot(() => runGate(worktree, checks, timeout, rt.gateEnv))
  rounds.push({ round: 0, gate })
  await save(gate)
  for (let round = 1; round <= LOCAL_GATE_ROUNDS && !gate.ok; round++) {
    await assertRunnable(rt)
    await progress(rt, `Squad: local gate fix ${task.id}, round ${round}`)
    const before = await sessionUsage(rt, sessionID)
    const result = await promptSessionWithFallback(rt.input.ctx, {
      sessionID,
      prompt: localGateFixPrompt({ task, checks, gateOutput: gate.output, worktree, rules: rt.rules }),
      timeoutMs: timeout,
      agent: task.role,
      location: worktree,
      parentSessionID: rt.input.parentSessionID,
      fallbackModel: fallbackModel(rt),
      permissions: contractPermissions(rt.plan, task),
      metadata: {
        squadRunId: rt.run.runId,
        squadTaskId: task.id,
        role: task.role,
        phase: "builder",
      },
      title: `squad local-gate fix ${rt.run.runId} ${task.id}`,
      runId: rt.run.runId,
      taskId: task.id,
      phase: "builder",
      onSession: (fallbackID) => {
        void registerSession(fallbackID, rt.run.runId, task.id)
          .then(() => syncActiveRun(rt.run))
          .catch(() => undefined)
      },
    })
    const after = await sessionUsage(rt, result.sessionID)
    await recordUsageDelta(rt, task, result.usedFallback ? { cost: 0, tokens: 0 } : before, after)
    rounds.push({
      round,
      status: result.status,
      error: result.error,
      sessionID: result.sessionID,
      usedFallback: result.usedFallback,
      cost: after.cost - (result.usedFallback ? 0 : before.cost),
      tokens: after.tokens - (result.usedFallback ? 0 : before.tokens),
    })
    if (result.usedFallback) {
      sessionID = result.sessionID
      await rt.run.store.addWarning(`Local gate fix ${task.id}: использован fallback-модель.`)
    }
    if (result.errorKind === "provider") {
      rt.stopReason = result.error ?? "provider error"
      rt.run.store.state.providerError = rt.stopReason
      await save(gate)
      throw new Error(rt.stopReason)
    }
    if (result.status !== "ok" || !result.text.trim()) {
      await save(gate)
      throw new Error(`local_gate: ${task.id}: ${result.error ?? result.status}`)
    }
    gate = await rt.semaphore.withSlot(() => runGate(worktree, checks, timeout, rt.gateEnv))
    rounds.push({ round, gate })
    await save(gate)
  }
  if (!gate.ok) throw new Error(`local_gate: ${task.id} не прошёл проверки после ${LOCAL_GATE_ROUNDS} раундов`)
}

async function runBuilderPhase(
  rt: RuntimeBase & { plan: SquadPlan; verification: string[] },
  tasks: PlanTask[],
  analystDigest: string,
): Promise<Map<string, AgentRunResult>> {
  const results = new Map<string, AgentRunResult>()
  if (!tasks.length) return results
  const ids = new Set(tasks.map((task) => task.id))
  const blocked = new Set<string>()
  for (const task of tasks) {
    if (crossPhaseFailed(task, rt.plan, rt.run.store.state)) blocked.add(task.id)
  }
  const dagTasks = tasks.map((task) => ({
    id: task.id,
    dependsOn: blocked.has(task.id) ? [] : task.dependsOn.filter((dependency) => ids.has(dependency)),
  }))
  await runDag(dagTasks, rt.options.concurrency, async (dagTask) => {
    const task = taskById(tasks, dagTask.id)!
    if (blocked.has(task.id)) {
      await rt.run.store.setTask(task.id, {
        status: "skipped",
        error: "Зависимость аналитика не выполнена.",
        finishedAt: now(),
      })
      throw new Error(`${task.id}: dependency failed`)
    }
    await assertRunnable(rt)
    await rt.run.store.setTask(task.id, { status: "running", startedAt: now() })
    await progress(rt, `Squad: executor ${task.id}`)
    let worktree = ""
    let baseline = ""
    try {
      const prepared = await prepareWorktree(rt, task, tasks)
      worktree = prepared.worktree
      baseline = prepared.baseline
      await rt.run.store.setTask(task.id, { worktree, branch: prepared.branch })
      const prompt = taskPrompt({
        task,
        plan: rt.plan,
        rules: rt.rules,
        analystDigest,
        boardDigest: boardPrompt(rt.run.store),
        project: rt.input.project,
        worktree,
        branch: prepared.branch,
        isWorktree: true,
        runId: rt.run.runId,
        runDir: rt.run.store.state.artifacts.runDir,
      })
      const result = await runAgent(rt.input.ctx, {
        task,
        plan: rt.plan,
        prompt,
        location: worktree,
        parentSessionID: rt.input.parentSessionID,
        model: modelFor(rt, task.role),
        fallbackModel: fallbackModel(rt),
        permissions: contractPermissions(rt.plan, task),
        timeoutMs: rt.options.timeoutMinutes * 60_000,
        runId: rt.run.runId,
        phase: "builder",
        onSession: sessionCallback(rt.run, task.id),
      })
      results.set(task.id, result)
      await applyAgentResult(rt, task, result)
      if (isRunCancelled(rt.run.runId)) {
        rt.stopReason = "cancelled"
        throw new Error("cancelled")
      }
      if (result.errorKind === "provider") throw new Error(result.error ?? "provider error")
      if (result.status !== "ok" || !result.text.trim()) {
        await rt.run.store.setTask(task.id, {
          status: "failed",
          error: result.error ?? "agent returned no usable result",
          finishedAt: now(),
        })
        await rt.run.store.addBoard({
          from: task.id,
          type: "decision",
          text: `не интегрирую: ${result.error ?? result.status}`,
          taskId: task.id,
        })
        throw new Error(`${task.id}: ${result.error ?? result.status}`)
      }
      await runLocalGate(rt, task, worktree, result.sessionID)
      const commit = await squashToBaseline(worktree, baseline, `squad(${task.id}): ${task.title}`)
      if (!commit) {
        await rt.run.store.setTask(task.id, {
          status: "failed",
          error: "Агент не изменил ни одного файла.",
          finishedAt: now(),
        })
        throw new Error(`${task.id}: no changes`)
      }
      const patch = await capturePatch(worktree, baseline)
      const patchPath = await rt.run.store.writePatch(task.id, patch)
      const changed = await changedFilesInDiff(worktree, baseline)
      const contractViolations = task.contract
        ? []
        : changed.filter((file) => (rt.plan.contracts ?? []).some((contract) => pathOverlaps(file, contract)))
      if (contractViolations.length) {
        await rt.run.store.setTask(task.id, {
          status: "failed",
          patch: patchPath,
          error: `contract_violation: ${contractViolations.join(", ")}`,
          finishedAt: now(),
        })
        throw new Error(`${task.id}: contract_violation ${contractViolations.join(", ")}`)
      }
      const ownershipViolations = changed.filter(
        (file) => !task.files.some((pattern) => pathOverlaps(file, pattern))
      )
      if (ownershipViolations.length) {
        await rt.run.store.setTask(task.id, {
          status: "failed",
          patch: patchPath,
          error: `ownership_violation: ${ownershipViolations.join(", ")}`,
          finishedAt: now(),
        })
        throw new Error(`${task.id}: ownership_violation ${ownershipViolations.join(", ")}`)
      }
      if (task.requiresTests && !(await hasTestFiles(worktree, changed))) {
        const text = `Задача ${task.id} требует тестов, но в diff нет test/spec-файлов.`
        if (rt.options.strictTests) {
          await rt.run.store.setTask(task.id, {
            status: "failed",
            patch: patchPath,
            error: `tests_missing: ${text}`,
            finishedAt: now(),
          })
          throw new Error(`${task.id}: tests_missing`)
        }
        await rt.run.store.addWarning(text)
      }
      await rt.run.store.setTask(task.id, {
        status: "done",
        commit,
        patch: patchPath,
        finishedAt: now(),
      })
      await rt.run.store.addCommit(task.id, commit, task.title)
      await rt.run.store.addBoard({
        from: task.id,
        type: "status",
        text: `готово, commit ${commit.slice(0, 8)}`,
        taskId: task.id,
      })
      await assertBudget(rt)
      return result
    } catch (error) {
      const stateTask = rt.run.store.state.tasks[task.id]
      if (stateTask && stateTask.status === "running") {
        await rt.run.store
          .setTask(task.id, { status: "failed", error: errorMessage(error), finishedAt: now() })
          .catch(() => undefined)
      }
      throw error
    }
  }, {
    onStatus: async (taskID, status, error) => {
      if (status !== "skipped") return
      await rt.run.store.setTask(taskID, {
        status: "skipped",
        error: error ?? "Зависимость не выполнена.",
        finishedAt: now(),
      })
    },
    shouldStop: () => rt.stopReason,
  })
  if (rt.stopReason) throw new Error(rt.stopReason)
  return results
}

async function createIntegration(
  rt: RuntimeBase & { plan: SquadPlan },
  builders: PlanTask[],
): Promise<{ dir: string; error?: string }> {
  const dir = path.join(worktreeRoot(rt.input.projectId, rt.run.runId), "integration")
  try {
    await createWorktree(rt.input.project, dir, rt.run.store.state.branch, rt.baseInfo.commit)
  } catch (error) {
    return { dir, error: errorMessage(error) }
  }
  rt.run.store.state.integrationWorktree = dir
  await rt.run.store.append("integration.created", { dir, branch: rt.run.store.state.branch })
  const order = topologicalOrder(builders.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))
  for (const id of order) {
    const task = builders.find((item) => item.id === id)
    const stateTask = rt.run.store.state.tasks[id]
    if (!task || !stateTask || stateTask.status !== "done" || !stateTask.commit) continue
    const picked = await cherryPick(dir, stateTask.commit)
    if (!picked.ok) {
      return { dir, error: `cherry-pick ${id}: ${picked.error ?? "conflict"}` }
    }
  }
  rt.run.store.state.diffStat = await diffStat(dir, rt.baseInfo.commit)
  rt.run.store.state.changedFiles = await changedFilesInDiff(dir, rt.baseInfo.commit)
  await rt.run.store.append("integration.updated", {
    commits: rt.run.store.state.commits.length,
    changedFiles: rt.run.store.state.changedFiles,
  })
  return { dir }
}

async function updateIntegrationDiff(run: RunContext, baseCommit: string): Promise<void> {
  if (!run.store.state.integrationWorktree) return
  run.store.state.diffStat = await diffStat(run.store.state.integrationWorktree, baseCommit)
  run.store.state.changedFiles = await changedFilesInDiff(run.store.state.integrationWorktree, baseCommit)
}

async function runGateWithMetrics(
  rt: RuntimeBase,
  worktree: string,
  commands: readonly string[],
): Promise<GateResult> {
  const gate = await rt.semaphore.withSlot(() =>
    runGate(worktree, commands, rt.options.timeoutMinutes * 60_000, rt.gateEnv),
  )
  rt.run.store.state.gate = gate
  await rt.run.store.setGate(gate)
  return gate
}

async function targetedFix(
  rt: RuntimeBase & { plan: SquadPlan; verification: string[] },
  integrationDir: string,
  task: PlanTask,
  gate: GateResult,
): Promise<GateResult> {
  const triage = rt.run.store.state.triage
  if (!triage) return gate
  for (let attempt = 1; attempt <= TARGETED_FIX_ATTEMPTS && !gate.ok; attempt++) {
    await assertRunnable(rt)
    await progress(rt, `Squad: targeted fix ${task.id}, attempt ${attempt}`)
    const before = await currentHead(integrationDir)
    const session = await rt.input.ctx.session.create({
      title: `squad triage ${rt.run.runId} ${task.id} ${attempt}`,
      agent: task.role,
      parentID: rt.input.parentSessionID,
      model: modelFor(rt, task.role) || undefined,
      location: { directory: integrationDir },
      metadata: {
        squadRunId: rt.run.runId,
        squadTaskId: task.id,
        role: task.role,
        phase: "triage",
      },
      permissions: contractPermissions(rt.plan, task),
    })
    void registerSession(session.id, rt.run.runId, task.id).then(() => syncActiveRun(rt.run)).catch(() => undefined)
    const diff = await diffPaths(integrationDir, rt.baseInfo.commit, task.files)
    const result = await promptSessionWithFallback(rt.input.ctx, {
      sessionID: session.id,
      prompt: targetedFixPrompt({
        state: rt.run.store.state,
        task,
        contract: rt.plan.contracts?.join(", "),
        errorExcerpt: gate.output.slice(-6_000),
        diff,
        files: task.files,
        worktree: integrationDir,
        rules: rt.rules,
      }),
      timeoutMs: rt.options.timeoutMinutes * 60_000,
      agent: task.role,
      location: integrationDir,
      parentSessionID: rt.input.parentSessionID,
      fallbackModel: fallbackModel(rt),
      permissions: contractPermissions(rt.plan, task),
      metadata: {
        squadRunId: rt.run.runId,
        squadTaskId: task.id,
        role: task.role,
        phase: "triage",
      },
      title: `squad triage fallback ${rt.run.runId} ${task.id} ${attempt}`,
      runId: rt.run.runId,
      taskId: task.id,
      phase: "triage",
      onSession: (sessionID) => {
        void registerSession(sessionID, rt.run.runId, task.id)
          .then(() => syncActiveRun(rt.run))
          .catch(() => undefined)
      },
    })
    await recordSessionUsage(rt, result.sessionID)
    if (result.usedFallback) {
      await rt.run.store.addWarning(`Triage fix ${task.id}: использован fallback-модель.`)
    }
    if (result.errorKind === "provider") {
      rt.stopReason = result.error ?? "provider error"
      rt.run.store.state.providerError = rt.stopReason
      throw new Error(rt.stopReason)
    }
    if (result.status !== "ok" || !result.text.trim()) {
      await rt.run.store.addWarning(`Triage fix ${task.id}: ${result.error ?? result.status}`)
      break
    }
    const changed = await pendingChangedFiles(integrationDir, before)
    const ownershipViolations = changed.filter(
      (file) => !task.files.some((pattern) => pathOverlaps(file, pattern)),
    )
    if (ownershipViolations.length) {
      await resetWorktreeTo(integrationDir, before)
      rt.run.store.state.triage = { ...triage, attempts: attempt }
      await rt.run.store.addWarning(
        `Triage fix ${task.id}: ownership_violation ${ownershipViolations.join(", ")}; изменения откатаны.`,
      )
      await rt.run.store.append("triage.attempt", {
        taskId: task.id,
        attempt,
        ownershipViolation: ownershipViolations,
      })
      break
    }
    await commitWorktree(integrationDir, `squad(${task.id}): targeted verification fix ${attempt}`)
    const after = await currentHead(integrationDir)
    if (after === before) {
      await rt.run.store.addWarning(`Triage fix ${task.id}: агент не изменил файлы.`)
      break
    }
    metricsOf(rt.run).fixRounds++
    rt.run.store.state.triage = { ...triage, attempts: attempt }
    await rt.run.store.addCommit("triage", after, `targeted verification fix ${attempt}`)
    await rt.run.store.append("triage.attempt", { taskId: task.id, attempt, commit: after })
    await updateIntegrationDiff(rt.run, rt.baseInfo.commit)
    gate = await runGateWithMetrics(rt, integrationDir, rt.verification)
  }
  return gate
}

async function fixGateWithLid(
  rt: RuntimeBase & { plan: SquadPlan; verification: string[] },
  integrationDir: string,
  initialGate: GateResult,
  ideal: boolean,
): Promise<GateResult> {
  let gate = initialGate
  if (gate.ok || !rt.verification.length) return gate

  const candidate = await triageGateFailure({
    output: gate.output,
    plan: rt.plan,
    state: rt.run.store.state,
    adapter: rt.adapter,
    model: modelFor(rt, "critic"),
    fallbackModel: fallbackModel(rt),
    timeoutMs: 60_000,
  })
  if (candidate && candidate.confidence >= 0.7) {
    const task = rt.plan.tasks.find((item) => item.id === candidate.taskId)
    if (task) {
      rt.run.store.state.triage = {
        taskId: candidate.taskId,
        confidence: candidate.confidence,
        files: candidate.files.length ? candidate.files : task.files,
        attempts: 0,
        source: candidate.source,
        reason: candidate.reason,
      }
      await rt.run.store.append("triage.selected", { ...rt.run.store.state.triage })
      await progress(rt, `Squad: triage -> ${candidate.taskId} (${candidate.confidence.toFixed(2)}, ${candidate.source})`)
      gate = await targetedFix(rt, integrationDir, task, gate)
      if (gate.ok) return gate
    }
  }

  const rounds = ideal ? 8 : 2
  for (let round = 1; round <= rounds && !gate.ok; round++) {
    await assertRunnable(rt)
    await progress(rt, `Squad: Lid fix verification, round ${round}`)
    try {
      const lid = await createLidSession(rt.input.ctx, {
        project: integrationDir,
        parentSessionID: rt.input.parentSessionID,
        model: lidModel(rt),
        runId: rt.run.runId,
        title: `fix-${round}`,
      })
      void registerSession(lid.id, rt.run.runId)
        .then(() => syncActiveRun(rt.run))
        .catch(() => undefined)
      const result = await promptSessionWithFallback(rt.input.ctx, {
        sessionID: lid.id,
        prompt: lidFixPrompt({
          state: rt.run.store.state,
          gateOutput: gate.output,
          diffStat: rt.run.store.state.diffStat ?? "",
          changedFiles: (rt.run.store.state.changedFiles ?? []).join("\n"),
          rules: rt.rules,
          worktree: integrationDir,
        }),
        timeoutMs: rt.options.timeoutMinutes * 60_000,
        agent: "team-lid",
        location: integrationDir,
        parentSessionID: rt.input.parentSessionID,
        fallbackModel: fallbackModel(rt),
        metadata: {
          squadRunId: rt.run.runId,
          role: "team-lid",
          phase: "lid",
          title: `fix-${round}`,
        },
        title: `squad lid-fix fallback ${rt.run.runId} ${round}`,
        runId: rt.run.runId,
        taskId: "lid-fix",
        phase: "lid",
        onSession: (sessionID) => {
          void registerSession(sessionID, rt.run.runId)
            .then(() => syncActiveRun(rt.run))
            .catch(() => undefined)
        },
      })
      await recordSessionUsage(rt, result.sessionID)
      if (result.usedFallback) {
        await rt.run.store.addWarning(`Lid fix round ${round}: использован fallback-модель.`)
      }
      if (result.errorKind === "provider") {
        rt.stopReason = result.error ?? "provider error"
        rt.run.store.state.providerError = rt.stopReason
        throw new Error(rt.stopReason)
      }
      if (result.status !== "ok" || !result.text.trim() || /^\s*STOP\b/i.test(result.text)) break
      const before = await currentHead(integrationDir)
      await commitWorktree(integrationDir, `squad: verification fix ${round}`)
      const after = await currentHead(integrationDir)
      if (after !== before) {
        metricsOf(rt.run).fixRounds++
        await rt.run.store.addCommit("lid", after, `verification fix ${round}`)
        await updateIntegrationDiff(rt.run, rt.baseInfo.commit)
      }
    } catch (error) {
      if (rt.stopReason) throw error
      await rt.run.store.addWarning(`Lid fix round ${round}: ${errorMessage(error)}`)
      break
    }
    gate = await runGateWithMetrics(rt, integrationDir, rt.verification)
  }
  return gate
}

interface FinalizeInput {
  input: OrchestratorInput
  options: SquadOptions
  run: RunContext
  delivered: boolean
  cancelled?: boolean
  error?: string
  analystDigest: string
  criticDigest: string
}

async function skipPendingTasks(run: RunContext, reason: string): Promise<void> {
  for (const task of Object.values(run.store.state.tasks)) {
    if (task.status !== "pending" && task.status !== "ready") continue
    await run.store.setTask(task.id, { status: "skipped", error: reason, finishedAt: now() })
  }
}

async function finalize(params: FinalizeInput): Promise<RunResult> {
  const { run, options } = params
  const store = run.store
  const metrics = metricsOf(run)
  metrics.finishedAt = now()
  if (!params.delivered) {
    await skipPendingTasks(run, params.error ?? "Run остановлен.")
  }
  const status: RunStatus = params.cancelled ? "cancelled" : params.delivered ? "delivered" : "failed"
  await store.setStatus(status, params.error)
  await syncActiveRun(run).catch(() => undefined)

  if (store.state.integrationWorktree) {
    try {
      await updateIntegrationDiff(run, store.state.baseCommit ?? "HEAD")
    } catch {
      // Diff may be unavailable after a failed integration; the report still has commits.
    }
    await store.append("run.diff", {
      diffStat: store.state.diffStat ?? "",
      changedFiles: store.state.changedFiles ?? [],
    })
  }

  const cleanup = !options.keepWorktrees && (params.delivered || options.cleanupOnFailure === true)
  if (cleanup) {
    for (const task of Object.values(store.state.tasks)) {
      if (!task.worktree) continue
      await removeWorktree(params.input.project, task.worktree)
      if (task.branch) await deleteBranch(params.input.project, task.branch)
    }
    if (store.state.integrationWorktree) {
      await removeWorktree(params.input.project, store.state.integrationWorktree)
      store.state.integrationWorktree = undefined
    }
  } else {
    if (options.keepWorktrees) await store.addWarning("Worktrees оставлены по флагу --keep-worktrees.")
    else if (!params.delivered) {
      await store.addWarning("Run failed: worktrees и ветки сохранены для разбора. Для очистки используй --cleanup-on-failure.")
    }
  }
  await pruneWorktrees(params.input.project)
  await store.persist()
  const summary = renderSummary(store.state)
  await store.writeText("summary.md", summary)
  const report = renderReport(store.state, {
    analystDigest: params.analystDigest,
    criticDigest: params.criticDigest,
  })
  await writeFile(store.state.artifacts.report, report, "utf8")
  await store.writeText("SQUAD_REPORT.md", report)
  cleanupRun(run.runId)
  await unregisterRun(run.runId).catch(() => undefined)
  clearRunCancelled(run.runId)
  await progress(params.input, `Squad: ${status}. Ветка: ${store.state.branch}`)
  return {
    runId: store.state.runId,
    status: store.state.status,
    summary,
    reportPath: store.state.artifacts.report,
    branch: store.state.branch,
    runDir: store.state.artifacts.runDir,
    error: store.state.error,
  }
}

function effectiveOptions(options: SquadOptions, config: SquadConfig): SquadOptions {
  const configuredBuild = options.buildConcurrency ?? config.buildConcurrency ?? 2
  const batch = options.batch === true
  return {
    ...options,
    contracts: options.contracts,
    batch,
    localGate: options.localGate ?? "auto",
    cleanupOnFailure: options.cleanupOnFailure === true,
    analysisOnly: options.analysisOnly === true,
    strictTests: options.strictTests === true,
    buildConcurrency: batch ? Math.max(2, Math.min(3, configuredBuild)) : configuredBuild,
    maxCostUsd: options.maxCostUsd ?? config.maxCostUsd,
    maxTotalTokens: options.maxTotalTokens ?? config.maxTotalTokens,
    maxRunMinutes: options.maxRunMinutes ?? config.maxRunMinutes,
  }
}

export async function orchestrate(input: OrchestratorInput): Promise<RunResult> {
  assertSafeProject(input.project)
  const project = await repoRoot(input.project)
  await ensureExclude(project, [".squad/", "SQUAD_REPORT.md"])
  const loaded = await loadSquadConfig(project)
  const options = effectiveOptions(input.options, loaded.config)
  const limits = budgetLimits(options)
  if (options.batch && !hasBudget(limits)) {
    throw new Error("Batch требует budget: --max-cost, --max-tokens или --max-minutes (или squad.json).")
  }
  const runId = createRunId()
  const branch = branchName(options.task, runId)
  let baseInfo: BaseInfo = await resolveBase(project, options.base)
  const store = await RunStore.create({
    project,
    task: options.task,
    base: baseInfo.ref,
    baseCommit: baseInfo.commit,
    baseSource: baseInfo.source,
    branch,
    runId,
  })
  await store.setBudget(limits)
  for (const warning of loaded.warnings) await store.addWarning(warning)
  const run: RunContext = {
    runId,
    project,
    store,
    parentSessionID: input.parentSessionID ?? "",
    taskSessions: new Map(),
  }
  await registerRun(run)
  const effectiveInput: OrchestratorInput = { ...input, project, options }
  const buildLimit = options.buildConcurrency ?? 2
  let buildConfigured = false
  let buildReleased = false
  const releaseBuild = (): void => {
    if (!buildConfigured || buildReleased) return
    buildReleased = true
    releaseGlobalBuildConcurrency(buildLimit)
  }
  let analystDigest = ""
  let criticDigest = ""
  try {
    await setRunStatus(run, "planning")
    await progress(effectiveInput, `Squad: старт ${runId}`)
    const rules = await readRules(project)
    const brief = await repoBrief(project)
    const config: SquadConfig = loaded.config
    const adapter = createOpenCodeAdapter(input.ctx, config)
    const semaphore = configureGlobalBuildConcurrency(buildLimit)
    buildConfigured = true
    const gateEnv = gateEnvironment({ sccache: config.sccache === true })
    await store.append("adapter.selected", { mode: adapter.mode })
    const base: RuntimeBase = {
      input: effectiveInput,
      options,
      run,
      rules,
      config,
      adapter,
      semaphore,
      gateEnv,
      baseInfo,
    }

    const planStarted = Date.now()
    const lid = await createLidSession(input.ctx, {
      project,
      parentSessionID: input.parentSessionID,
      model: lidModel(base),
      runId,
      title: "plan",
    })
    run.lidSessionID = lid.id
    await registerSession(lid.id, runId)
    await syncActiveRun(run).catch(() => undefined)
    let plan: SquadPlan | undefined
    let planError = ""
    let lidSessionID = lid.id
    let planningFallbackNoted = false
    for (let attempt = 1; attempt <= PLAN_ATTEMPTS; attempt++) {
      const prompt = attempt === 1
        ? planPrompt({ task: options.task, rules, repoBrief: brief, options })
        : planRetryPrompt(planError)
      const result = await promptSessionWithFallback(input.ctx, {
        sessionID: lidSessionID,
        prompt,
        timeoutMs: PLAN_TIMEOUT_MS,
        agent: "team-lid",
        location: project,
        parentSessionID: input.parentSessionID,
        fallbackModel: fallbackModel(base),
        metadata: {
          squadRunId: runId,
          role: "team-lid",
          phase: "lid",
          title: "plan",
        },
        title: `squad plan ${runId} attempt ${attempt}`,
        runId,
        taskId: "lid-plan",
        phase: "lid",
        onSession: (sessionID) => {
          void registerSession(sessionID, runId)
            .then(() => syncActiveRun(run))
            .catch(() => undefined)
        },
      })
      if (result.usedFallback) {
        lidSessionID = result.sessionID
        run.lidSessionID = lidSessionID
        run.extraSessions?.delete(lidSessionID)
        await registerSession(lidSessionID, runId)
        await syncActiveRun(run).catch(() => undefined)
        if (!planningFallbackNoted) {
          planningFallbackNoted = true
          await store.addWarning("Lid planning использовал fallback-модель.")
        }
      }
      if (result.errorKind === "provider") {
        throw new Error(result.error ?? "provider error")
      }
      if (result.status !== "ok" || !result.text.trim()) {
        planError = result.error ?? "Lid вернул пустой ответ."
        continue
      }
      try {
        plan = parsePlan(result.text, options)
        break
      } catch (error) {
        planError = errorMessage(error)
      }
    }
    await recordSessionUsage(base, lidSessionID)
    recordPhase(metricsOf(run), "plan", planStarted)
    if (!plan) {
      plan = defaultPlan(options)
      await store.addWarning(`Lid не дал валидный план: ${planError}. Использован fallback.`)
    }
    if (plan.base && !options.base && plan.base !== baseInfo.ref) {
      try {
        baseInfo = await resolveBase(project, plan.base)
        store.state.base = baseInfo.ref
        store.state.baseCommit = baseInfo.commit
        store.state.baseSource = baseInfo.source
        await store.append("run.base", { base: baseInfo.ref, commit: baseInfo.commit, source: baseInfo.source })
      } catch (error) {
        await store.addWarning(`База из плана недоступна: ${errorMessage(error)}`)
      }
    }
    await store.setPlan(plan)
    const verification = await detectVerification(project, plan, rules, options.verify)
    const ideal = options.ideal || plan.ideal === true
    const rt: Runtime = { ...base, baseInfo, plan, verification }
    await setRunStatus(run, "running")
    await progress(effectiveInput, `Squad: план ${plan.tasks.length} задач, база ${baseInfo.ref}`)
    await assertRunnable(rt)

    const analysts = options.batch ? [] : plan.tasks.filter((task) => task.role === "analyst")
    const analystsStarted = Date.now()
    const analystResults = await runReadOnlyPhase(rt, {
      tasks: analysts,
      location: project,
      isWorktree: false,
      analystDigest: "",
      label: "analyst",
    })
    recordPhase(metricsOf(run), "analysts", analystsStarted)
    analystDigest = digestResults(analystResults)

    const builders = plan.tasks.filter((task) => builderRole(task.role))
    const buildersStarted = Date.now()
    const builderResults = await runBuilderPhase(rt, builders, analystDigest)
    recordPhase(metricsOf(run), "builders", buildersStarted)

    let integrationError: string | undefined
    let gate: GateResult | undefined
    const integrationStarted = Date.now()
    if (builders.length && !rt.stopReason) {
      await progress(effectiveInput, "Squad: интеграция")
      const integration = await createIntegration(rt, builders)
      recordPhase(metricsOf(run), "integration", integrationStarted)
      integrationError = integration.error
      if (!integrationError) {
        const gateStarted = Date.now()
        await setRunStatus(run, "verifying")
        gate = await runGateWithMetrics(rt, integration.dir, verification)
        gate = await fixGateWithLid(rt, integration.dir, gate, ideal)
        recordPhase(metricsOf(run), "gate", gateStarted)
        await assertBudget(rt)
      }
    } else {
      recordPhase(metricsOf(run), "integration", integrationStarted)
    }

    if (!rt.stopReason && !options.batch) {
      const criticsStarted = Date.now()
      const critics = plan.tasks.filter((task) => task.role === "critic")
      const criticDigestPrefix = [
        digestResults(builderResults),
        gate ? `## Verification\n${gate.output}` : "",
        integrationError ? `## Integration error\n${integrationError}` : "",
      ].filter(Boolean).join("\n\n")
      const criticResults = await runReadOnlyPhase(rt, {
        tasks: critics,
        location: store.state.integrationWorktree ?? project,
        isWorktree: Boolean(store.state.integrationWorktree),
        analystDigest: criticDigestPrefix,
        label: "critic",
      })
      recordPhase(metricsOf(run), "critics", criticsStarted)
      criticDigest = digestResults(criticResults)
      for (const warning of blockingCriticFindings(criticResults)) {
        await store.addWarning(warning)
      }
    }

    const builderFailed = builders.some((task) => store.state.tasks[task.id]?.status !== "done")
    const delivered = !rt.stopReason &&
      !integrationError &&
      !builderFailed &&
      (builders.length === 0 ? options.analysisOnly === true : gate?.ok === true)
    const failure = rt.stopReason ??
      integrationError ??
      (builderFailed ? "Часть builder-задач не выполнена." : gate && !gate.ok ? "Verification gate красный." : undefined)
    releaseBuild()
    return await finalize({
      input: effectiveInput,
      options,
      run,
      delivered,
      error: failure,
      analystDigest,
      criticDigest,
    })
  } catch (error) {
    const cancelled = isRunCancelled(runId) || store.state.status === "cancelled"
    const message = cancelled ? "Отменён пользователем." : errorMessage(error)
    releaseBuild()
    try {
      return await finalize({
        input: effectiveInput,
        options,
        run,
        delivered: false,
        cancelled,
        error: message,
        analystDigest,
        criticDigest,
      })
    } catch {
      await store.setStatus(cancelled ? "cancelled" : "failed", message).catch(() => undefined)
      cleanupRun(runId)
      await unregisterRun(runId).catch(() => undefined)
      clearRunCancelled(runId)
      return {
        runId,
        status: store.state.status,
        summary: renderSummary(store.state),
        reportPath: store.state.artifacts.report,
        branch: store.state.branch,
        runDir: store.state.artifacts.runDir,
        error: message,
      }
    }
  }
}
