import type { AgentRunResult, BudgetLimits, RunMetrics, RunState, TaskState } from "./types.ts"

export function nowIso(): string {
  return new Date().toISOString()
}

export function createRunMetrics(startedAt = nowIso()): RunMetrics {
  return {
    startedAt,
    phaseMs: {
      plan: 0,
      analysts: 0,
      builders: 0,
      integration: 0,
      gate: 0,
      critics: 0,
    },
    gateRuns: 0,
    fixRounds: 0,
    providerErrors: 0,
    totalCost: 0,
    totalTokens: 0,
  }
}

export function costNumber(cost: unknown): number {
  if (typeof cost === "number" && Number.isFinite(cost)) return cost
  if (!cost || typeof cost !== "object") return 0
  const value = cost as Record<string, unknown>
  if (typeof value.total === "number" && Number.isFinite(value.total)) return value.total
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0
  return input + output
}

export function tokenNumber(tokens: unknown): number {
  if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens
  if (!tokens || typeof tokens !== "object") return 0
  const value = tokens as Record<string, unknown>
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0
  const reasoning = typeof value.reasoning === "number" && Number.isFinite(value.reasoning) ? value.reasoning : 0
  if (input || output) return input + output
  return reasoning
}

export function recordTaskUsage(task: TaskState, result: AgentRunResult): void {
  const cost = costNumber(result.cost)
  const tokens = tokenNumber(result.tokens)
  task.cost = cost
  task.tokens = tokens
  task.durationMs = Math.max(0, Math.round(result.durationMs || 0))
}

export function recordResultUsage(metrics: RunMetrics, result: AgentRunResult): void {
  metrics.totalCost += costNumber(result.cost)
  metrics.totalTokens += tokenNumber(result.tokens)
  if (result.errorKind === "provider") metrics.providerErrors++
}

export function recordPhase(metrics: RunMetrics, phase: keyof RunMetrics["phaseMs"], started: number): void {
  metrics.phaseMs[phase] += Math.max(0, Date.now() - started)
}

export function budgetExceeded(state: RunState, limits: BudgetLimits): string | undefined {
  const metrics = state.metrics
  if (!metrics) return undefined
  if (typeof limits.maxCostUsd === "number" && metrics.totalCost > limits.maxCostUsd) {
    return `budget_exceeded: cost ${metrics.totalCost.toFixed(6)} > ${limits.maxCostUsd}`
  }
  if (typeof limits.maxTotalTokens === "number" && metrics.totalTokens > limits.maxTotalTokens) {
    return `budget_exceeded: tokens ${metrics.totalTokens} > ${limits.maxTotalTokens}`
  }
  if (typeof limits.maxRunMinutes === "number") {
    const elapsed = (Date.now() - Date.parse(metrics.startedAt)) / 60_000
    if (Number.isFinite(elapsed) && elapsed > limits.maxRunMinutes) {
      return `budget_exceeded: ${Math.round(elapsed)}m > ${limits.maxRunMinutes}m`
    }
  }
  return undefined
}
