import type {
  AgentRunResult,
  PermissionRule,
  PlanTask,
  ProviderError,
  SquadPlan,
} from "./types.ts"

export interface SessionRecord {
  id: string
  [key: string]: unknown
}

export interface ExperimentalGenerateInput {
  prompt: string
  model?: unknown
}

export interface ExperimentalApi {
  generate?: {
    text?: (input: ExperimentalGenerateInput) => Promise<unknown>
  }
}

export interface AgentContext {
  session: {
    create(input: {
      title: string
      agent: string
      parentID?: string
      model?: unknown
      location: { directory: string }
      metadata?: Record<string, unknown>
      permissions?: PermissionRule[]
    }): Promise<SessionRecord>
    prompt(input: { sessionID: string; text: string }): Promise<unknown>
    wait(input: { sessionID: string }): Promise<unknown>
    interrupt(input: { sessionID: string; resume: boolean }): Promise<unknown>
    context(input: { sessionID: string }): Promise<unknown>
    get(input: { sessionID: string }): Promise<unknown>
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>
    hook?: Record<string, unknown>
  }
  experimental?: ExperimentalApi
}

export type AgentPhase = "builder" | "analyst" | "critic" | "lid" | "triage"

export interface RunAgentInput {
  task: PlanTask
  plan: SquadPlan
  prompt: string
  location: string
  parentSessionID?: string
  model?: unknown
  fallbackModel?: unknown
  permissions?: PermissionRule[]
  timeoutMs: number
  runId: string
  phase: AgentPhase
  onSession?: (sessionID: string) => void
}

export function extractAssistantText(messages: unknown): string {
  const list = messageList(messages)
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index] as {
      type?: string
      role?: string
      content?: unknown[]
      parts?: unknown[]
    } | undefined
    if (!message) continue
    if (message.type !== "assistant" && message.role !== "assistant") continue
    const content = Array.isArray(message.content)
      ? message.content
      : Array.isArray(message.parts)
        ? message.parts
        : []
    const text = content
      .filter((part): part is { type?: string; text?: string } => typeof part === "object" && part !== null)
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function messageList(messages: unknown): unknown[] {
  if (Array.isArray(messages)) return messages
  const data = (messages as { data?: unknown })?.data
  return Array.isArray(data) ? data : []
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  const nested = record.error
  return [
    record.message,
    record.name,
    record.code,
    record.type,
    nested && typeof nested === "object" ? (nested as Record<string, unknown>).message : nested,
  ]
    .filter((part) => typeof part === "string" || typeof part === "number")
    .map(String)
    .join(": ")
}

function errorStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["status", "statusCode", "code"]) {
    const candidate = record[key]
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
    if (typeof candidate === "string" && /^\d{3}$/.test(candidate)) return Number(candidate)
  }
  return undefined
}

export function classifyProviderMessage(text: string, status?: number): ProviderError | undefined {
  const value = text.toLowerCase()
  const code = status
  const message = text.trim() || "provider error"
  if (/timeout|timed out|etimedout/.test(value)) {
    return { kind: "timeout", message, status: code, fatal: false }
  }
  if (/go-limit|quota|insufficient|billing|credit|payment required|402/.test(value) || code === 402) {
    return { kind: "quota", message, status: code, fatal: true }
  }
  if (/429|rate.?limit|too many requests|ratelimit/.test(value) || code === 429) {
    return { kind: "rate_limit", message, status: code, fatal: true }
  }
  if (/overloaded|service unavailable|bad gateway|gateway timeout|5(02|03|04)/.test(value) || [502, 503, 504].includes(code ?? 0)) {
    return { kind: "overloaded", message, status: code, fatal: true }
  }
  if (/unauthorized|forbidden|invalid api key|api key|auth(?:entication|orization)? (?:failed|error)|401|403/.test(value) || code === 401 || code === 403) {
    return { kind: "auth", message, status: code, fatal: true }
  }
  if (/provider/.test(value) && /error|failed|exhausted|unavailable/.test(value)) {
    return { kind: "provider", message, status: code, fatal: true }
  }
  return undefined
}

export function extractSessionError(messages: unknown): ProviderError | undefined {
  const list = messageList(messages)
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index] as {
      type?: string
      role?: string
      finish?: string
      finishReason?: string
      outcome?: string
      error?: unknown
      info?: { finish?: string; outcome?: string; error?: unknown }
    } | undefined
    if (!message) continue
    if (message.type !== "assistant" && message.role !== "assistant") continue
    const error = message.error ?? message.info?.error
    const finish = message.finish ?? message.finishReason ?? message.info?.finish
    const outcome = message.outcome ?? message.info?.outcome
    if (!error && finish !== "error" && outcome !== "failed") continue
    const text = errorText(error) || `assistant finished with ${finish ?? outcome ?? "error"}`
    const classified = classifyProviderMessage(text, errorStatus(error))
    return classified ?? { kind: "provider", message: text, fatal: true }
  }
  const rootError = (messages as { error?: unknown })?.error
  if (rootError) {
    const text = errorText(rootError)
    const classified = classifyProviderMessage(text, errorStatus(rootError))
    return classified ?? { kind: "provider", message: text, fatal: true }
  }
  return undefined
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T | { timedOut: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      try {
        await onTimeout()
      } catch {
        // Interrupt is best-effort; the run must continue.
      }
      resolve({ timedOut: true })
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

interface AttemptResult {
  status: AgentRunResult["status"]
  text: string
  sessionID: string
  error?: string
  errorKind?: AgentRunResult["errorKind"]
  rawError?: string
  info?: unknown
  messages?: unknown
}

export async function runAgent(ctx: AgentContext, input: RunAgentInput): Promise<AgentRunResult> {
  const started = Date.now()

  const attempt = async (model: unknown): Promise<AttemptResult> => {
    let sessionID = ""
    try {
      const session = await ctx.session.create({
        title: `squad ${input.runId} ${input.task.id}`,
        agent: input.task.role,
        parentID: input.parentSessionID,
        model: model || undefined,
        location: { directory: input.location },
        metadata: {
          squadRunId: input.runId,
          squadTaskId: input.task.id,
          role: input.task.role,
          phase: input.phase,
        },
        permissions: input.permissions?.length ? input.permissions : undefined,
      })
      sessionID = session.id
      input.onSession?.(sessionID)
      await ctx.session.prompt({ sessionID, text: input.prompt })
      const waited = await withTimeout(
        ctx.session.wait({ sessionID }),
        input.timeoutMs,
        () => ctx.session.interrupt({ sessionID, resume: false }).then(() => undefined),
      )
      const timedOut = Boolean(waited && typeof waited === "object" && "timedOut" in waited && waited.timedOut)
      const messages = await ctx.session.context({ sessionID })
      const text = extractAssistantText(messages)
      const sessionError = extractSessionError(messages)
      let info: unknown
      try {
        info = await ctx.session.get({ sessionID })
      } catch {
        // Session info is optional; the run must not fail because cost data is missing.
      }
      if (sessionError?.fatal) {
        return {
          status: "error",
          text,
          sessionID,
          error: `provider error: ${sessionError.message}`,
          errorKind: "provider",
          rawError: sessionError.message,
          info,
          messages,
        }
      }
      if (sessionError?.kind === "timeout" || timedOut) {
        return {
          status: "timeout",
          text,
          sessionID,
          error: sessionError?.message ?? `timeout ${Math.round(input.timeoutMs / 60_000)}m`,
          errorKind: "timeout",
          info,
          messages,
        }
      }
      if (!text) {
        return {
          status: "empty",
          text,
          sessionID,
          error: "agent returned no text",
          errorKind: "empty",
          info,
          messages,
        }
      }
      return { status: "ok", text, sessionID, info, messages }
    } catch (caught) {
      const text = String((caught as Error)?.message ?? caught)
      const provider = classifyProviderMessage(text, errorStatus(caught))
      return {
        status: "error",
        text: "",
        sessionID,
        error: provider ? `provider error: ${provider.message}` : text,
        errorKind: provider?.fatal ? "provider" : "error",
        rawError: text,
      }
    }
  }

  let result = await attempt(input.model)
  let modelFallback = false
  if (result.errorKind === "provider" && input.fallbackModel) {
    modelFallback = true
    if (result.sessionID) {
      await ctx.session.interrupt({ sessionID: result.sessionID, resume: false }).catch(() => undefined)
    }
    result = await attempt(input.fallbackModel)
  }
  const record = asRecord(result.info)
  return {
    id: input.task.id,
    role: input.task.role,
    status: result.status,
    text: result.text,
    sessionID: result.sessionID,
    durationMs: Date.now() - started,
    error: result.error,
    errorKind: result.errorKind,
    rawError: result.rawError,
    cost: record?.cost,
    tokens: record?.tokens,
    messages: result.messages,
    info: result.info,
    modelFallback: modelFallback || undefined,
  }
}

export async function promptSession(
  ctx: AgentContext,
  sessionID: string,
  prompt: string,
  timeoutMs: number,
): Promise<PromptResult> {
  try {
    await ctx.session.prompt({ sessionID, text: prompt })
    const waited = await withTimeout(
      ctx.session.wait({ sessionID }),
      timeoutMs,
      () => ctx.session.interrupt({ sessionID, resume: false }).then(() => undefined),
    )
    if (waited && typeof waited === "object" && "timedOut" in waited && waited.timedOut) {
      return { status: "timeout", text: "", error: `timeout ${Math.round(timeoutMs / 1000)}s`, errorKind: "timeout" }
    }
    const messages = await ctx.session.context({ sessionID })
    const sessionError = extractSessionError(messages)
    if (sessionError?.fatal) {
      return {
        status: "error",
        text: "",
        error: `provider error: ${sessionError.message}`,
        errorKind: "provider",
      }
    }
    if (sessionError?.kind === "timeout") {
      return { status: "timeout", text: "", error: sessionError.message, errorKind: "timeout" }
    }
    const text = extractAssistantText(messages)
    return { status: text ? "ok" : "error", text, error: text ? undefined : "empty response" }
  } catch (caught) {
    const text = String((caught as Error)?.message ?? caught)
    const provider = classifyProviderMessage(text, errorStatus(caught))
    return {
      status: "error",
      text: "",
      error: provider ? `provider error: ${provider.message}` : text,
      errorKind: provider?.fatal ? "provider" : undefined,
    }
  }
}

export interface PromptResult {
  status: "ok" | "timeout" | "error"
  text: string
  error?: string
  errorKind?: "provider" | "timeout"
}

export interface FallbackPromptInput {
  sessionID: string
  prompt: string
  timeoutMs: number
  agent: string
  location: string
  parentSessionID?: string
  fallbackModel?: unknown
  permissions?: PermissionRule[]
  metadata?: Record<string, unknown>
  title?: string
  runId: string
  taskId?: string
  phase?: AgentPhase
  onSession?: (sessionID: string) => void
}

export interface FallbackPromptResult extends PromptResult {
  sessionID: string
  usedFallback: boolean
}

export async function promptSessionWithFallback(
  ctx: AgentContext,
  input: FallbackPromptInput,
): Promise<FallbackPromptResult> {
  const first = await promptSession(ctx, input.sessionID, input.prompt, input.timeoutMs)
  if (first.errorKind !== "provider" || !input.fallbackModel) {
    return { ...first, sessionID: input.sessionID, usedFallback: false }
  }
  await ctx.session.interrupt({ sessionID: input.sessionID, resume: false }).catch(() => undefined)
  try {
    const session = await ctx.session.create({
      title: input.title ?? `squad fallback ${input.runId} ${input.taskId ?? input.agent}`,
      agent: input.agent,
      parentID: input.parentSessionID,
      model: input.fallbackModel,
      location: { directory: input.location },
      metadata: input.metadata ?? {
        squadRunId: input.runId,
        squadTaskId: input.taskId,
        role: input.agent,
        phase: input.phase ?? "lid",
      },
      permissions: input.permissions?.length ? input.permissions : undefined,
    })
    input.onSession?.(session.id)
    const second = await promptSession(ctx, session.id, input.prompt, input.timeoutMs)
    return { ...second, sessionID: session.id, usedFallback: true }
  } catch (caught) {
    const text = String((caught as Error)?.message ?? caught)
    const provider = classifyProviderMessage(text, errorStatus(caught))
    return {
      status: "error",
      text: "",
      error: provider ? `provider error: ${provider.message}` : text,
      errorKind: provider?.fatal ? "provider" : undefined,
      sessionID: input.sessionID,
      usedFallback: true,
    }
  }
}

export function continueAgent(
  ctx: AgentContext,
  sessionID: string,
  prompt: string,
  timeoutMs: number,
): Promise<PromptResult> {
  return promptSession(ctx, sessionID, prompt, timeoutMs)
}

export async function createLidSession(
  ctx: AgentContext,
  input: {
    project: string
    parentSessionID?: string
    model?: unknown
    runId: string
    title: string
    phase?: AgentPhase
  },
): Promise<SessionRecord> {
  return ctx.session.create({
    title: `squad lid ${input.runId} ${input.title}`,
    agent: "team-lid",
    parentID: input.parentSessionID,
    model: input.model || undefined,
    location: { directory: input.project },
    metadata: {
      squadRunId: input.runId,
      role: "team-lid",
      phase: input.phase ?? "lid",
      title: input.title,
    },
  })
}

export async function runLidPrompt(
  ctx: AgentContext,
  input: {
    prompt: string
    project: string
    parentSessionID?: string
    model?: unknown
    timeoutMs: number
    runId: string
    title: string
  },
): Promise<PromptResult & { sessionID: string }> {
  let sessionID = ""
  try {
    const session = await createLidSession(ctx, input)
    sessionID = session.id
    const result = await promptSession(ctx, sessionID, input.prompt, input.timeoutMs)
    return { ...result, sessionID }
  } catch (caught) {
    return { status: "error", text: "", sessionID, error: String((caught as Error)?.message ?? caught) }
  }
}

export function adapterLogLine(experimental: boolean): string {
  return `adapter: ${experimental ? "experimental" : "fallback"}`
}
