import type { AgentContext } from "./session.ts"
import { extractSessionError, withTimeout } from "./session.ts"
import { resolveModel, type SquadConfig } from "./config.ts"
import type { ModelRef, ProviderError } from "./types.ts"

export interface OpenCodeAdapter {
  readonly mode: "experimental" | "fallback"
  resolveModel<T>(role: string, parentModel: T): ModelRef | T
  generateText(prompt: string, model?: unknown, timeoutMs?: number): Promise<string | undefined>
  classifyError(messages: unknown): ProviderError | undefined
  registerRetryHook(): void
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of ["text", "output", "content"]) {
    if (typeof record[key] === "string") return record[key]
  }
  return undefined
}

export function createOpenCodeAdapter(ctx: AgentContext, config: SquadConfig): OpenCodeAdapter {
  const generate = ctx.experimental?.generate?.text
  const retryHook = ctx.session.hook?.retry
  const modelHook = ctx.session.hook?.["experimental.model.resolve"]
  const mode: OpenCodeAdapter["mode"] = generate || retryHook || modelHook ? "experimental" : "fallback"

  return {
    mode,
    resolveModel<T>(role: string, parentModel: T): ModelRef | T {
      return resolveModel(role, config, parentModel)
    },
    async generateText(prompt: string, model?: unknown, timeoutMs = 60_000): Promise<string | undefined> {
      if (!generate) return undefined
      try {
        const result = await withTimeout(
          Promise.resolve(generate({ prompt, model })),
          timeoutMs,
          () => undefined,
        )
        if (result && typeof result === "object" && "timedOut" in result && result.timedOut) return undefined
        return textOf(result)
      } catch {
        return undefined
      }
    },
    classifyError(messages: unknown): ProviderError | undefined {
      return extractSessionError(messages)
    },
    registerRetryHook(): void {
      if (typeof retryHook !== "function") return
      // The retry hook is registered by the OpenCode host when present; the adapter only records capability.
    },
  }
}
