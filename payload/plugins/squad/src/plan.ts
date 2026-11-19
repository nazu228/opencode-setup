import type { PlanTask, RepoRules, SquadOptions, SquadPlan, SquadRole } from "./types.ts"
import { ROLE_ORDER } from "./args.ts"

const ROLE_SET = new Set<SquadRole>(ROLE_ORDER)
const TASK_ID = /^[a-z0-9][a-z0-9._-]{0,48}$/
const CONTRACT_TASK_ID = "contracts"

const SHARED_BASENAMES = new Set([
  "cargo.toml",
  "cargo.lock",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.mod",
  "go.sum",
  "poetry.lock",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "tsconfig.json",
  "jsconfig.json",
  "deno.json",
  "deno.lock",
])

const SHARED_SUFFIXES = [".csproj", ".sln", ".props", ".targets"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} должен быть непустой строкой.`)
  return value.trim()
}

function asStringArray(value: unknown, field: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${field} должен быть массивом строк.`)
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}[${index}] должен быть непустой строкой.`)
    return item.trim()
  })
}

export function extractJson(text: string): unknown {
  const blocks = [...String(text ?? "").matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  const candidates = blocks.map((match) => match[1] ?? "")
  if (!candidates.length) {
    const first = String(text ?? "").indexOf("{")
    const last = String(text ?? "").lastIndexOf("}")
    if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1))
  }
  const errors: string[] = []
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim())
      if (isRecord(parsed) && "tasks" in parsed) return parsed
    } catch (error) {
      errors.push(String((error as Error)?.message ?? error))
    }
  }
  throw new Error(`Lid не вернул валидный JSON-план${errors.length ? `: ${errors.join("; ")}` : "."}`)
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
}

export function normalizeGlob(value: string): string {
  const path = normalizePath(value)
  if (path === "**") return ""
  if (path.endsWith("/**") && !path.slice(0, -3).includes("*")) return path.slice(0, -3)
  return path
}

export function validateFilePattern(value: string): string | undefined {
  const path = normalizePath(value)
  if (!path) return "пустой путь"
  if (path === "**") return undefined
  if (!path.includes("*")) return undefined
  if (path.endsWith("/**") && !path.slice(0, -3).includes("*")) return undefined
  return 'недопустимый glob; используй точный путь, "путь/**" или "**"'
}

export function pathOverlaps(left: string, right: string): boolean {
  const a = normalizePath(left)
  const b = normalizePath(right)
  if (!a || !b) return true
  if (a === "**" || b === "**") return true
  const aDir = a.endsWith("/**") && !a.slice(0, -3).includes("*")
  const bDir = b.endsWith("/**") && !b.slice(0, -3).includes("*")
  const aBase = aDir ? a.slice(0, -3) : a
  const bBase = bDir ? b.slice(0, -3) : b
  if (!aDir && !bDir) return aBase === bBase
  if (aDir && !bDir) return bBase === aBase || bBase.startsWith(`${aBase}/`)
  if (!aDir && bDir) return aBase === bBase || aBase.startsWith(`${bBase}/`)
  return aBase === bBase || aBase.startsWith(`${bBase}/`) || bBase.startsWith(`${aBase}/`)
}

export function isSharedFile(file: string): boolean {
  const value = file.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  const parts = value.toLowerCase().split("/").filter(Boolean)
  const base = parts.at(-1) ?? ""
  if (SHARED_BASENAMES.has(base)) return true
  if (SHARED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true
  if (/^tsconfig.*\.json$/.test(base) || /^(jest|vitest|eslint|prettier|babel)\.config\./.test(base)) return true
  if (parts.some((part) => part === "migrations" || part === "migration" || part === "generated")) return true
  if (/(^|\.)generated\./.test(base)) return true
  if (parts[0] === ".github" && parts[1] === "workflows") return true
  return false
}

function builderRole(role: SquadRole): boolean {
  return role === "executor" || role === "visual-executor"
}

function readOnlyRole(role: SquadRole): boolean {
  return role === "analyst" || role === "critic"
}

function validatePatterns(tasks: PlanTask[], contracts: string[]): void {
  for (const task of tasks) {
    for (const file of task.files) {
      const error = validateFilePattern(file)
      if (error) throw new Error(`Задача "${task.id}", files "${file}": ${error}.`)
    }
  }
  for (const contract of contracts) {
    const error = validateFilePattern(contract)
    if (error) throw new Error(`contracts "${contract}": ${error}.`)
  }
}

function validateOwnership(tasks: PlanTask[], options: SquadOptions): void {
  const builders = tasks.filter((task) => builderRole(task.role) && !task.contract)
  for (let i = 0; i < builders.length; i++) {
    const left = builders[i]!
    if (!left.files.length) throw new Error(`Задача "${left.id}" роли ${left.role} должна указать files.`)
    if (options.batch && left.files.some(isSharedFile)) {
      throw new Error(`Batch-задача "${left.id}" владеет shared-файлом; batch требует полностью независимых файлов.`)
    }
    for (let j = i + 1; j < builders.length; j++) {
      const right = builders[j]!
      for (const leftFile of left.files) {
        for (const rightFile of right.files) {
          if (pathOverlaps(leftFile, rightFile)) {
            throw new Error(
              `Пересекаются владения файлами: "${left.id}" (${leftFile}) и "${right.id}" (${rightFile}). Lid должен развести задачи или сделать зависимость.`,
            )
          }
        }
      }
    }
  }

  const owners = new Map<string, string>()
  for (const task of builders) {
    for (const file of task.files) {
      if (!isSharedFile(file)) continue
      const key = normalizeGlob(file)
      const owner = owners.get(key)
      if (owner && owner !== task.id) {
        throw new Error(
          `Shared-файл "${file}" принадлежит нескольким builders: "${owner}" и "${task.id}". Отдай его contract-фазе или одной задаче-интегратору.`,
        )
      }
      owners.set(key, task.id)
    }
  }
}

function validateDependencies(tasks: PlanTask[]): void {
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size !== tasks.length) throw new Error("ID задач должны быть уникальны.")
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Задача "${task.id}" зависит от неизвестной "${dependency}".`)
      if (dependency === task.id) throw new Error(`Задача "${task.id}" не может зависеть от себя.`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Цикл зависимостей вокруг задачи "${id}".`)
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks) visit(task.id)
}

function applyContracts(tasks: PlanTask[], contracts: string[], options: SquadOptions): PlanTask[] {
  if (options.contracts === false) {
    return tasks.map((task) => (task.contract ? { ...task, contract: false } : task))
  }
  if (options.batch) return tasks
  const existing = tasks.find((task) => task.contract)
  if (!contracts.length && !existing) return tasks
  const contractFiles = contracts.length ? contracts : existing?.files ?? []
  if (!contractFiles.length) return tasks
  const builders = tasks.filter((task) => builderRole(task.role) && !task.contract)
  const enabled = Boolean(existing) || builders.length > 1
  if (!enabled) return tasks

  for (const contract of contractFiles) {
    for (const builder of builders) {
      for (const file of builder.files) {
        if (pathOverlaps(contract, file)) {
          throw new Error(
            `Contract "${contract}" пересекается с files задачи "${builder.id}" (${file}). Builder не должен владеть контрактом.`,
          )
        }
      }
    }
  }

  let contractTask = existing
  if (!contractTask) {
    if (tasks.some((task) => task.id === CONTRACT_TASK_ID)) {
      throw new Error(`ID "${CONTRACT_TASK_ID}" зарезервирован для contract-фазы.`)
    }
    contractTask = {
      id: CONTRACT_TASK_ID,
      title: "Зафиксировать общие контракты",
      role: "executor",
      files: [...contractFiles],
      dependsOn: [],
      instructions: "Создай или зафиксируй общие интерфейсы, типы и схемы. Никакой реализации бизнес-логики.",
      acceptance: ["Контракты зафиксированы в коде", "Builders не меняют контрактные файлы"],
      contract: true,
      checks: [],
    }
    tasks = [contractTask, ...tasks]
  } else {
    contractTask.files = [...new Set([...contractTask.files, ...contractFiles])]
    contractTask.dependsOn = []
  }

  for (const builder of tasks) {
    if (builder.contract || !builderRole(builder.role)) continue
    if (!builder.dependsOn.includes(contractTask.id)) builder.dependsOn.push(contractTask.id)
  }
  return tasks
}

export function validatePlan(value: unknown, options: SquadOptions): SquadPlan {
  if (!isRecord(value)) throw new Error("План должен быть JSON-объектом.")
  const summary = asString(value.summary, "summary")
  const verification = asStringArray(value.verification, "verification")
  const base = value.base == null ? undefined : asString(value.base, "base")
  const ideal = value.ideal === true
  const contracts = asStringArray(value.contracts, "contracts")
  const rawTasks = value.tasks
  if (!Array.isArray(rawTasks) || !rawTasks.length) throw new Error("tasks должен быть непустым массивом.")
  if (rawTasks.length > options.maxTasks) {
    throw new Error(`План содержит ${rawTasks.length} задач, а максимум ${options.maxTasks}. Сожми план.`)
  }
  if (rawTasks.length > 20) throw new Error("Squad разрешает не больше 20 задач.")
  if (options.batch && rawTasks.length > 20) throw new Error("Batch разрешает не больше 20 задач.")
  const allowedRoles = new Set(options.roles.length ? options.roles : ROLE_ORDER)
  let tasks: PlanTask[] = rawTasks.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`tasks[${index}] должен быть объектом.`)
    const id = asString(raw.id, `tasks[${index}].id`).toLowerCase()
    if (!TASK_ID.test(id)) throw new Error(`tasks[${index}].id "${id}" содержит недопустимые символы.`)
    const title = asString(raw.title, `tasks[${index}].title`)
    const role = asString(raw.role, `tasks[${index}].role`) as SquadRole
    if (!ROLE_SET.has(role)) throw new Error(`tasks[${index}].role "${role}" неизвестна.`)
    if (!allowedRoles.has(role)) throw new Error(`Роль "${role}" запрещена флагом --roles.`)
    const files = asStringArray(raw.files, `tasks[${index}].files`)
    if (readOnlyRole(role) && files.length) {
      throw new Error(`Задача "${id}" роли ${role} не может иметь files: аналитик и критик только читают.`)
    }
    const dependsOn = asStringArray(raw.dependsOn, `tasks[${index}].dependsOn`).map((item) => item.toLowerCase())
    const instructions = raw.instructions == null
      ? title
      : asString(raw.instructions, `tasks[${index}].instructions`)
    const acceptance = asStringArray(raw.acceptance, `tasks[${index}].acceptance`)
    const checks = asStringArray(raw.checks, `tasks[${index}].checks`)
    const item: PlanTask = {
      id,
      title,
      role,
      files,
      dependsOn,
      instructions,
      acceptance,
      checks: checks.length ? checks : undefined,
      requiresTests: raw.requiresTests === true,
    }
    if (raw.contract === true) item.contract = true
    return item
  })

  validatePatterns(tasks, contracts)
  if (options.contracts === false && tasks.some((task) => task.contract)) {
    throw new Error("План содержит явную contract-задачу, но включён --no-contracts. Убери задачу или флаг.")
  }
  const builders = tasks.filter((task) => builderRole(task.role) && !task.contract)
  if (!builders.length && !options.analysisOnly) {
    throw new Error(
      "План не содержит builder-задач. Для кодовой задачи нужен executor/visual-executor; для read-only run добавь --analysis-only.",
    )
  }
  if (options.batch) {
    for (const task of tasks) {
      if (!builderRole(task.role)) throw new Error(`Batch допускает только executor/visual-executor, а не ${task.role}.`)
      if (task.dependsOn.length) throw new Error(`Batch-задача "${task.id}" не может иметь dependsOn.`)
      if (!task.checks?.length) throw new Error(`Batch-задача "${task.id}" должна иметь checks.`)
      if (task.files.some(isSharedFile)) throw new Error(`Batch-задача "${task.id}" не может владеть shared-файлом.`)
    }
    if (contracts.length) throw new Error("Batch не поддерживает contracts: задачи должны быть независимы.")
  }

  tasks = applyContracts(tasks, contracts, options)
  if (tasks.length > options.maxTasks) {
    throw new Error(
      `После contract-фазы план содержит ${tasks.length} задач, а максимум ${options.maxTasks}. Увеличь --agents или сократи план.`,
    )
  }
  if (tasks.length > 20) throw new Error("После contract-фазы план превышает лимит 20 задач.")
  validateDependencies(tasks)
  validateOwnership(tasks, options)
  const contractTask = tasks.find((task) => task.contract)
  const normalizedContracts = contractTask ? contractTask.files : []
  return { summary, base, verification, ideal, tasks, contracts: normalizedContracts.length ? normalizedContracts : undefined }
}

export function parsePlan(text: string, options: SquadOptions): SquadPlan {
  return validatePlan(extractJson(text), options)
}

export function defaultPlan(options: SquadOptions): SquadPlan {
  const role: SquadRole = options.analysisOnly
    ? "analyst"
    : options.roles.includes("executor")
      ? "executor"
      : options.roles.includes("visual-executor")
        ? "visual-executor"
        : "executor"
  const builder = role === "executor" || role === "visual-executor"
  return {
    summary: "Lid не вернул валидный план; используется минимальный fallback: одна задача на всю работу.",
    verification: options.verify,
    tasks: [
      {
        id: "main",
        title: options.task.slice(0, 120),
        role,
        files: builder ? ["**"] : [],
        dependsOn: [],
        instructions: options.task,
        acceptance: ["Задача реализована", "Проверки проекта проходят"],
        requiresTests: builder,
      },
    ],
  }
}

export function planToMarkdown(plan: SquadPlan): string {
  const lines = [
    "# Squad plan",
    "",
    plan.summary,
    "",
    `- Base: ${plan.base ?? "auto"}`,
    `- Ideal: ${plan.ideal ? "yes" : "no"}`,
    `- Verification: ${plan.verification.length ? plan.verification.join("; ") : "auto-detect"}`,
  ]
  if (plan.contracts?.length) lines.push(`- Contracts: ${plan.contracts.join(", ")}`)
  lines.push("", "| ID | Role | Title | Files | Depends on | Checks |", "| --- | --- | --- | --- | --- | --- |")
  for (const task of plan.tasks) {
    lines.push(
      `| ${task.id} | ${task.role}${task.contract ? " (contract)" : ""} | ${task.title.replace(/\|/g, "\\|")} | ${task.files.join("<br>") || "-"} | ${task.dependsOn.join(", ") || "-"} | ${task.checks?.join("<br>") || "-"} |`,
    )
  }
  return `${lines.join("\n")}\n`
}

export function planPrompt(input: {
  task: string
  rules: RepoRules
  repoBrief: string
  options: SquadOptions
}): string {
  const batch = input.options.batch === true
  const roles = batch ? ["executor", "visual-executor"] : input.options.roles.length ? input.options.roles : ROLE_ORDER
  const modeText = batch
    ? `- Это batch-режим: только независимые executor/visual-executor задачи, dependsOn: [], непересекающиеся files, без shared-файлов, checks обязательны у каждой задачи.
- files — только точный путь, "путь/**" или "**". Не используй "*.ts", "**/auth.ts", "src/auth*".`
    : `- Один executor владеет кодом и тестами своего модуля. Не разделяй implementation и tests между разными агентами.
- Shared-файлы (package.json, lock-файлы, Cargo.toml, миграции, generated-код, общие конфиги) должен владеть только один builder. Иначе вынеси их в contract-фазу или в задачу-интегратор.
- Для каждой builder-задачи добавь "checks": локальные команды проверки именно её модуля (например, "npm test -- test/auth").
- Если нужны общие интерфейсы/типы для нескольких builders, добавь "contracts": ["пути контрактных файлов"] и не включай эти файлы в files builders.
- files — только точный путь, "путь/**" или "**". Не используй "*.ts", "**/auth.ts", "src/auth*".
- "requiresTests": true для задач, меняющих поведение.`
  const criticLine = batch ? "" : "\n- Для нетривиальной задачи добавь хотя бы одну задачу critic. Critic выполняется после интеграции и не меняет файлы."
  const contractsLine = batch ? "" : `\n  "contracts": ["src/shared/contracts.ts"],`
  return `Ты — Lid, тимлид автономного отряда. Составь план выполнения задачи и верни ТОЛЬКО JSON-объект в одном блоке \`\`\`json.

## Задача
${input.task}

## Ограничения
- Максимум задач: ${input.options.maxTasks}. Максимум агентов: ${batch ? 20 : 12}.
- Разрешённые роли: ${batch ? "executor, visual-executor" : roles.join(", ")}.
- Задачи executor и visual-executor должны иметь непересекающиеся files (glob-паттерны). Пересечение запрещено: сделай зависимость или разведи файлы.
- dependsOn — только существующие id, без циклов.${criticLine}
- Verification — реальные команды проверки проекта. Не выдумывай команды; если не знаешь, верни пустой массив, и плагин попробует определить их сам.
- Если задача требует повышенной надёжности или пользователь просит «идеально», поставь "ideal": true.
- Не добавляй задачи «на будущее», не проси у пользователя подтверждения, не пиши prose вне JSON.
${modeText}

## Формат
\`\`\`json
{
  "summary": "короткое описание плана",
  "base": "origin/dev или null",
  "ideal": false,
  "verification": ["команда 1", "команда 2"],${contractsLine}
  "tasks": [
    {
      "id": "auth-api",
      "title": "Короткое название",
      "role": "executor",
      "files": ["src/auth/**", "test/auth/**"],
      "dependsOn": [],
      "instructions": "Что именно сделать, с учётом контекста проекта",
      "acceptance": ["Что должно быть верно после задачи"],
      "checks": ["npm test -- test/auth"],
      "requiresTests": true
    }
  ]
}
\`\`\`

## Правила проекта (AGENTS.md / DECISIONS.md)
${input.rules.text || "Правила проекта не найдены."}

## Краткий срез репозитория
${input.repoBrief}
`
}

export function planRetryPrompt(error: string): string {
  return `План не прошёл валидацию: ${error}

Верни исправленный план. Только JSON в одном блоке \`\`\`json, без пояснений.`
}

export function planDigest(plan: SquadPlan, max = 6000): string {
  return planToMarkdown(plan).slice(0, max)
}
