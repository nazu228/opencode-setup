import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ModelRef } from "./types.ts"

export interface SquadConfig {
  models?: Record<string, ModelRef>
  buildConcurrency?: number
  maxCostUsd?: number
  maxTotalTokens?: number
  maxRunMinutes?: number
  sccache?: boolean
}

export interface LoadedConfig {
  config: SquadConfig
  sources: string[]
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown, field: string): number | undefined {
  if (value == null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} должен быть положительным числом.`)
  }
  return value
}

export function normalizeModel(value: unknown, field = "models"): ModelRef {
  if (typeof value === "string") {
    const trimmed = value.trim()
    const slash = trimmed.indexOf("/")
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new Error(`${field}: ожидается "provider/model".`)
    }
    return {
      providerID: trimmed.slice(0, slash),
      id: trimmed.slice(slash + 1),
    }
  }
  if (isRecord(value)) {
    const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
    const id = typeof value.modelID === "string"
      ? value.modelID.trim()
      : typeof value.id === "string"
        ? value.id.trim()
        : ""
    if (!providerID || !id) throw new Error(`${field}: нужны providerID и modelID/id.`)
    const variant = typeof value.variant === "string" && value.variant.trim() ? value.variant.trim() : undefined
    return { providerID, id, variant }
  }
  throw new Error(`${field}: модель должна быть строкой "provider/model" или объектом.`)
}

export function parseSquadConfig(value: unknown): SquadConfig {
  if (!isRecord(value)) throw new Error("squad.json должен быть JSON-объектом.")
  const config: SquadConfig = {}
  if (value.models != null) {
    if (!isRecord(value.models)) throw new Error("models должен быть объектом.")
    const models: Record<string, ModelRef> = {}
    for (const [role, setting] of Object.entries(value.models)) {
      if (setting == null) continue
      models[role] = normalizeModel(setting, `models.${role}`)
    }
    config.models = models
  }
  const buildConcurrency = positiveNumber(value.buildConcurrency, "buildConcurrency")
  if (buildConcurrency != null) {
    if (!Number.isInteger(buildConcurrency) || buildConcurrency > 12) {
      throw new Error("buildConcurrency должен быть целым числом от 1 до 12.")
    }
    config.buildConcurrency = buildConcurrency
  }
  const maxCostUsd = positiveNumber(value.maxCostUsd, "maxCostUsd")
  if (maxCostUsd != null) config.maxCostUsd = maxCostUsd
  const maxTotalTokens = positiveNumber(value.maxTotalTokens, "maxTotalTokens")
  if (maxTotalTokens != null) config.maxTotalTokens = maxTotalTokens
  const maxRunMinutes = positiveNumber(value.maxRunMinutes, "maxRunMinutes")
  if (maxRunMinutes != null) config.maxRunMinutes = maxRunMinutes
  if (value.sccache != null) {
    if (typeof value.sccache !== "boolean") throw new Error("sccache должен быть boolean.")
    config.sccache = value.sccache
  }
  return config
}

export function mergeConfigs(base: SquadConfig, override: SquadConfig): SquadConfig {
  return {
    models: base.models || override.models
      ? { ...(base.models ?? {}), ...(override.models ?? {}) }
      : undefined,
    buildConcurrency: override.buildConcurrency ?? base.buildConcurrency,
    maxCostUsd: override.maxCostUsd ?? base.maxCostUsd,
    maxTotalTokens: override.maxTotalTokens ?? base.maxTotalTokens,
    maxRunMinutes: override.maxRunMinutes ?? base.maxRunMinutes,
    sccache: override.sccache ?? base.sccache,
  }
}

function globalConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "squad.json")
}

function projectConfigPath(project: string): string {
  return path.join(project, ".opencode", "squad.json")
}

async function readConfigFile(file: string): Promise<unknown | undefined> {
  if (!existsSync(file)) return undefined
  return JSON.parse(await readFile(file, "utf8")) as unknown
}

export async function loadSquadConfig(project: string): Promise<LoadedConfig> {
  const sources: string[] = []
  const warnings: string[] = []
  let config: SquadConfig = {}
  for (const [label, file] of [
    ["global", globalConfigPath()],
    ["project", projectConfigPath(project)],
  ] as const) {
    try {
      const raw = await readConfigFile(file)
      if (raw === undefined) continue
      config = mergeConfigs(config, parseSquadConfig(raw))
      sources.push(`${label}: ${file}`)
    } catch (error) {
      warnings.push(`squad.json ${label}: ${String((error as Error)?.message ?? error)}`)
    }
  }
  return { config, sources, warnings }
}

export function resolveModel<T>(
  role: string,
  config: SquadConfig,
  parentModel: T,
): ModelRef | T {
  return config.models?.[role] ?? parentModel
}

export function resolveFallbackModel(config: SquadConfig): ModelRef | undefined {
  return config.models?.fallback
}
