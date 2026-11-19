import path from "node:path"
import type { AgentRunResult, RunMetrics, RunState, TaskState } from "./types.ts"

function escapeCell(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 220)
}

export function formatCost(cost: unknown): string {
  if (typeof cost === "number") return cost.toFixed(6)
  if (cost == null) return "-"
  if (typeof cost === "object") {
    const value = cost as Record<string, unknown>
    if (typeof value.total === "number") return value.total.toFixed(6)
    if (typeof value.input === "number" && typeof value.output === "number") {
      return (value.input + value.output).toFixed(6)
    }
  }
  return String(cost)
}

export function formatTokens(tokens: unknown): string {
  if (typeof tokens === "number") return String(tokens)
  if (!tokens || typeof tokens !== "object") return "-"
  const value = tokens as Record<string, unknown>
  const parts: string[] = []
  if (typeof value.input === "number") parts.push(`in ${value.input}`)
  if (typeof value.output === "number") parts.push(`out ${value.output}`)
  if (typeof value.reasoning === "number" && value.reasoning > 0) parts.push(`reason ${value.reasoning}`)
  const cache = value.cache as { read?: number; write?: number } | undefined
  if (cache && (typeof cache.read === "number" || typeof cache.write === "number")) {
    parts.push(`cache ${cache.read ?? 0}/${cache.write ?? 0}`)
  }
  return parts.length ? parts.join(", ") : "-"
}

function duration(state: RunState): string {
  const start = Date.parse(state.createdAt)
  const end = state.finishedAt ? Date.parse(state.finishedAt) : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "-"
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function durationMs(value: number | undefined): string {
  if (!value) return "-"
  const seconds = Math.round(value / 1000)
  return seconds ? `${seconds}s` : `${value}ms`
}

function taskRows(tasks: TaskState[]): string {
  return tasks.map((task) =>
    `| ${escapeCell(task.id)} | ${escapeCell(task.role)}${task.requiresTests ? " (tests)" : ""} | ${escapeCell(task.status)} | ${escapeCell(task.commit?.slice(0, 8) ?? "-")} | ${escapeCell(durationMs(task.durationMs))} | ${escapeCell(formatCost(task.cost))} | ${escapeCell(task.tokens ?? "-")} | ${escapeCell(task.worktree ?? "-")} | ${escapeCell(task.patch ?? "-")} | ${escapeCell(task.error ?? "-")} |`,
  ).join("\n")
}

function commitRows(state: RunState): string {
  if (!state.commits.length) return "_Коммитов нет._"
  return state.commits.map((commit) => `- \`${commit.commit.slice(0, 8)}\` ${commit.title} (${commit.taskId})`).join("\n")
}

function questionRows(state: RunState): string {
  if (!state.questions.length) return "_Вопросов не было._"
  return state.questions.map((question) => {
    const answer = question.answer ? ` → ${question.answer}` : ""
    return `- **${question.status}** ${question.id} (${question.from}): ${question.text}${answer}`
  }).join("\n")
}

function warningRows(state: RunState): string {
  if (!state.warnings.length) return "_Предупреждений нет._"
  return state.warnings.map((warning) => `- ${warning}`).join("\n")
}

function budgetText(state: RunState): string {
  const budget = state.budget
  if (!budget) return "не задан"
  const parts: string[] = []
  if (budget.maxCostUsd != null) parts.push(`$${budget.maxCostUsd}`)
  if (budget.maxTotalTokens != null) parts.push(`${budget.maxTotalTokens} tokens`)
  if (budget.maxRunMinutes != null) parts.push(`${budget.maxRunMinutes}m`)
  return parts.length ? parts.join(", ") : "не задан"
}

function metricsText(metrics: RunMetrics | undefined): string {
  if (!metrics) return "_Метрик нет._"
  const phases = Object.entries(metrics.phaseMs)
    .map(([phase, ms]) => `${phase} ${Math.round(ms / 1000)}s`)
    .join(", ")
  return [
    `- Cost: ${formatCost(metrics.totalCost)}`,
    `- Tokens: ${metrics.totalTokens}`,
    `- Gate runs: ${metrics.gateRuns}`,
    `- Fix rounds: ${metrics.fixRounds}`,
    `- Provider errors: ${metrics.providerErrors}`,
    `- Phases: ${phases}`,
  ].join("\n")
}

function triageText(state: RunState): string {
  if (!state.triage) return "_Triage не запускался._"
  return `- Task: ${state.triage.taskId}
- Confidence: ${state.triage.confidence.toFixed(2)}
- Source: ${state.triage.source}
- Attempts: ${state.triage.attempts}
- Files: ${state.triage.files.join(", ") || "-"}
${state.triage.reason ? `- Reason: ${state.triage.reason}` : ""}`
}

export function renderSummary(state: RunState): string {
  const tasks = Object.values(state.tasks)
  return `# Squad run ${state.runId}

- **Задача:** ${state.task}
- **Статус:** ${state.status}
- **Ошибка:** ${state.error ?? "-"}
- **Проект:** ${state.project}
- **База:** ${state.base}${state.baseSource ? ` (${state.baseSource})` : ""}
- **Ветка:** ${state.branch}
- **Длительность:** ${duration(state)}
- **Spend:** ${formatCost(state.metrics?.totalCost ?? 0)} / budget ${budgetText(state)}
- **Tokens:** ${state.metrics?.totalTokens ?? 0}
- **Integration worktree:** ${state.integrationWorktree ?? "-"}
- **Артефакты:** ${state.artifacts.runDir}
- **Отчёт:** ${state.artifacts.report}

## План

${state.plan?.summary ?? "План не создан."}

| ID | Роль | Статус | Коммит | Время | Cost | Tokens | Worktree | Patch | Ошибка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${taskRows(tasks) || "| - | - | - | - | - | - | - | - | - | - |"}

## Коммиты

${commitRows(state)}

## Verification

${state.gate ? `${state.gate.ok ? "OK" : "FAIL"}: ${state.gate.commands.join("; ") || "нет команд"}` : "не запускалась"}

## Метрики

${metricsText(state.metrics)}

## Triage

${triageText(state)}

## Вопросы

${questionRows(state)}

## Предупреждения

${warningRows(state)}
`
}

export function renderReport(state: RunState, extras: { analystDigest?: string; criticDigest?: string } = {}): string {
  const tasks = Object.values(state.tasks)
  const changed = state.changedFiles?.length
    ? state.changedFiles.map((file) => `- ${file}`).join("\n")
    : "_Изменённых файлов нет._"
  return `# SQUAD_REPORT

## Задача

${state.task}

## Итог

- **Статус:** ${state.status}
- **Ошибка:** ${state.error ?? "-"}
- **Run:** ${state.runId}
- **База:** ${state.base}${state.baseSource ? ` (${state.baseSource})` : ""}
- **Ветка:** ${state.branch}
- **Время:** ${duration(state)}
- **Spend:** ${formatCost(state.metrics?.totalCost ?? 0)} / budget ${budgetText(state)}
- **Tokens:** ${state.metrics?.totalTokens ?? 0}
- **Revision:** ${state.revision ?? 0}
- **Отчёт:** ${state.artifacts.report}
- **Артефакты:** ${state.artifacts.runDir}

## План

${state.plan?.summary ?? "План не создан."}
${state.plan?.contracts?.length ? `\nКонтракты: ${state.plan.contracts.join(", ")}` : ""}

| ID | Роль | Статус | Коммит | Время | Cost | Tokens | Worktree | Patch | Ошибка |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${taskRows(tasks) || "| - | - | - | - | - | - | - | - | - | - |"}

## Что сделано

${commitRows(state)}

## Изменённые файлы

${changed}

## Diff stat

\`\`\`
${state.diffStat || "нет diff"}
\`\`\`

## Verification

${state.gate ? `Команды: \`${state.gate.commands.join("; ")}\`\n\n\`\`\`\n${state.gate.output}\n\`\`\`` : "_Verification не запускалась._"}

## Метрики

${metricsText(state.metrics)}

## Triage

${triageText(state)}

## Аналитика

${extras.analystDigest || "_Аналитики не запускались._"}

## Критика

${extras.criticDigest || "_Критики не запускались._"}

## Вопросы и решения

${questionRows(state)}

## Риски и предупреждения

${warningRows(state)}

## Как проверить

\`\`\`bash
git switch ${state.branch}
git log --oneline ${state.base}..${state.branch}
git diff ${state.base}..${state.branch}
\`\`\`

## Следующие шаги

- Проверить diff и коммиты по агентам.
- Разобрать замечания критиков и предупреждения.
- Если всё принято — смержить ветку вручную.
`
}

export function renderStatus(state: RunState): string {
  const tasks = Object.values(state.tasks)
  const done = tasks.filter((task) => task.status === "done").length
  const failed = tasks.filter((task) => task.status === "failed").length
  const running = tasks.filter((task) => task.status === "running").length
  const lines = [
    `Squad ${state.runId} (revision ${state.revision ?? 0})`,
    `status: ${state.status} | branch: ${state.branch} | base: ${state.base}`,
    `tasks: ${done} done, ${running} running, ${failed} failed, ${tasks.length} total`,
    state.gate ? `gate: ${state.gate.ok ? "OK" : "FAIL"}` : "gate: pending",
    `spend: ${formatCost(state.metrics?.totalCost ?? 0)} | tokens: ${state.metrics?.totalTokens ?? 0} | budget: ${budgetText(state)}`,
  ]
  if (state.error) lines.push(`error: ${state.error}`)
  if (state.triage) {
    lines.push(`triage: ${state.triage.taskId} (${state.triage.confidence.toFixed(2)}, ${state.triage.source})`)
  }
  if (tasks.length) {
    lines.push("")
    lines.push("ID                 ROLE              STATUS     COMMIT")
    for (const task of tasks) {
      lines.push(
        `${task.id.padEnd(18).slice(0, 18)} ${task.role.padEnd(17).slice(0, 17)} ${task.status.padEnd(10).slice(0, 10)} ${task.commit?.slice(0, 8) ?? "-"}`,
      )
    }
  }
  const pending = state.questions.filter((question) => question.status === "pending" || question.status === "needs_attention")
  if (pending.length) {
    lines.push("")
    lines.push(`pending questions: ${pending.map((question) => question.id).join(", ")}`)
  }
  return lines.join("\n")
}

export function agentResultMarkdown(result: AgentRunResult, task: TaskState): string {
  return `# ${task.id} — ${task.title}

- Role: ${task.role}
- Status: ${result.status}${result.error ? ` (${result.error})` : ""}${result.errorKind ? ` [${result.errorKind}]` : ""}
- Session: ${result.sessionID || "-"}
- Duration: ${Math.round((result.durationMs || 0) / 1000)}s
- Cost: ${formatCost(result.cost)}
- Tokens: ${formatTokens(result.tokens)}

## Result

${result.text || "_Нет текста_"}
`
}

export function resultPath(state: RunState, taskId: string): string {
  return path.join(state.artifacts.runDir, "results", `${taskId}.md`)
}
