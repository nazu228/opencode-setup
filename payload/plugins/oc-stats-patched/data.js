/**
 * Data for the oc-stats TUI: native OpenCode API reads plus the aggregation the
 * Overview, Projects and Performance tabs draw. Nothing here writes to the
 * database or depends on its schema.
 */

const DAY_MS = 86_400_000;
export function rangeWindow(range, now = Date.now()) {
  if (range === "all") {
    return {
      from: 0,
      to: now,
      prevFrom: undefined,
      prevTo: undefined,
      label: "всё время",
      days: 0
    };
  }
  const days = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const to = now;
  const from = now - days * DAY_MS;
  return {
    from,
    to,
    prevFrom: from - days * DAY_MS,
    prevTo: from,
    label: range === "24h" ? "последние 24 часа" : `последние ${days} дней`,
    days
  };
}
export function emptyTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0
    }
  };
}
export function totalTokens(tokens) {
  if (!tokens) return 0;
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}
function addTokens(target, source) {
  if (!source) return;
  target.input += Number(source.input ?? 0) || 0;
  target.output += Number(source.output ?? 0) || 0;
  target.reasoning += Number(source.reasoning ?? 0) || 0;
  target.cache.read += Number(source.cache?.read ?? 0) || 0;
  target.cache.write += Number(source.cache?.write ?? 0) || 0;
}
function addTokensFrom(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cache.read += source.cache.read;
  target.cache.write += source.cache.write;
}
export function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function dayLabel(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}
function emptyDaily(date) {
  return {
    date,
    cost: 0,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    steps: 0,
    tools: 0,
    prompts: 0,
    cacheSavings: 0
  };
}
function quantile(values, q) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
export function summary(values) {
  const clean = values.filter(value => Number.isFinite(value) && value >= 0);
  if (clean.length === 0) return {
    count: 0
  };
  const sum = clean.reduce((total, value) => total + value, 0);
  return {
    count: clean.length,
    p50: quantile(clean, 0.5),
    p95: quantile(clean, 0.95),
    p99: quantile(clean, 0.99),
    mean: sum / clean.length
  };
}
export function percentile(values, q) {
  return quantile(values, q);
}
function mergeIntervals(intervals) {
  const sorted = intervals.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);else merged.push([start, end]);
  }
  return merged;
}
function unionLength(intervals) {
  return mergeIntervals(intervals).reduce((total, [start, end]) => total + (end - start), 0);
}
function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
async function mapLimit(items, limit, run) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({
    length: Math.min(Math.max(1, limit), Math.max(1, items.length))
  }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await run(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}
async function listMessages(client, sessionID) {
  const messages = [];
  const seen = new Set();
  let cursor;
  for (let page = 0; page < 300; page += 1) {
    const input = cursor ? {
      sessionID,
      limit: 20,
      cursor
    } : {
      sessionID,
      limit: 20,
      order: "asc"
    };
    let response;
    try {
      response = await client.message.list(input);
    } catch {
      break;
    }
    const data = Array.isArray(response) ? response : response?.data ?? [];
    messages.push(...data);
    const next = response?.cursor?.next ?? undefined;
    if (!next || next === cursor || seen.has(next) || data.length === 0) break;
    seen.add(next);
    cursor = next;
  }
  return messages;
}
export function projectLabel(project) {
  if (!project) return "общий";
  if (typeof project.name === "string" && project.name.trim()) return project.name.trim();
  const path = String(project.canonical ?? project.worktree ?? "").replace(/\/+$/, "");
  if (!path || path === "/") return project.id === "global" ? "общий" : String(project.id ?? "общий");
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function projectPath(project) {
  return String(project?.canonical ?? project?.worktree ?? project?.name ?? "");
}
function priceMapFrom(modelsResponse) {
  const byKey = new Map();
  const models = Array.isArray(modelsResponse) ? modelsResponse : modelsResponse?.data ?? [];
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const cost = Array.isArray(model.cost) ? model.cost[0] : model.cost;
    if (!cost) continue;
    const providerID = model.providerID ?? "";
    const modelID = model.modelID ?? model.id ?? "";
    if (modelID) byKey.set(`${providerID}/${modelID}`, cost);
    if (model.id) byKey.set(String(model.id), cost);
  }
  return byKey;
}
function cacheSavingsFor(model, tokens, prices) {
  const modelID = model?.modelID ?? model?.id;
  if (!modelID) return 0;
  const cost = prices.get(`${model?.providerID ?? ""}/${modelID}`) ?? prices.get(modelID);
  if (!cost) return 0;
  const input = safeNumber(cost.input);
  const cacheRead = safeNumber(cost.cache?.read ?? input);
  const readTokens = tokens.cache.read;
  if (readTokens <= 0 || input <= cacheRead) return 0;
  return readTokens * (input - cacheRead) / 1_000_000;
}
function inWindow(ms, from, to) {
  return Number.isFinite(ms) && ms >= from && ms <= to;
}
function buildSession(raw, messages, win, projectName, prices) {
  const tokens = emptyTokens();
  const calls = [];
  const tools = [];
  const intervals = [];
  const promptsByDay = {};
  let prompts = 0;
  let cost = 0;
  let cacheSavings = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const model = raw.model;
  const projectID = raw.projectID ?? "global";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const time = message.time ?? {};
    if (message.type === "user") {
      const at = safeNumber(time.created);
      if (inWindow(at, win.from, win.to)) {
        prompts += 1;
        const key = dayKey(at);
        promptsByDay[key] = (promptsByDay[key] ?? 0) + 1;
      }
      continue;
    }
    if (message.type !== "assistant") continue;
    const end = safeNumber(time.completed);
    if (!end || !inWindow(end, win.from, win.to)) continue;
    const start = safeNumber(time.created) || end;
    const streamed = Number.isFinite(time.streamed) && time.streamed > 0 ? time.streamed : undefined;
    const messageTokens = emptyTokens();
    addTokens(messageTokens, message.tokens);
    addTokens(tokens, message.tokens);
    const messageCost = safeNumber(message.cost);
    const savings = cacheSavingsFor(message.model ?? model, messageTokens, prices);
    cost += messageCost;
    cacheSavings += savings;
    const messageTools = [];
    for (const part of message.content ?? []) {
      if (!part || part.type !== "tool") continue;
      const partTime = part.time ?? {};
      const toolStart = safeNumber(partTime.created) || safeNumber(partTime.ran);
      const toolEnd = safeNumber(partTime.completed);
      if (!toolStart || !toolEnd || toolEnd < toolStart) continue;
      const ran = safeNumber(partTime.ran) || toolStart;
      messageTools.push({
        name: String(part.name ?? part.tool ?? "инструмент"),
        sessionID: String(raw.id ?? ""),
        projectID: String(projectID),
        projectName,
        start: toolStart,
        ran,
        end: toolEnd,
        status: String(part.state?.status ?? "completed"),
        duration: Math.max(0, toolEnd - toolStart),
        wait: Math.max(0, ran - toolStart),
        execution: Math.max(0, toolEnd - ran)
      });
    }
    const toolTime = unionLength(messageTools.map(tool => [tool.start, tool.end]));
    const firstToolStart = messageTools.length > 0 ? Math.min(...messageTools.map(tool => tool.start)) : end;
    const modelEnd = Math.max(start, Math.min(end, firstToolStart));
    const stepDuration = Math.max(0, end - start);
    const callDuration = Math.max(0, modelEnd - start);
    const output = messageTokens.output;
    const call = {
      id: String(message.id ?? ""),
      sessionID: String(raw.id ?? ""),
      projectID: String(projectID),
      projectName,
      model: message.model ?? model,
      start,
      streamed,
      end,
      cost: messageCost,
      tokens: messageTokens,
      ttft: streamed !== undefined ? Math.max(0, streamed - start) : undefined,
      duration: callDuration,
      stepDuration,
      toolTime,
      outputSpeed: output > 0 && callDuration > 0 ? output / (callDuration / 1000) : undefined,
      cacheSavings: savings
    };
    calls.push(call);
    tools.push(...messageTools);
    intervals.push([start, end]);
    first = Math.min(first, start);
    last = Math.max(last, end);
  }
  const created = safeNumber(raw.time?.created);
  const updated = safeNumber(raw.time?.updated) || created;
  const callStart = Number.isFinite(first) ? first : created;
  const callEnd = Number.isFinite(last) ? last : updated;
  const wall = Math.max(0, callEnd - callStart) || Math.max(0, updated - created);
  const busy = unionLength(intervals);
  const idle = Math.max(0, wall - busy);
  return {
    session: {
      id: String(raw.id ?? ""),
      title: String(raw.title ?? "Без названия"),
      projectID: String(projectID),
      projectName,
      parentID: raw.parentID ? String(raw.parentID) : undefined,
      model,
      created,
      updated,
      cost,
      tokens,
      prompts,
      steps: calls.length,
      tools,
      calls,
      wall,
      busy,
      idle,
      first: Number.isFinite(first) ? first : undefined,
      last: Number.isFinite(last) ? last : undefined,
      cacheSavings,
      totalCost: safeNumber(raw.cost),
      totalTokens: totalTokens(raw.tokens)
    },
    promptsByDay
  };
}
function projectAggregate(project, sessions) {
  const roots = sessions.filter(session => !session.parentID);
  const children = sessions.filter(session => session.parentID);
  const calls = sessions.flatMap(session => session.calls);
  const tools = sessions.flatMap(session => session.tools);
  const tokens = emptyTokens();
  let cost = 0;
  let prompts = 0;
  let cacheSavings = 0;
  let lastActive = 0;
  for (const session of sessions) {
    cost += session.cost;
    prompts += session.prompts;
    cacheSavings += session.cacheSavings;
    addTokensFrom(tokens, session.tokens);
    lastActive = Math.max(lastActive, session.updated);
  }
  const busy = unionLength(calls.map(call => [call.start, call.end]));
  const starts = calls.map(call => call.start);
  const ends = calls.map(call => call.end);
  const wall = calls.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
  const idle = Math.max(0, wall - busy);
  return {
    id: String(project?.id ?? "global"),
    name: projectLabel(project),
    path: projectPath(project),
    sessions,
    roots,
    children,
    cost,
    tokens,
    prompts,
    steps: calls.length,
    tools,
    calls,
    wall,
    busy,
    idle,
    lastActive,
    cacheSavings
  };
}
export async function loadDashboard(client, range, options = {}) {
  const win = rangeWindow(range);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const onProgress = options.onProgress ?? (() => {});
  const onPhase = options.onPhase ?? (() => {});
  onPhase("Загрузка итогов");
  const statsInput = {
    to: win.to,
    timezone,
    tools: "summary"
  };
  if (win.from > 0) statsInput.from = win.from;
  const stats = await client.experimental.session.stats(statsInput).catch(() => undefined);
  let previous;
  if (win.prevFrom !== undefined && win.prevTo !== undefined) {
    const previousStats = await client.experimental.session.stats({
      from: win.prevFrom,
      to: win.prevTo,
      timezone,
      tools: "none"
    }).catch(() => undefined);
    if (previousStats) {
      previous = {
        cost: safeNumber(previousStats.cost),
        tokens: totalTokens(previousStats.tokens),
        prompts: safeNumber(previousStats.prompts),
        steps: safeNumber(previousStats.steps)
      };
    }
  }
  onPhase("Загрузка проектов");
  let rawProjects = [];
  try {
    const response = await client.project.list();
    rawProjects = Array.isArray(response) ? response : response?.data ?? [];
  } catch {
    rawProjects = [];
  }
  if (!rawProjects.length) rawProjects = [{
    id: "global",
    canonical: "/"
  }];
  const projectByID = new Map();
  for (const project of rawProjects) projectByID.set(String(project.id), project);
  onPhase("Загрузка сессий");
  const rawSessions = [];
  const seenSessions = new Set();
  for (const project of rawProjects) {
    try {
      const response = await client.session.list({
        project: project.id,
        limit: 1000,
        order: "desc"
      });
      const list = Array.isArray(response) ? response : response?.data ?? [];
      for (const session of list) {
        const id = String(session?.id ?? "");
        if (!id || seenSessions.has(id)) continue;
        seenSessions.add(id);
        rawSessions.push({
          ...session,
          projectID: session.projectID ?? project.id
        });
      }
    } catch {
      // A project that cannot be read still shows its (empty) row.
    }
  }
  const candidates = rawSessions.filter(session => {
    if (range === "all") return true;
    const updated = safeNumber(session.time?.updated);
    const created = safeNumber(session.time?.created);
    return updated >= win.from || created >= win.from;
  });
  onPhase("Загрузка сообщений");
  let done = 0;
  onProgress(0, candidates.length);
  const messageResults = await mapLimit(candidates, 4, async session => {
    let messages = [];
    try {
      messages = await listMessages(client, String(session.id));
    } catch {
      messages = [];
    }
    done += 1;
    onProgress(done, candidates.length);
    return messages;
  });
  onPhase("Загрузка цен моделей");
  let prices = new Map();
  try {
    prices = priceMapFrom(await client.model.list());
  } catch {
    prices = new Map();
  }
  const built = [];
  const promptsByDay = {};
  for (let index = 0; index < candidates.length; index += 1) {
    const raw = candidates[index];
    const projectID = String(raw.projectID ?? "global");
    const project = projectByID.get(projectID);
    const name = projectLabel(project ?? {
      id: projectID
    });
    const result = buildSession(raw, messageResults[index] ?? [], win, name, prices);
    built.push(result.session);
    for (const [key, count] of Object.entries(result.promptsByDay)) {
      promptsByDay[key] = (promptsByDay[key] ?? 0) + count;
    }
  }
  const sessionsByProject = new Map();
  for (const session of built) {
    const list = sessionsByProject.get(session.projectID) ?? [];
    list.push(session);
    sessionsByProject.set(session.projectID, list);
  }
  const projects = rawProjects.map(project => projectAggregate(project, sessionsByProject.get(String(project.id)) ?? []));
  // Sessions whose project was not in project.list still get a row.
  for (const [projectID, sessions] of sessionsByProject) {
    if (rawProjects.some(project => String(project.id) === projectID)) continue;
    projects.push(projectAggregate({
      id: projectID
    }, sessions));
  }
  const calls = built.flatMap(session => session.calls);
  const tools = built.flatMap(session => session.tools);
  const daily = {};
  const dailyFor = key => daily[key] ??= emptyDaily(key);
  for (const call of calls) {
    const bucket = dailyFor(dayKey(call.end));
    bucket.cost += call.cost;
    bucket.input += call.tokens.input;
    bucket.output += call.tokens.output;
    bucket.reasoning += call.tokens.reasoning;
    bucket.cacheRead += call.tokens.cache.read;
    bucket.cacheWrite += call.tokens.cache.write;
    bucket.tokens += totalTokens(call.tokens);
    bucket.steps += 1;
    bucket.cacheSavings += call.cacheSavings;
  }
  for (const tool of tools) {
    dailyFor(dayKey(tool.end)).tools += 1;
  }
  for (const [key, count] of Object.entries(promptsByDay)) {
    dailyFor(key).prompts += count;
  }
  const totals = {
    cost: 0,
    tokens: emptyTokens(),
    prompts: 0,
    steps: calls.length,
    sessions: built.filter(session => !session.parentID).length,
    subagents: built.filter(session => session.parentID).length,
    activeDays: 0,
    streak: 0,
    cacheSavings: 0,
    cacheHit: 0,
    wall: 0,
    busy: 0,
    idle: 0,
    tools: tools.length,
    toolErrors: tools.filter(tool => tool.status === "error").length
  };
  for (const session of built) {
    totals.cost += session.cost;
    totals.prompts += session.prompts;
    totals.cacheSavings += session.cacheSavings;
    addTokensFrom(totals.tokens, session.tokens);
  }
  totals.activeDays = Object.values(daily).filter(bucket => bucket.steps > 0 || bucket.prompts > 0).length;
  totals.cacheHit = totals.tokens.cache.read + totals.tokens.input > 0 ? totals.tokens.cache.read / (totals.tokens.cache.read + totals.tokens.input + totals.tokens.cache.write) : 0;
  const busyIntervals = calls.map(call => [call.start, call.end]);
  totals.busy = unionLength(busyIntervals);
  if (calls.length > 0) {
    const start = Math.min(...calls.map(call => call.start));
    const end = Math.max(...calls.map(call => call.end));
    totals.wall = Math.max(0, end - start);
    totals.idle = Math.max(0, totals.wall - totals.busy);
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (!daily[dayKey(today.getTime())]?.steps) today.setDate(today.getDate() - 1);
  while (daily[dayKey(today.getTime())]?.steps) {
    totals.streak += 1;
    today.setDate(today.getDate() - 1);
  }
  const modelsByKey = new Map();
  for (const call of calls) {
    const model = call.model;
    const modelID = model?.modelID ?? model?.id ?? "";
    const key = model ? `${model.providerID ?? ""}/${modelID}` : "неизвестно";
    const existing = modelsByKey.get(key) ?? {
      model,
      label: modelID ? `${model?.providerID ?? ""}/${modelID}` : "неизвестно",
      steps: 0,
      tokens: emptyTokens(),
      cost: 0,
      cacheSavings: 0
    };
    existing.steps += 1;
    existing.cost += call.cost;
    existing.cacheSavings += call.cacheSavings;
    addTokensFrom(existing.tokens, call.tokens);
    modelsByKey.set(key, existing);
  }
  const latencyCalls = calls.filter(call => call.duration <= 10 * 60 * 1000);
  const latency = {
    ttft: summary(calls.map(call => call.ttft).filter(value => value !== undefined)),
    duration: summary(latencyCalls.map(call => call.duration)),
    step: summary(latencyCalls.map(call => call.stepDuration)),
    outputSpeed: summary(latencyCalls.map(call => call.outputSpeed).filter(value => value !== undefined)),
    toolDuration: summary(tools.filter(tool => tool.duration <= 10 * 60 * 1000).map(tool => tool.duration))
  };
  return {
    window: win,
    stats,
    previous,
    projects: projects.filter(project => project.sessions.length > 0 || project.roots.length > 0 || project.cost > 0 || project.id === "global").sort((a, b) => b.cost - a.cost),
    sessions: built,
    calls,
    tools,
    daily,
    models: [...modelsByKey.values()].sort((a, b) => b.cost - a.cost),
    totals,
    latency,
    slowestCalls: [...calls].sort((a, b) => b.duration - a.duration).slice(0, 20),
    slowestTools: [...tools].sort((a, b) => b.duration - a.duration).slice(0, 20)
  };
}

/** A cheap range summary for the sidebar: one stats request, no message fetches. */

export async function loadSidebarSummary(client, range, options = {}, now = Date.now()) {
  const win = rangeWindow(range, now);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = {
    to: win.to,
    timezone,
    tools: options.tools ?? (options.previous === false ? "none" : "summary")
  };
  if (win.from > 0) query.from = win.from;
  if (options.project) query.project = options.project;
  const response = await client.experimental.session.stats(query);
  const stats = response?.data ?? response ?? {};
  let previous;
  if (options.previous !== false && win.prevFrom !== undefined && win.prevTo !== undefined) {
    const priorResponse = await client.experimental.session.stats({
      from: win.prevFrom,
      to: win.prevTo,
      timezone,
      tools: "none"
    }).catch(() => undefined);
    const prior = priorResponse?.data ?? priorResponse;
    if (prior) previous = {
      cost: safeNumber(prior.cost),
      steps: safeNumber(prior.steps)
    };
  }
  const tokens = {
    input: safeNumber(stats.tokens?.input),
    output: safeNumber(stats.tokens?.output),
    reasoning: safeNumber(stats.tokens?.reasoning),
    cache: {
      read: safeNumber(stats.tokens?.cache?.read),
      write: safeNumber(stats.tokens?.cache?.write)
    }
  };
  const totals = stats.tools?.totals ?? stats.tools ?? {};
  const activity = Array.isArray(stats.activity) ? stats.activity.map(item => ({
    date: String(item?.date ?? ""),
    steps: safeNumber(item?.steps)
  })).filter(item => item.date !== "") : [];
  return {
    range,
    window: win,
    cost: safeNumber(stats.cost),
    tokens,
    prompts: safeNumber(stats.prompts),
    steps: safeNumber(stats.steps),
    sessions: safeNumber(stats.sessions),
    subagents: safeNumber(stats.subagents),
    activeDays: safeNumber(stats.activeDays),
    streak: safeNumber(stats.streak),
    cacheHit: tokens.cache.read + tokens.input + tokens.cache.write > 0 ? tokens.cache.read / (tokens.cache.read + tokens.input + tokens.cache.write) : 0,
    tools: {
      calls: safeNumber(totals.calls),
      succeeded: safeNumber(totals.succeeded),
      failed: safeNumber(totals.failed),
      unfinished: safeNumber(totals.unfinished)
    },
    activity,
    previous
  };
}

/** Prices are static for a session, so read the model catalog once per process. */
let priceCache;
export function loadPriceMap(client) {
  if (!priceCache) {
    priceCache = (async () => {
      try {
        return priceMapFrom(await client.model.list());
      } catch {
        return new Map();
      }
    })();
  }
  return priceCache;
}
/**
 * Split a session's cost by where the tokens came from. Token counts times the model's
 * per-million prices give the shape; scaling to the reported session cost keeps the total
 * exact. If a model has no catalog price, fall back to the token mix.
 */
export function sessionCostSplit(session, prices) {
  const tokens = session?.tokens ?? {};
  const model = session?.model ?? {};
  const modelID = String(model.modelID ?? model.id ?? "");
  const price = modelID ? prices.get(`${model.providerID ?? ""}/${modelID}`) ?? prices.get(modelID) : undefined;
  const inputPrice = safeNumber(price?.input);
  const outputPrice = safeNumber(price?.output);
  const readPrice = safeNumber(price?.cache?.read ?? price?.input);
  const writePrice = safeNumber(price?.cache?.write ?? price?.input);
  const inputTokens = safeNumber(tokens.input);
  const outputTokens = safeNumber(tokens.output);
  const readTokens = safeNumber(tokens.cache?.read);
  const writeTokens = safeNumber(tokens.cache?.write);
  const input = inputTokens * inputPrice / 1_000_000;
  const output = outputTokens * outputPrice / 1_000_000;
  const cached = (readTokens * readPrice + writeTokens * writePrice) / 1_000_000;
  const computed = input + output + cached;
  const actual = safeNumber(session?.cost);
  if (computed > 0 && actual > 0) {
    const scale = actual / computed;
    return {
      input: input * scale,
      output: output * scale,
      cached: cached * scale,
      total: actual
    };
  }
  const tokenTotal = inputTokens + outputTokens + readTokens + writeTokens;
  if (tokenTotal > 0 && actual > 0) {
    return {
      input: actual * inputTokens / tokenTotal,
      output: actual * outputTokens / tokenTotal,
      cached: actual * (readTokens + writeTokens) / tokenTotal,
      total: actual
    };
  }
  return {
    input,
    output,
    cached,
    total: computed
  };
}