import type { OpenCodeAdapter } from "./opencode-adapter.ts"
import { normalizeGlob, pathOverlaps } from "./plan.ts"
import type { RunState, SquadPlan, TriageSource } from "./types.ts"

export interface TriageCandidate {
  taskId: string
  confidence: number
  files: string[]
  source: TriageSource
  reason?: string
}

export interface TriageInput {
  output: string
  plan: SquadPlan
  state: RunState
  adapter: OpenCodeAdapter
  model?: unknown
  fallbackModel?: unknown
  timeoutMs?: number
}

function cleanPath(value: string): string {
  return value.trim().replace(/^["'(]+|["'),]+$/g, "").replace(/\\/g, "/").replace(/^\.\//, "")
}

export function extractErrorPaths(output: string): string[] {
  const paths = new Set<string>()
  const patterns = [
    /-->\s+([^\s:]+):(\d+)(?::\d+)?/g,
    /File\s+"([^"]+)",\s+line\s+\d+/g,
    /\bat\s+([^\s():]+):(\d+)(?::\d+)?/g,
    /(?:^|\s)((?:[A-Za-z]:)?[^\s:()]+\.\w+):(\d+)(?::\d+)?/g,
    /(?:^|\s)((?:[A-Za-z]:)?[^\s:()]+\.\w+)\((\d+),\d+\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const value = cleanPath(match[1] ?? "")
      if (!value || value.startsWith("http") || value.length < 2) continue
      if (!/[./\\]/.test(value)) continue
      paths.add(value)
    }
  }
  return [...paths]
}

function matchesTaskPath(errorPath: string, file: string): boolean {
  const value = cleanPath(errorPath).replace(/^[A-Za-z]:\//, "")
  if (pathOverlaps(value, file)) return true
  const base = normalizeGlob(file).replace(/^[A-Za-z]:\//, "")
  if (!base) return false
  if (value === base) return true
  if (value.endsWith(`/${base}`)) return true
  if (value.includes(`/${base}/`)) return true
  return false
}

export function mapPathsToTasks(paths: readonly string[], plan: SquadPlan, state: RunState): TriageCandidate[] {
  const unique = [...new Set(paths.map(cleanPath).filter(Boolean))]
  if (!unique.length) return []
  const matches = new Map<string, Set<string>>()
  for (const errorPath of unique) {
    for (const task of plan.tasks) {
      const files = [...task.files, ...(state.tasks[task.id]?.files ?? [])]
      if (!files.some((file) => matchesTaskPath(errorPath, file))) continue
      const set = matches.get(task.id) ?? new Set<string>()
      set.add(errorPath)
      matches.set(task.id, set)
    }
  }
  const candidates: TriageCandidate[] = []
  for (const [taskId, matched] of matches) {
    const task = plan.tasks.find((item) => item.id === taskId)
    const uniqueOwner = matches.size === 1
    const coverage = matched.size / unique.length
    const confidence = Math.min(0.98, coverage * (uniqueOwner ? 0.95 : 0.55))
    candidates.push({
      taskId,
      confidence,
      files: [...matched],
      source: "deterministic",
      reason: task ? `Совпали пути задачи ${task.id}` : undefined,
    })
  }
  return candidates.sort((left, right) => right.confidence - left.confidence)
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "")
  const candidates = fenced.length ? fenced : []
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

export async function classifyWithModel(input: TriageInput): Promise<TriageCandidate | undefined> {
  const tasks = input.plan.tasks
    .filter((task) => task.files.length)
    .map((task) => `- ${task.id}: ${task.files.join(", ")}`)
    .join("\n")
  const prompt = `Ты классифицируешь ошибку verification по задачам squad. Верни ТОЛЬКО JSON:
{"taskId":"id","confidence":0.0,"files":["path"],"reason":"кратко"}

## Задачи и их файлы
${tasks || "нет задач с files"}

## Diff stat
${input.state.diffStat || "нет diff"}

## Изменённые файлы
${(input.state.changedFiles ?? []).join("\n") || "нет"}

## Хвост вывода gate
${input.output.slice(-6_000)}`

  const text = await input.adapter.generateText(prompt, input.model, input.timeoutMs ?? 60_000)
    ?? (input.fallbackModel
      ? await input.adapter.generateText(prompt, input.fallbackModel, input.timeoutMs ?? 60_000)
      : undefined)
  if (!text) return undefined
  const value = parseJsonObject(text)
  if (!value) return undefined
  const taskId = typeof value.taskId === "string" ? value.taskId : ""
  const task = input.plan.tasks.find((item) => item.id === taskId)
  if (!task) return undefined
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0
  const files = Array.isArray(value.files)
    ? value.files.filter((item): item is string => typeof item === "string")
    : []
  return {
    taskId,
    confidence,
    files,
    source: "model",
    reason: typeof value.reason === "string" ? value.reason : undefined,
  }
}

export async function triageGateFailure(input: TriageInput): Promise<TriageCandidate | undefined> {
  const deterministic = mapPathsToTasks(extractErrorPaths(input.output), input.plan, input.state)
  const best = deterministic[0]
  if (best && best.confidence >= 0.7) return best
  const modeled = await classifyWithModel(input)
  if (modeled && modeled.confidence >= 0.7) return modeled
  return undefined
}
