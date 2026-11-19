export type SquadRole = "analyst" | "executor" | "visual-executor" | "critic"

export type TaskStatus = "pending" | "ready" | "running" | "done" | "failed" | "skipped"

export type RunStatus = "planning" | "running" | "verifying" | "delivered" | "failed" | "cancelled" | "interrupted"

export type LocalGateMode = "auto" | "strict" | "off"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny"
}

export interface SquadOptions {
  task: string
  maxTasks: number
  roles: SquadRole[]
  concurrency: number
  timeoutMinutes: number
  ideal: boolean
  base?: string
  verify: string[]
  keepWorktrees: boolean
  parentSessionID?: string
  projectDir?: string
  contracts?: boolean
  batch?: boolean
  localGate?: LocalGateMode
  cleanupOnFailure?: boolean
  analysisOnly?: boolean
  strictTests?: boolean
  buildConcurrency?: number
  maxCostUsd?: number
  maxTotalTokens?: number
  maxRunMinutes?: number
}

export interface PlanTask {
  id: string
  title: string
  role: SquadRole
  files: string[]
  dependsOn: string[]
  instructions: string
  acceptance: string[]
  checks?: string[]
  requiresTests?: boolean
  contract?: boolean
}

export interface SquadPlan {
  summary: string
  base?: string
  verification: string[]
  ideal?: boolean
  tasks: PlanTask[]
  contracts?: string[]
}

export interface TaskState {
  id: string
  title: string
  role: SquadRole
  status: TaskStatus
  dependsOn: string[]
  files: string[]
  sessionID?: string
  worktree?: string
  branch?: string
  commit?: string
  patch?: string
  result?: string
  error?: string
  startedAt?: string
  finishedAt?: string
  cost?: number
  tokens?: number
  durationMs?: number
  localGate?: GateResult
  localGateLog?: string
  requiresTests?: boolean
}

export interface GateResult {
  ok: boolean
  commands: string[]
  output: string
  startedAt: string
  finishedAt: string
}

export type QuestionStatus = "pending" | "answered" | "assumed" | "stopped" | "needs_attention"

export interface SquadQuestion {
  id: string
  taskId?: string
  from: string
  text: string
  destructive: boolean
  status: QuestionStatus
  answer?: string
  answeredBy?: string
  askedAt: string
  answeredAt?: string
}

export type BoardEntryType = "note" | "question" | "answer" | "decision" | "assumption" | "status" | "dependency"

export interface BoardEntry {
  id: string
  ts: string
  from: string
  to?: string
  type: BoardEntryType
  text: string
  taskId?: string
  tags?: string[]
  artifact?: string
}

export interface RunArtifacts {
  runDir: string
  report: string
  summary: string
  planJson?: string
  planMarkdown?: string
  patch?: string
}

export interface TokenUsage {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface ProviderError {
  kind: "provider" | "rate_limit" | "quota" | "auth" | "overloaded" | "timeout" | "empty"
  message: string
  status?: number
  fatal: boolean
}

export interface BudgetLimits {
  maxCostUsd?: number
  maxTotalTokens?: number
  maxRunMinutes?: number
}

export interface PhaseTimings {
  plan: number
  analysts: number
  builders: number
  integration: number
  gate: number
  critics: number
}

export interface RunMetrics {
  startedAt: string
  finishedAt?: string
  phaseMs: PhaseTimings
  gateRuns: number
  fixRounds: number
  providerErrors: number
  totalCost: number
  totalTokens: number
}

export type TriageSource = "deterministic" | "model" | "lid"

export interface TriageState {
  taskId: string
  confidence: number
  files: string[]
  attempts: number
  source: TriageSource
  reason?: string
}

export interface RunState {
  schemaVersion?: number
  revision?: number
  runId: string
  task: string
  project: string
  base: string
  baseCommit?: string
  baseSource?: string
  branch: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  finishedAt?: string
  plan?: SquadPlan
  tasks: Record<string, TaskState>
  gate?: GateResult
  questions: SquadQuestion[]
  board: BoardEntry[]
  artifacts: RunArtifacts
  error?: string
  warnings: string[]
  commits: { taskId: string; commit: string; title: string }[]
  diffStat?: string
  changedFiles?: string[]
  integrationWorktree?: string
  metrics?: RunMetrics
  budget?: BudgetLimits
  triage?: TriageState
  providerError?: string
}

export interface AgentRunRequest {
  task: PlanTask
  plan: SquadPlan
  project: string
  location: string
  isWorktree: boolean
  rules: string
  analystDigest: string
  boardDigest: string
  timeoutMs: number
  parentSessionID?: string
  model?: unknown
  runId: string
  runDir: string
}

export type AgentRunStatus = "ok" | "timeout" | "error" | "empty"

export interface AgentRunResult {
  id: string
  role: SquadRole
  status: AgentRunStatus
  text: string
  sessionID: string
  durationMs: number
  error?: string
  errorKind?: "provider" | "timeout" | "empty" | "error"
  rawError?: string
  cost?: unknown
  tokens?: unknown
  messages?: unknown
  info?: unknown
  modelFallback?: boolean
}

export interface RunResult {
  runId: string
  status: RunStatus
  summary: string
  reportPath: string
  branch: string
  runDir: string
  error?: string
}

export interface RepoRules {
  text: string
  verification: string[]
  sources: string[]
}

export interface QuestionContext {
  store: unknown
  runId: string
  project: string
  parentSessionID: string
  taskId?: string
  from: string
  text: string
  destructive: boolean
}

export interface BoardContext {
  runId: string
  project: string
  taskId?: string
  from: string
}

export interface StatusSnapshot {
  runId: string
  task: string
  status: RunStatus
  branch: string
  base: string
  updatedAt: string
  revision?: number
  gate?: GateResult
  tasks: TaskState[]
  questions: SquadQuestion[]
  commits: { taskId: string; commit: string; title: string }[]
  error?: string
  metrics?: RunMetrics
  budget?: BudgetLimits
  triage?: TriageState
}
