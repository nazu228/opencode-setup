import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
/**
 * oc-stats: a native usage dashboard for OpenCode.
 *
 * `/oc_stats` (or the command palette) opens a window with three tabs:
 * Overview, Projects and Performance. Everything is read from OpenCode's own
 * API through context.client; no database access and no server plugin.
 */
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { dayKey, loadDashboard, percentile, totalTokens } from "./data.js";
import { date, dateTime, delta, duration, pad, pct, shortModel, tokens as fmtTokens, truncate, usd } from "./format.js";
import { StatsSidebar } from "./sidebar.js";
const TABS = [{
  id: "overview",
  label: "Обзор"
}, {
  id: "projects",
  label: "Проекты"
}, {
  id: "performance",
  label: "Скорость"
}];
const RANGES = [{
  id: "24h",
  label: "24ч"
}, {
  id: "7d",
  label: "7д"
}, {
  id: "30d",
  label: "30д"
}, {
  id: "90d",
  label: "90д"
}, {
  id: "all",
  label: "всё"
}];
const METRICS = [{
  id: "cost",
  label: "расход"
}, {
  id: "tokens",
  label: "токены"
}, {
  id: "steps",
  label: "шаги"
}];
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const CELLS = ["·", "░", "▒", "▓", "█"];
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Approximate room inside the dialog for content: xlarge is 116, minus its and our padding. */
function useContentWidth() {
  const dimensions = useTerminalDimensions();
  return () => Math.max(40, Math.min(116, dimensions().width - 2) - 10);
}
function shortProvider(model) {
  const label = shortModel(model);
  return label.length > 26 ? truncate(label, 26) : label;
}
function metricValue(bucket, metric) {
  if (!bucket) return 0;
  if (metric === "cost") return bucket.cost ?? 0;
  if (metric === "tokens") return bucket.tokens ?? 0;
  return bucket.steps ?? 0;
}
function formatMetric(value, metric) {
  if (metric === "cost") return usd(value);
  if (metric === "tokens") return fmtTokens(value);
  return String(Math.round(value));
}
function weekColumns(d, metric) {
  const to = new Date(d.window.to);
  to.setHours(0, 0, 0, 0);
  let from = d.window.from > 0 ? d.window.from : to.getTime() - 26 * 7 * DAY_MS;
  from = Math.max(from, to.getTime() - 26 * 7 * DAY_MS);
  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  const weeks = [];
  for (let at = start.getTime(); at <= to.getTime(); at += 7 * DAY_MS) {
    const week = [];
    for (let day = 0; day < 7; day += 1) {
      const key = dayKey(at + day * DAY_MS);
      week.push({
        key,
        value: metricValue(d.daily[key], metric)
      });
    }
    weeks.push(week);
  }
  return weeks;
}
function sparkline(d, metric) {
  const end = new Date(d.window.to);
  end.setHours(0, 0, 0, 0);
  const days = [];
  for (let index = 29; index >= 0; index -= 1) {
    const at = end.getTime() - index * DAY_MS;
    days.push(metricValue(d.daily[dayKey(at)], metric));
  }
  const max = Math.max(...days, 1);
  return days.map(value => {
    if (value <= 0) return " ";
    const level = Math.min(SPARKS.length - 1, Math.max(0, Math.ceil(value / max * SPARKS.length) - 1));
    return SPARKS[level];
  }).join("");
}
function projectAverage(project) {
  return project.cost / Math.max(1, project.roots.length);
}
const LATENCY_MAX_MS = 10 * 60 * 1000;
function stableCalls(calls) {
  return calls.filter(call => call.duration <= LATENCY_MAX_MS);
}
function projectP50(project) {
  return percentile(stableCalls(project.calls).map(call => call.duration), 0.5);
}
function projectP95(project) {
  return percentile(stableCalls(project.calls).map(call => call.duration), 0.95);
}
function projectTtftP50(project) {
  return percentile(stableCalls(project.calls).map(call => call.ttft).filter(value => value !== undefined), 0.5);
}
function projectSpeedP50(project) {
  return percentile(stableCalls(project.calls).map(call => call.outputSpeed).filter(value => value !== undefined), 0.5);
}
function sortProjects(projects, key) {
  const list = [...projects];
  switch (key) {
    case "name":
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "sessions":
      list.sort((a, b) => b.roots.length - a.roots.length);
      break;
    case "tokens":
      list.sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
      break;
    case "avg":
      list.sort((a, b) => projectAverage(b) - projectAverage(a));
      break;
    case "wall":
      list.sort((a, b) => b.wall - a.wall);
      break;
    case "p50":
      list.sort((a, b) => (projectP50(b) ?? 0) - (projectP50(a) ?? 0));
      break;
    case "last":
      list.sort((a, b) => b.lastActive - a.lastActive);
      break;
    default:
      list.sort((a, b) => b.cost - a.cost);
  }
  return list;
}
function Section(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("box"),
      _el$3 = _$createElement("text"),
      _el$4 = _$createElement("box");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "marginTop", 2);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "flexShrink", 0);
    _$setProp(_el$2, "paddingBottom", 1);
    _$insert(_el$3, () => props.title);
    _$setProp(_el$4, "flexGrow", 1);
    _$insert(_el$2, () => props.right, null);
    _$insert(_el$, () => props.children, null);
    _$effect(_p$ => {
      var _v$ = TextAttributes.BOLD,
        _v$2 = props.theme.hue.accent[500];
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "attributes", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}
function Option(props) {
  return (() => {
    var _el$5 = _$createElement("box"),
      _el$6 = _$createElement("text");
    _$insertNode(_el$5, _el$6);
    _$setProp(_el$5, "paddingLeft", 1);
    _$setProp(_el$5, "paddingRight", 1);
    _$setProp(_el$5, "flexShrink", 0);
    _$setProp(_el$6, "wrapMode", "none");
    _$setProp(_el$6, "selectable", false);
    _$insert(_el$6, () => props.label);
    _$effect(_p$ => {
      var _v$3 = props.active ? props.theme.background.raised.high : undefined,
        _v$4 = props.run,
        _v$5 = props.active ? props.theme.text.action.primary.selected : props.theme.text.muted,
        _v$6 = props.active ? TextAttributes.BOLD : TextAttributes.NONE;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$5, "backgroundColor", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$5, "onMouseUp", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$6, "fg", _v$5, _p$.a));
      _v$6 !== _p$.o && (_p$.o = _$setProp(_el$6, "attributes", _v$6, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$5;
  })();
}
function Tab(props) {
  return (() => {
    var _el$7 = _$createElement("box"),
      _el$8 = _$createElement("text");
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$7, "paddingLeft", 1);
    _$setProp(_el$7, "paddingRight", 1);
    _$setProp(_el$7, "flexShrink", 0);
    _$setProp(_el$8, "wrapMode", "none");
    _$setProp(_el$8, "selectable", false);
    _$insert(_el$8, () => props.label);
    _$effect(_p$ => {
      var _v$7 = props.active ? props.theme.background.raised.high : undefined,
        _v$8 = props.run,
        _v$9 = props.active ? props.theme.text.action.primary.selected : props.theme.text.muted,
        _v$0 = props.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE;
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$7, "backgroundColor", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$7, "onMouseUp", _v$8, _p$.t));
      _v$9 !== _p$.a && (_p$.a = _$setProp(_el$8, "fg", _v$9, _p$.a));
      _v$0 !== _p$.o && (_p$.o = _$setProp(_el$8, "attributes", _v$0, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$7;
  })();
}
function Hints(props) {
  return (() => {
    var _el$9 = _$createElement("box");
    _$setProp(_el$9, "flexDirection", "row");
    _$setProp(_el$9, "flexWrap", "wrap");
    _$setProp(_el$9, "gap", 1);
    _$setProp(_el$9, "flexShrink", 0);
    _$insert(_el$9, _$createComponent(For, {
      get each() {
        return props.items;
      },
      children: ([key, label]) => (() => {
        var _el$0 = _$createElement("text"),
          _el$1 = _$createElement("span"),
          _el$10 = _$createElement("span");
        _$insertNode(_el$0, _el$1);
        _$insertNode(_el$0, _el$10);
        _$setProp(_el$0, "wrapMode", "none");
        _$setProp(_el$0, "selectable", false);
        _$insert(_el$1, key);
        _$insert(_el$10, ` ${label}`);
        _$effect(_p$ => {
          var _v$1 = {
              fg: props.theme.hue.accent[500],
              bold: true
            },
            _v$10 = {
              fg: props.theme.text.muted
            };
          _v$1 !== _p$.e && (_p$.e = _$setProp(_el$1, "style", _v$1, _p$.e));
          _v$10 !== _p$.t && (_p$.t = _$setProp(_el$10, "style", _v$10, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$0;
      })()
    }));
    return _el$9;
  })();
}
function SortLabel(props) {
  return (() => {
    var _el$11 = _$createElement("text");
    _$setProp(_el$11, "wrapMode", "none");
    _$setProp(_el$11, "selectable", false);
    _$insert(_el$11, () => props.label);
    _$effect(_p$ => {
      var _v$11 = props.active ? props.theme.text.action.primary.selected : props.theme.text.muted,
        _v$12 = props.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE,
        _v$13 = props.run;
      _v$11 !== _p$.e && (_p$.e = _$setProp(_el$11, "fg", _v$11, _p$.e));
      _v$12 !== _p$.t && (_p$.t = _$setProp(_el$11, "attributes", _v$12, _p$.t));
      _v$13 !== _p$.a && (_p$.a = _$setProp(_el$11, "onMouseUp", _v$13, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$11;
  })();
}
function KpiGrid(props) {
  const d = props.d;
  const t = d.totals;
  const left = [["Расход", usd(t.cost), "Сессии", `${t.sessions}${t.subagents ? ` +${t.subagents}` : ""}`], ["Вход", fmtTokens(t.tokens.input), "Запросы", fmtTokens(t.prompts)], ["Выход", fmtTokens(t.tokens.output), "Шаги", fmtTokens(t.steps)], ["Рассуждения", fmtTokens(t.tokens.reasoning), "Актив. дни", String(t.activeDays)], ["Кэш чтение", fmtTokens(t.tokens.cache.read), "Серия", `${t.streak} дн.`], ["Кэш запись", fmtTokens(t.tokens.cache.write), "Кэш-хит", pct(t.cacheHit)], ["Экономия", usd(t.cacheSavings), "Вызовы", fmtTokens(t.tools)], ["Занятость", duration(t.busy), "Ошибки", String(t.toolErrors)]];
  const valueColor = label => {
    if (label === "Расход" || label === "Экономия") return props.theme.text.feedback.success.base;
    if (label === "Ошибки") return props.theme.text.feedback.error.base;
    if (label === "Занятость" || label === "Кэш-хит") return props.theme.hue.accent[500];
    return props.theme.text.base;
  };
  return (() => {
    var _el$12 = _$createElement("box"),
      _el$13 = _$createElement("box");
    _$insertNode(_el$12, _el$13);
    _$setProp(_el$12, "flexDirection", "row");
    _$setProp(_el$12, "flexShrink", 0);
    _$setProp(_el$12, "marginTop", 1);
    _$setProp(_el$12, "paddingLeft", 1);
    _$setProp(_el$13, "flexDirection", "column");
    _$setProp(_el$13, "width", 44);
    _$insert(_el$13, _$createComponent(For, {
      each: left,
      children: ([label, value, label2, value2], index) => (() => {
        var _el$14 = _$createElement("box"),
          _el$15 = _$createElement("text"),
          _el$16 = _$createElement("span"),
          _el$17 = _$createElement("span"),
          _el$18 = _$createElement("span"),
          _el$19 = _$createElement("span");
        _$insertNode(_el$14, _el$15);
        _$setProp(_el$14, "paddingLeft", 1);
        _$setProp(_el$14, "paddingRight", 1);
        _$insertNode(_el$15, _el$16);
        _$insertNode(_el$15, _el$17);
        _$insertNode(_el$15, _el$18);
        _$insertNode(_el$15, _el$19);
        _$setProp(_el$15, "wrapMode", "none");
        _$setProp(_el$15, "selectable", false);
        _$insert(_el$16, () => pad(label, 12));
        _$insert(_el$17, () => pad(value, 14));
        _$insert(_el$18, () => pad(label2, 12));
        _$insert(_el$19, value2);
        _$effect(_p$ => {
          var _v$14 = index() % 2 ? props.theme.background.raised.base : undefined,
            _v$15 = {
              fg: props.theme.text.muted
            },
            _v$16 = {
              fg: valueColor(label)
            },
            _v$17 = {
              fg: props.theme.text.muted
            },
            _v$18 = {
              fg: valueColor(label2)
            };
          _v$14 !== _p$.e && (_p$.e = _$setProp(_el$14, "backgroundColor", _v$14, _p$.e));
          _v$15 !== _p$.t && (_p$.t = _$setProp(_el$16, "style", _v$15, _p$.t));
          _v$16 !== _p$.a && (_p$.a = _$setProp(_el$17, "style", _v$16, _p$.a));
          _v$17 !== _p$.o && (_p$.o = _$setProp(_el$18, "style", _v$17, _p$.o));
          _v$18 !== _p$.i && (_p$.i = _$setProp(_el$19, "style", _v$18, _p$.i));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined,
          i: undefined
        });
        return _el$14;
      })()
    }));
    return _el$12;
  })();
}
function Heatmap(props) {
  const weeks = createMemo(() => weekColumns(props.d, props.metric));
  const max = createMemo(() => {
    let maximum = 0;
    for (const week of weeks()) {
      for (const cell of week) maximum = Math.max(maximum, cell.value);
    }
    return Math.max(maximum, 1);
  });
  const level = value => value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max() * 4)));
  const color = value => value <= 0 ? props.theme.text.muted : props.theme.hue.accent[500];
  return (() => {
    var _el$20 = _$createElement("box"),
      _el$21 = _$createElement("box"),
      _el$22 = _$createElement("text"),
      _el$24 = _$createElement("text"),
      _el$25 = _$createElement("box"),
      _el$26 = _$createElement("text"),
      _el$28 = _$createElement("text"),
      _el$30 = _$createElement("text"),
      _el$32 = _$createElement("text");
    _$insertNode(_el$20, _el$21);
    _$insertNode(_el$20, _el$25);
    _$setProp(_el$20, "flexDirection", "column");
    _$setProp(_el$20, "marginTop", 2);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$24);
    _$setProp(_el$21, "flexDirection", "row");
    _$setProp(_el$21, "flexShrink", 0);
    _$setProp(_el$21, "paddingBottom", 1);
    _$insertNode(_el$22, _$createTextNode(`Активность`));
    _$insert(_el$24, () => `  ${props.d.window.label}${props.d.window.days === 0 ? " · последние 26 недель" : ""} · клик по метрике или c`);
    _$insertNode(_el$25, _el$26);
    _$insertNode(_el$25, _el$28);
    _$insertNode(_el$25, _el$30);
    _$insertNode(_el$25, _el$32);
    _$setProp(_el$25, "flexDirection", "row");
    _$setProp(_el$25, "flexShrink", 0);
    _$setProp(_el$25, "marginTop", 0);
    _$setProp(_el$25, "gap", 1);
    _$insertNode(_el$26, _$createTextNode(`тон`));
    _$insert(_el$25, _$createComponent(For, {
      each: METRICS,
      children: metric => _$createComponent(Option, {
        get active() {
          return props.metric === metric.id;
        },
        get label() {
          return metric.label;
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setMetric(metric.id)
      })
    }), _el$28);
    _$insertNode(_el$28, _$createTextNode(`меньше `));
    _$insertNode(_el$30, _$createTextNode(`· ░ ▒ ▓ █`));
    _$insertNode(_el$32, _$createTextNode(` больше`));
    _$insert(_el$20, _$createComponent(For, {
      each: WEEKDAYS,
      children: (weekday, row) => (() => {
        var _el$34 = _$createElement("box"),
          _el$35 = _$createElement("text");
        _$insertNode(_el$34, _el$35);
        _$setProp(_el$34, "flexDirection", "row");
        _$setProp(_el$34, "flexShrink", 0);
        _$insert(_el$35, () => pad(weekday, 4));
        _$insert(_el$34, _$createComponent(For, {
          get each() {
            return weeks();
          },
          children: week => (() => {
            var _el$36 = _$createElement("text");
            _$setProp(_el$36, "selectable", false);
            _$insert(_el$36, () => `${CELLS[level(week[row()]?.value ?? 0)]} `);
            _$effect(_$p => _$setProp(_el$36, "fg", color(week[row()]?.value ?? 0), _$p));
            return _el$36;
          })()
        }), null);
        _$effect(_$p => _$setProp(_el$35, "fg", props.theme.text.muted, _$p));
        return _el$34;
      })()
    }), null);
    _$effect(_p$ => {
      var _v$19 = TextAttributes.BOLD,
        _v$20 = props.theme.hue.accent[500],
        _v$21 = props.theme.text.muted,
        _v$22 = props.theme.text.muted,
        _v$23 = props.theme.text.muted,
        _v$24 = props.theme.hue.accent[500],
        _v$25 = props.theme.text.muted;
      _v$19 !== _p$.e && (_p$.e = _$setProp(_el$22, "attributes", _v$19, _p$.e));
      _v$20 !== _p$.t && (_p$.t = _$setProp(_el$22, "fg", _v$20, _p$.t));
      _v$21 !== _p$.a && (_p$.a = _$setProp(_el$24, "fg", _v$21, _p$.a));
      _v$22 !== _p$.o && (_p$.o = _$setProp(_el$26, "fg", _v$22, _p$.o));
      _v$23 !== _p$.i && (_p$.i = _$setProp(_el$28, "fg", _v$23, _p$.i));
      _v$24 !== _p$.n && (_p$.n = _$setProp(_el$30, "fg", _v$24, _p$.n));
      _v$25 !== _p$.s && (_p$.s = _$setProp(_el$32, "fg", _v$25, _p$.s));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined
    });
    return _el$20;
  })();
}
function Spark(props) {
  return (() => {
    var _el$37 = _$createElement("box"),
      _el$38 = _$createElement("text"),
      _el$39 = _$createElement("text"),
      _el$40 = _$createElement("text"),
      _el$41 = _$createTextNode(`последние 30 дней · `),
      _el$42 = _$createElement("span"),
      _el$43 = _$createTextNode(` сегодня`);
    _$insertNode(_el$37, _el$38);
    _$insertNode(_el$37, _el$39);
    _$insertNode(_el$37, _el$40);
    _$setProp(_el$37, "flexDirection", "column");
    _$setProp(_el$37, "marginTop", 2);
    _$insert(_el$38, () => `За день: ${METRICS.find(item => item.id === props.metric)?.label ?? props.metric}`);
    _$setProp(_el$39, "selectable", false);
    _$insert(_el$39, () => sparkline(props.d, props.metric));
    _$insertNode(_el$40, _el$41);
    _$insertNode(_el$40, _el$42);
    _$insertNode(_el$40, _el$43);
    _$setProp(_el$40, "wrapMode", "none");
    _$insert(_el$42, () => formatMetric(metricValue(props.d.daily[dayKey(props.d.window.to)], props.metric), props.metric));
    _$effect(_p$ => {
      var _v$26 = TextAttributes.BOLD,
        _v$27 = props.theme.hue.accent[500],
        _v$28 = props.theme.hue.accent[500],
        _v$29 = props.theme.text.muted,
        _v$30 = {
          fg: props.theme.text.feedback.success.base
        };
      _v$26 !== _p$.e && (_p$.e = _$setProp(_el$38, "attributes", _v$26, _p$.e));
      _v$27 !== _p$.t && (_p$.t = _$setProp(_el$38, "fg", _v$27, _p$.t));
      _v$28 !== _p$.a && (_p$.a = _$setProp(_el$39, "fg", _v$28, _p$.a));
      _v$29 !== _p$.o && (_p$.o = _$setProp(_el$40, "fg", _v$29, _p$.o));
      _v$30 !== _p$.i && (_p$.i = _$setProp(_el$42, "style", _v$30, _p$.i));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined
    });
    return _el$37;
  })();
}
function Comparison(props) {
  const previous = props.d.previous;
  if (!previous) return null;
  const current = props.d.totals;
  const costChange = current.cost - previous.cost;
  return (() => {
    var _el$44 = _$createElement("box"),
      _el$45 = _$createElement("text"),
      _el$47 = _$createElement("text"),
      _el$48 = _$createElement("span"),
      _el$49 = _$createElement("span"),
      _el$50 = _$createElement("span"),
      _el$51 = _$createElement("text"),
      _el$52 = _$createElement("span"),
      _el$53 = _$createElement("span"),
      _el$54 = _$createElement("span"),
      _el$55 = _$createElement("text"),
      _el$56 = _$createElement("span"),
      _el$57 = _$createElement("span"),
      _el$58 = _$createElement("span");
    _$insertNode(_el$44, _el$45);
    _$insertNode(_el$44, _el$47);
    _$insertNode(_el$44, _el$51);
    _$insertNode(_el$44, _el$55);
    _$setProp(_el$44, "flexDirection", "column");
    _$setProp(_el$44, "marginTop", 2);
    _$insertNode(_el$45, _$createTextNode(`По сравнению с прошлым периодом`));
    _$insertNode(_el$47, _el$48);
    _$insertNode(_el$47, _el$49);
    _$insertNode(_el$47, _el$50);
    _$setProp(_el$47, "wrapMode", "none");
    _$setProp(_el$47, "selectable", false);
    _$insert(_el$48, () => pad("Расход", 12));
    _$insert(_el$49, () => pad(`${usd(previous.cost)} → ${usd(current.cost)}`, 28));
    _$insert(_el$50, () => delta(current.cost, previous.cost));
    _$insertNode(_el$51, _el$52);
    _$insertNode(_el$51, _el$53);
    _$insertNode(_el$51, _el$54);
    _$setProp(_el$51, "wrapMode", "none");
    _$setProp(_el$51, "selectable", false);
    _$insert(_el$52, () => pad("Токены", 12));
    _$insert(_el$53, () => `${fmtTokens(previous.tokens)} → ${fmtTokens(totalTokens(current.tokens))}`);
    _$insert(_el$54, () => `  ${delta(totalTokens(current.tokens), previous.tokens)}`);
    _$insertNode(_el$55, _el$56);
    _$insertNode(_el$55, _el$57);
    _$insertNode(_el$55, _el$58);
    _$setProp(_el$55, "wrapMode", "none");
    _$setProp(_el$55, "selectable", false);
    _$insert(_el$56, () => pad("Запросы", 12));
    _$insert(_el$57, () => `${fmtTokens(previous.prompts)} → ${fmtTokens(current.prompts)}`);
    _$insert(_el$58, () => `  ${delta(current.prompts, previous.prompts)}`);
    _$effect(_p$ => {
      var _v$31 = TextAttributes.BOLD,
        _v$32 = props.theme.hue.accent[500],
        _v$33 = {
          fg: props.theme.text.muted
        },
        _v$34 = {
          fg: props.theme.text.feedback.success.base
        },
        _v$35 = {
          fg: costChange > 0 ? props.theme.text.feedback.warning.base : props.theme.text.feedback.success.base
        },
        _v$36 = {
          fg: props.theme.text.muted
        },
        _v$37 = {
          fg: props.theme.text.base
        },
        _v$38 = {
          fg: props.theme.hue.accent[500]
        },
        _v$39 = {
          fg: props.theme.text.muted
        },
        _v$40 = {
          fg: props.theme.text.base
        },
        _v$41 = {
          fg: props.theme.text.muted
        };
      _v$31 !== _p$.e && (_p$.e = _$setProp(_el$45, "attributes", _v$31, _p$.e));
      _v$32 !== _p$.t && (_p$.t = _$setProp(_el$45, "fg", _v$32, _p$.t));
      _v$33 !== _p$.a && (_p$.a = _$setProp(_el$48, "style", _v$33, _p$.a));
      _v$34 !== _p$.o && (_p$.o = _$setProp(_el$49, "style", _v$34, _p$.o));
      _v$35 !== _p$.i && (_p$.i = _$setProp(_el$50, "style", _v$35, _p$.i));
      _v$36 !== _p$.n && (_p$.n = _$setProp(_el$52, "style", _v$36, _p$.n));
      _v$37 !== _p$.s && (_p$.s = _$setProp(_el$53, "style", _v$37, _p$.s));
      _v$38 !== _p$.h && (_p$.h = _$setProp(_el$54, "style", _v$38, _p$.h));
      _v$39 !== _p$.r && (_p$.r = _$setProp(_el$56, "style", _v$39, _p$.r));
      _v$40 !== _p$.d && (_p$.d = _$setProp(_el$57, "style", _v$40, _p$.d));
      _v$41 !== _p$.l && (_p$.l = _$setProp(_el$58, "style", _v$41, _p$.l));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined
    });
    return _el$44;
  })();
}
function ModelsTable(props) {
  const models = props.d.models.slice(0, 10);
  const width = useContentWidth();
  const compact = () => width() < 84;
  const [hovered, setHovered] = createSignal();
  const [pinned, setPinned] = createSignal();
  const full = () => hovered() ?? pinned();
  return _$createComponent(Section, {
    title: "\u041C\u043E\u0434\u0435\u043B\u0438",
    get theme() {
      return props.theme;
    },
    get children() {
      return [(() => {
        var _el$59 = _$createElement("box"),
          _el$60 = _$createElement("text");
        _$insertNode(_el$59, _el$60);
        _$setProp(_el$59, "paddingLeft", 1);
        _$setProp(_el$60, "wrapMode", "none");
        _$setProp(_el$60, "selectable", false);
        _$insert(_el$60, (() => {
          var _c$ = _$memo(() => !!compact());
          return () => _c$() ? `${pad("модель", 26)}${pad("шаги", 6)}${pad("токены", 8)}расход` : `${pad("модель", 41)}${pad("шаги", 8)}${pad("токены", 10)}${pad("расход", 9)}экономия`;
        })());
        _$effect(_$p => _$setProp(_el$60, "fg", props.theme.text.muted, _$p));
        return _el$59;
      })(), _$createComponent(Show, {
        get when() {
          return models.length > 0;
        },
        get fallback() {
          return (() => {
            var _el$64 = _$createElement("text");
            _$insertNode(_el$64, _$createTextNode(`В этом периоде модели не использовались.`));
            _$effect(_$p => _$setProp(_el$64, "fg", props.theme.text.muted, _$p));
            return _el$64;
          })();
        },
        get children() {
          return _$createComponent(For, {
            each: models,
            children: (model, index) => (() => {
              var _el$66 = _$createElement("box"),
                _el$67 = _$createElement("text"),
                _el$68 = _$createElement("span"),
                _el$69 = _$createElement("span"),
                _el$70 = _$createElement("span"),
                _el$71 = _$createElement("span");
              _$insertNode(_el$66, _el$67);
              _$setProp(_el$66, "paddingLeft", 1);
              _$setProp(_el$66, "paddingRight", 1);
              _$insertNode(_el$67, _el$68);
              _$insertNode(_el$67, _el$69);
              _$insertNode(_el$67, _el$70);
              _$insertNode(_el$67, _el$71);
              _$setProp(_el$67, "wrapMode", "none");
              _$setProp(_el$67, "selectable", false);
              _$setProp(_el$67, "onMouseOver", () => setHovered(model.label));
              _$setProp(_el$67, "onMouseOut", () => setHovered(undefined));
              _$setProp(_el$67, "onMouseUp", () => setPinned(current => current === model.label ? undefined : model.label));
              _$insert(_el$68, (() => {
                var _c$2 = _$memo(() => !!compact());
                return () => _c$2() ? pad(truncate(model.label, 25), 26) : pad(truncate(model.label, 40), 41);
              })());
              _$insert(_el$69, () => pad(String(model.steps), compact() ? 6 : 8));
              _$insert(_el$70, () => pad(fmtTokens(totalTokens(model.tokens)), compact() ? 8 : 10));
              _$insert(_el$71, () => pad(usd(model.cost), 9));
              _$insert(_el$67, (() => {
                var _c$3 = _$memo(() => !!!compact());
                return () => _c$3() ? (() => {
                  var _el$72 = _$createElement("span");
                  _$insert(_el$72, () => usd(model.cacheSavings));
                  _$effect(_$p => _$setProp(_el$72, "style", {
                    fg: props.theme.text.feedback.success.base
                  }, _$p));
                  return _el$72;
                })() : null;
              })(), null);
              _$effect(_p$ => {
                var _v$44 = pinned() === model.label || hovered() === model.label ? props.theme.background.raised.high : index() % 2 ? props.theme.background.raised.base : undefined,
                  _v$45 = {
                    fg: props.theme.text.base
                  },
                  _v$46 = {
                    fg: props.theme.hue.accent[500]
                  },
                  _v$47 = {
                    fg: props.theme.text.base
                  },
                  _v$48 = {
                    fg: props.theme.text.feedback.success.base
                  };
                _v$44 !== _p$.e && (_p$.e = _$setProp(_el$66, "backgroundColor", _v$44, _p$.e));
                _v$45 !== _p$.t && (_p$.t = _$setProp(_el$68, "style", _v$45, _p$.t));
                _v$46 !== _p$.a && (_p$.a = _$setProp(_el$69, "style", _v$46, _p$.a));
                _v$47 !== _p$.o && (_p$.o = _$setProp(_el$70, "style", _v$47, _p$.o));
                _v$48 !== _p$.i && (_p$.i = _$setProp(_el$71, "style", _v$48, _p$.i));
                return _p$;
              }, {
                e: undefined,
                t: undefined,
                a: undefined,
                o: undefined,
                i: undefined
              });
              return _el$66;
            })()
          });
        }
      }), _$createComponent(Show, {
        get when() {
          return models.length > 0;
        },
        get children() {
          var _el$61 = _$createElement("box");
          _$setProp(_el$61, "paddingLeft", 1);
          _$setProp(_el$61, "height", 2);
          _$setProp(_el$61, "flexDirection", "column");
          _$insert(_el$61, _$createComponent(Show, {
            get when() {
              return full();
            },
            get fallback() {
              return (() => {
                var _el$73 = _$createElement("text");
                _$insertNode(_el$73, _$createTextNode(`наведи на модель для полного имени · клик — закрепить`));
                _$setProp(_el$73, "wrapMode", "none");
                _$setProp(_el$73, "selectable", false);
                _$effect(_$p => _$setProp(_el$73, "fg", props.theme.text.muted, _$p));
                return _el$73;
              })();
            },
            get children() {
              var _el$62 = _$createElement("text"),
                _el$63 = _$createElement("span");
              _$insertNode(_el$62, _el$63);
              _$setProp(_el$62, "wrapMode", "word");
              _$setProp(_el$62, "selectable", false);
              _$insert(_el$62, () => `${compact() ? "имя" : "полное имя"}  `, _el$63);
              _$insert(_el$63, full);
              _$effect(_p$ => {
                var _v$42 = props.theme.text.muted,
                  _v$43 = {
                    fg: props.theme.text.base
                  };
                _v$42 !== _p$.e && (_p$.e = _$setProp(_el$62, "fg", _v$42, _p$.e));
                _v$43 !== _p$.t && (_p$.t = _$setProp(_el$63, "style", _v$43, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$62;
            }
          }));
          return _el$61;
        }
      })];
    }
  });
}
function Overview(props) {
  return (() => {
    var _el$75 = _$createElement("box");
    _$setProp(_el$75, "flexDirection", "column");
    _$insert(_el$75, _$createComponent(KpiGrid, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      }
    }), null);
    _$insert(_el$75, _$createComponent(Heatmap, {
      get d() {
        return props.d;
      },
      get metric() {
        return props.metric;
      },
      get setMetric() {
        return props.setMetric;
      },
      get theme() {
        return props.theme;
      }
    }), null);
    _$insert(_el$75, _$createComponent(Spark, {
      get d() {
        return props.d;
      },
      get metric() {
        return props.metric;
      },
      get theme() {
        return props.theme;
      }
    }), null);
    _$insert(_el$75, _$createComponent(Comparison, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      }
    }), null);
    _$insert(_el$75, _$createComponent(ModelsTable, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      }
    }), null);
    return _el$75;
  })();
}
function ProjectHeader(props) {
  return (() => {
    var _el$76 = _$createElement("box");
    _$setProp(_el$76, "flexDirection", "row");
    _$setProp(_el$76, "flexShrink", 0);
    _$setProp(_el$76, "marginTop", 2);
    _$setProp(_el$76, "paddingLeft", 1);
    _$insert(_el$76, (() => {
      var _c$4 = _$memo(() => !!props.compact);
      return () => _c$4() ? [_$createComponent(SortLabel, {
        get active() {
          return props.sort === "name";
        },
        get label() {
          return pad("  Проект", 23);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("name")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "sessions";
        },
        get label() {
          return pad("Сесс.", 5);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("sessions")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "cost";
        },
        get label() {
          return pad("Расход", 8);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("cost")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "tokens";
        },
        get label() {
          return pad("Токены", 8);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("tokens")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "wall";
        },
        get label() {
          return pad("Время", 9);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("wall")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "p50";
        },
        get label() {
          return pad("p50", 8);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("p50")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "last";
        },
        label: "\u041F\u043E\u0441\u043B.",
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("last")
      })] : [_$createComponent(SortLabel, {
        get active() {
          return props.sort === "name";
        },
        get label() {
          return pad("  Проект", 29);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("name")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "sessions";
        },
        get label() {
          return pad("Сесс.", 5);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("sessions")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "cost";
        },
        get label() {
          return pad("Расход", 8);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("cost")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "tokens";
        },
        get label() {
          return pad("Токены", 8);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("tokens")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "avg";
        },
        get label() {
          return pad("Сред.", 7);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("avg")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "wall";
        },
        get label() {
          return pad("Время", 9);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("wall")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "p50";
        },
        get label() {
          return pad("p50", 9);
        },
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("p50")
      }), _$createComponent(SortLabel, {
        get active() {
          return props.sort === "last";
        },
        label: "\u041F\u043E\u0441\u043B.",
        get theme() {
          return props.theme;
        },
        run: () => props.setSort("last")
      })];
    })());
    return _el$76;
  })();
}
function DetailLine(props) {
  return (() => {
    var _el$77 = _$createElement("text");
    _$setProp(_el$77, "wrapMode", "word");
    _$setProp(_el$77, "selectable", false);
    _$insert(_el$77, () => props.text);
    _$effect(_$p => _$setProp(_el$77, "fg", props.color ?? (props.muted ? props.theme.text.muted : props.theme.text.base), _$p));
    return _el$77;
  })();
}
function SessionDetail(props) {
  const session = () => props.session;
  const toolSummary = () => {
    const byName = new Map();
    for (const tool of session().tools) {
      const item = byName.get(tool.name) ?? {
        calls: 0,
        errors: 0,
        durations: []
      };
      item.calls += 1;
      if (tool.status === "error") item.errors += 1;
      item.durations.push(tool.duration);
      byName.set(tool.name, item);
    }
    return [...byName.entries()].map(([name, item]) => ({
      name,
      ...item,
      p50: percentile(item.durations, 0.5) ?? 0
    })).sort((a, b) => b.calls - a.calls).slice(0, 6);
  };
  const children = () => props.project.children.filter(child => child.parentID === session().id);
  const slow = () => [...session().calls].sort((a, b) => b.duration - a.duration).slice(0, 3);
  const recent = () => [...session().calls].sort((a, b) => b.end - a.end).slice(0, 5);
  const cacheHit = () => {
    const t = session().tokens;
    return t.cache.read + t.input + t.cache.write > 0 ? t.cache.read / (t.cache.read + t.input + t.cache.write) : 0;
  };
  return (() => {
    var _el$78 = _$createElement("box"),
      _el$87 = _$createElement("text");
    _$insertNode(_el$78, _el$87);
    _$setProp(_el$78, "flexDirection", "column");
    _$setProp(_el$78, "marginTop", 1);
    _$setProp(_el$78, "marginBottom", 1);
    _$setProp(_el$78, "paddingLeft", 3);
    _$setProp(_el$78, "paddingRight", 1);
    _$setProp(_el$78, "paddingTop", 1);
    _$setProp(_el$78, "paddingBottom", 1);
    _$setProp(_el$78, "border", ["left"]);
    _$insert(_el$78, _$createComponent(DetailLine, {
      get theme() {
        return props.theme;
      },
      muted: true,
      get text() {
        return `Время  общее ${duration(session().wall)} · работа ${duration(session().busy)} · простой ${duration(session().idle)} · посл. ${dateTime(session().updated)}`;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(DetailLine, {
      get theme() {
        return props.theme;
      },
      muted: true,
      get text() {
        return `Вызовы ${session().steps} · инструменты ${session().tools.length}${session().tools.filter(tool => tool.status === "error").length ? ` (${session().tools.filter(tool => tool.status === "error").length} ошибок)` : ""} · запросы ${session().prompts} · кэш-хит ${pct(cacheHit())}`;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(DetailLine, {
      get theme() {
        return props.theme;
      },
      get text() {
        return `Токены  вх ${fmtTokens(session().tokens.input)} · вых ${fmtTokens(session().tokens.output)} · рассуждения ${fmtTokens(session().tokens.reasoning)} · кэш чтение ${fmtTokens(session().tokens.cache.read)} · запись ${fmtTokens(session().tokens.cache.write)}`;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(DetailLine, {
      get theme() {
        return props.theme;
      },
      get color() {
        return props.theme.text.feedback.success.base;
      },
      get text() {
        return `Расход  ${usd(session().cost)} · экономия ${usd(session().cacheSavings)} · всего за сессию ${usd(session().totalCost)}`;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(DetailLine, {
      get theme() {
        return props.theme;
      },
      get color() {
        return props.theme.hue.accent[500];
      },
      get text() {
        return `Задержка TTFT p50 ${duration(percentile(stableCalls(session().calls).map(call => call.ttft).filter(value => value !== undefined), 0.5))} · вызов p50 ${duration(percentile(stableCalls(session().calls).map(call => call.duration), 0.5))} · вывод p50 ${percentile(stableCalls(session().calls).map(call => call.outputSpeed).filter(value => value !== undefined), 0.5)?.toFixed(0) ?? "—"} ток/с`;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(Show, {
      get when() {
        return toolSummary().length > 0;
      },
      get children() {
        var _el$79 = _$createElement("text"),
          _el$80 = _$createTextNode(`Инструменты `);
        _$insertNode(_el$79, _el$80);
        _$setProp(_el$79, "wrapMode", "word");
        _$setProp(_el$79, "selectable", false);
        _$insert(_el$79, () => toolSummary().map(tool => `${tool.name} ${tool.calls}${tool.errors ? `/${tool.errors} ош.` : ""} p50 ${duration(tool.p50)}`).join(" · "), null);
        _$effect(_$p => _$setProp(_el$79, "fg", props.theme.text.muted, _$p));
        return _el$79;
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(Show, {
      get when() {
        return slow().length > 0;
      },
      get children() {
        return [(() => {
          var _el$81 = _$createElement("text");
          _$insertNode(_el$81, _$createTextNode(`Самые медленные вызовы`));
          _$setProp(_el$81, "wrapMode", "none");
          _$setProp(_el$81, "selectable", false);
          _$effect(_p$ => {
            var _v$49 = props.theme.hue.accent[500],
              _v$50 = TextAttributes.BOLD;
            _v$49 !== _p$.e && (_p$.e = _$setProp(_el$81, "fg", _v$49, _p$.e));
            _v$50 !== _p$.t && (_p$.t = _$setProp(_el$81, "attributes", _v$50, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$81;
        })(), _$createComponent(For, {
          get each() {
            return slow();
          },
          children: call => (() => {
            var _el$89 = _$createElement("text"),
              _el$90 = _$createElement("span"),
              _el$91 = _$createElement("span");
            _$insertNode(_el$89, _el$90);
            _$insertNode(_el$89, _el$91);
            _$setProp(_el$89, "wrapMode", "none");
            _$setProp(_el$89, "selectable", false);
            _$insert(_el$90, () => `  ${pad(duration(call.duration), 8)}${pad(shortProvider(call.model), 28)}`);
            _$insert(_el$91, () => `${fmtTokens(call.tokens.output)} вых  ${usd(call.cost)}`);
            _$effect(_p$ => {
              var _v$60 = {
                  fg: call.duration > 60_000 ? props.theme.text.feedback.warning.base : props.theme.text.muted
                },
                _v$61 = {
                  fg: props.theme.text.base
                };
              _v$60 !== _p$.e && (_p$.e = _$setProp(_el$90, "style", _v$60, _p$.e));
              _v$61 !== _p$.t && (_p$.t = _$setProp(_el$91, "style", _v$61, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$89;
          })()
        })];
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(Show, {
      get when() {
        return recent().length > 0;
      },
      get children() {
        return [(() => {
          var _el$83 = _$createElement("text");
          _$insertNode(_el$83, _$createTextNode(`Последние сообщения`));
          _$setProp(_el$83, "wrapMode", "none");
          _$setProp(_el$83, "selectable", false);
          _$effect(_p$ => {
            var _v$51 = props.theme.hue.accent[500],
              _v$52 = TextAttributes.BOLD;
            _v$51 !== _p$.e && (_p$.e = _$setProp(_el$83, "fg", _v$51, _p$.e));
            _v$52 !== _p$.t && (_p$.t = _$setProp(_el$83, "attributes", _v$52, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$83;
        })(), _$createComponent(For, {
          get each() {
            return recent();
          },
          children: call => (() => {
            var _el$92 = _$createElement("text"),
              _el$93 = _$createElement("span"),
              _el$94 = _$createElement("span");
            _$insertNode(_el$92, _el$93);
            _$insertNode(_el$92, _el$94);
            _$setProp(_el$92, "wrapMode", "none");
            _$setProp(_el$92, "selectable", false);
            _$insert(_el$93, () => `  ${pad(dateTime(call.end), 17)}`);
            _$insert(_el$94, () => `${pad(shortProvider(call.model), 27)}${pad(duration(call.duration), 8)}${pad(fmtTokens(totalTokens(call.tokens)), 8)}${usd(call.cost)}`);
            _$effect(_p$ => {
              var _v$62 = {
                  fg: props.theme.text.muted
                },
                _v$63 = {
                  fg: props.theme.text.base
                };
              _v$62 !== _p$.e && (_p$.e = _$setProp(_el$93, "style", _v$62, _p$.e));
              _v$63 !== _p$.t && (_p$.t = _$setProp(_el$94, "style", _v$63, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$92;
          })()
        })];
      }
    }), _el$87);
    _$insert(_el$78, _$createComponent(Show, {
      get when() {
        return children().length > 0;
      },
      get children() {
        return [(() => {
          var _el$85 = _$createElement("text");
          _$insertNode(_el$85, _$createTextNode(`Сабагенты`));
          _$setProp(_el$85, "wrapMode", "none");
          _$setProp(_el$85, "selectable", false);
          _$effect(_p$ => {
            var _v$53 = props.theme.hue.accent[500],
              _v$54 = TextAttributes.BOLD;
            _v$53 !== _p$.e && (_p$.e = _$setProp(_el$85, "fg", _v$53, _p$.e));
            _v$54 !== _p$.t && (_p$.t = _$setProp(_el$85, "attributes", _v$54, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$85;
        })(), _$createComponent(For, {
          get each() {
            return children();
          },
          children: child => (() => {
            var _el$95 = _$createElement("text"),
              _el$96 = _$createElement("span"),
              _el$97 = _$createElement("span");
            _$insertNode(_el$95, _el$96);
            _$insertNode(_el$95, _el$97);
            _$setProp(_el$95, "wrapMode", "none");
            _$setProp(_el$95, "selectable", false);
            _$insert(_el$96, () => `  ↳ ${pad(truncate(child.title, 42), 44)}`);
            _$insert(_el$97, () => `${usd(child.cost)}  ${fmtTokens(totalTokens(child.tokens))}`);
            _$effect(_p$ => {
              var _v$64 = {
                  fg: props.theme.text.muted
                },
                _v$65 = {
                  fg: props.theme.text.base
                };
              _v$64 !== _p$.e && (_p$.e = _$setProp(_el$96, "style", _v$64, _p$.e));
              _v$65 !== _p$.t && (_p$.t = _$setProp(_el$97, "style", _v$65, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$95;
          })()
        })];
      }
    }), _el$87);
    _$insertNode(_el$87, _$createTextNode(`открыть сессию ↵`));
    _$setProp(_el$87, "selectable", false);
    _$effect(_p$ => {
      var _v$55 = props.theme.hue.accent[500],
        _v$56 = props.theme.background.raised.base,
        _v$57 = props.theme.text.action.primary.selected,
        _v$58 = TextAttributes.BOLD,
        _v$59 = props.open;
      _v$55 !== _p$.e && (_p$.e = _$setProp(_el$78, "borderColor", _v$55, _p$.e));
      _v$56 !== _p$.t && (_p$.t = _$setProp(_el$78, "backgroundColor", _v$56, _p$.t));
      _v$57 !== _p$.a && (_p$.a = _$setProp(_el$87, "fg", _v$57, _p$.a));
      _v$58 !== _p$.o && (_p$.o = _$setProp(_el$87, "attributes", _v$58, _p$.o));
      _v$59 !== _p$.i && (_p$.i = _$setProp(_el$87, "onMouseUp", _v$59, _p$.i));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined
    });
    return _el$78;
  })();
}
function Projects(props) {
  const width = useContentWidth();
  const compact = () => width() < 100;
  return (() => {
    var _el$98 = _$createElement("box");
    _$setProp(_el$98, "flexDirection", "column");
    _$insert(_el$98, _$createComponent(ProjectHeader, {
      get sort() {
        return props.sort;
      },
      get setSort() {
        return props.setSort;
      },
      get theme() {
        return props.theme;
      },
      get compact() {
        return compact();
      }
    }), null);
    _$insert(_el$98, _$createComponent(Show, {
      get when() {
        return props.projects.length > 0;
      },
      get fallback() {
        return (() => {
          var _el$99 = _$createElement("text");
          _$insertNode(_el$99, _$createTextNode(`В этом периоде сессий нет.`));
          _$effect(_$p => _$setProp(_el$99, "fg", props.theme.text.muted, _$p));
          return _el$99;
        })();
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return props.rows;
          },
          children: (row, index) => {
            if (row.kind === "project") {
              const project = row.project;
              const lit = () => props.focus === index();
              const p50 = projectP50(project);
              const line = compact() ? `${props.expanded[project.id] ? "▾" : "▸"} ${pad(truncate(project.name, 20), 21)}${pad(String(project.roots.length), 5)}${pad(usd(project.cost), 8)}${pad(fmtTokens(totalTokens(project.tokens)), 8)}${pad(duration(project.wall), 9)}${pad(duration(p50), 8)}${date(project.lastActive)}` : `${props.expanded[project.id] ? "▾" : "▸"} ${pad(truncate(project.name, 26), 27)}${pad(String(project.roots.length), 5)}${pad(usd(project.cost), 8)}${pad(fmtTokens(totalTokens(project.tokens)), 8)}${pad(usd(projectAverage(project)), 7)}${pad(duration(project.wall), 9)}${pad(duration(p50), 9)}${date(project.lastActive)}`;
              return (() => {
                var _el$101 = _$createElement("box"),
                  _el$102 = _$createElement("text");
                _$insertNode(_el$101, _el$102);
                _$setProp(_el$101, "flexDirection", "row");
                _$setProp(_el$101, "paddingLeft", 1);
                _$setProp(_el$101, "paddingRight", 1);
                _$setProp(_el$101, "onMouseUp", () => {
                  props.setFocus(index());
                  props.toggleProject(project.id);
                });
                _$setProp(_el$102, "wrapMode", "none");
                _$setProp(_el$102, "selectable", false);
                _$insert(_el$102, line);
                _$effect(_p$ => {
                  var _v$66 = index() > 0 ? 1 : 0,
                    _v$67 = lit() ? props.theme.background.action.primary.focused : index() % 2 ? props.theme.background.raised.base : undefined,
                    _v$68 = lit() ? props.theme.text.action.primary.focused : props.theme.text.base;
                  _v$66 !== _p$.e && (_p$.e = _$setProp(_el$101, "marginTop", _v$66, _p$.e));
                  _v$67 !== _p$.t && (_p$.t = _$setProp(_el$101, "backgroundColor", _v$67, _p$.t));
                  _v$68 !== _p$.a && (_p$.a = _$setProp(_el$102, "fg", _v$68, _p$.a));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined,
                  a: undefined
                });
                return _el$101;
              })();
            }
            const session = row.session;
            const project = row.project;
            const lit = () => props.focus === index();
            const line = compact() ? `  ${props.detail === session.id ? "▾" : "▸"} ${pad(truncate(session.title, 28), 30)}${pad(usd(session.cost), 8)}${pad(fmtTokens(totalTokens(session.tokens)), 8)}${pad(duration(session.wall), 9)}` : `  ${props.detail === session.id ? "▾" : "▸"} ${pad(truncate(session.title, 40), 42)}${pad(shortProvider(session.model), 27)}${pad(usd(session.cost), 8)}${pad(fmtTokens(totalTokens(session.tokens)), 8)}${pad(duration(session.wall), 9)}${date(session.updated)}`;
            return (() => {
              var _el$103 = _$createElement("box"),
                _el$104 = _$createElement("box"),
                _el$105 = _$createElement("text");
              _$insertNode(_el$103, _el$104);
              _$setProp(_el$103, "flexDirection", "column");
              _$insertNode(_el$104, _el$105);
              _$setProp(_el$104, "flexDirection", "row");
              _$setProp(_el$104, "paddingLeft", 1);
              _$setProp(_el$104, "paddingRight", 1);
              _$setProp(_el$104, "onMouseUp", () => {
                props.setFocus(index());
                props.toggleDetail(session.id);
              });
              _$setProp(_el$105, "wrapMode", "none");
              _$setProp(_el$105, "selectable", false);
              _$insert(_el$105, line);
              _$insert(_el$103, _$createComponent(Show, {
                get when() {
                  return props.detail === session.id;
                },
                get children() {
                  return _$createComponent(SessionDetail, {
                    session: session,
                    project: project,
                    get theme() {
                      return props.theme;
                    },
                    open: () => props.openSession(session.id)
                  });
                }
              }), null);
              _$effect(_p$ => {
                var _v$69 = lit() ? props.theme.background.action.primary.focused : index() % 2 ? props.theme.background.raised.base : undefined,
                  _v$70 = lit() ? props.theme.text.action.primary.focused : props.theme.text.base;
                _v$69 !== _p$.e && (_p$.e = _$setProp(_el$104, "backgroundColor", _v$69, _p$.e));
                _v$70 !== _p$.t && (_p$.t = _$setProp(_el$105, "fg", _v$70, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$103;
            })();
          }
        });
      }
    }), null);
    return _el$98;
  })();
}
function PerformanceTable(props) {
  const width = useContentWidth();
  const compact = () => width() < 100;
  return _$createComponent(Section, {
    title: "\u041F\u043E \u043F\u0440\u043E\u0435\u043A\u0442\u0430\u043C",
    get theme() {
      return props.theme;
    },
    get children() {
      return [(() => {
        var _el$106 = _$createElement("text");
        _$setProp(_el$106, "wrapMode", "none");
        _$setProp(_el$106, "selectable", false);
        _$insert(_el$106, (() => {
          var _c$5 = _$memo(() => !!compact());
          return () => _c$5() ? `${pad("Проект", 22)}${pad("Вызовы", 6)}${pad("TTFT p50", 9)}${pad("Вызов p50", 9)}${pad("ток/с", 7)}Ош.` : `${pad("Проект", 30)}${pad("Вызовы", 7)}${pad("TTFT p50", 10)}${pad("Вызов p50", 10)}${pad("Вызов p95", 10)}${pad("ток/с", 8)}${pad("Занят.", 9)}${pad("Ош.", 4)}`;
        })());
        _$effect(_$p => _$setProp(_el$106, "fg", props.theme.text.muted, _$p));
        return _el$106;
      })(), _$createComponent(For, {
        get each() {
          return props.d.projects;
        },
        children: (project, index) => (() => {
          var _el$107 = _$createElement("box"),
            _el$108 = _$createElement("text");
          _$insertNode(_el$107, _el$108);
          _$setProp(_el$107, "flexDirection", "row");
          _$setProp(_el$107, "paddingLeft", 1);
          _$setProp(_el$107, "paddingRight", 1);
          _$setProp(_el$107, "onMouseUp", () => props.openProject(project.id));
          _$setProp(_el$108, "wrapMode", "none");
          _$setProp(_el$108, "selectable", false);
          _$insert(_el$108, (() => {
            var _c$6 = _$memo(() => !!compact());
            return () => _c$6() ? `${pad(truncate(project.name, 20), 22)}${pad(String(project.calls.length), 6)}${pad(duration(projectTtftP50(project)), 9)}${pad(duration(projectP50(project)), 9)}${pad(projectSpeedP50(project)?.toFixed(0) ?? "—", 7)}${project.tools.filter(tool => tool.status === "error").length}` : `${pad(truncate(project.name, 28), 30)}${pad(String(project.calls.length), 7)}${pad(duration(projectTtftP50(project)), 10)}${pad(duration(projectP50(project)), 10)}${pad(duration(projectP95(project)), 10)}${pad(projectSpeedP50(project)?.toFixed(0) ?? "—", 8)}${pad(duration(project.busy), 9)}${project.tools.filter(tool => tool.status === "error").length}`;
          })());
          _$effect(_p$ => {
            var _v$71 = index() % 2 ? props.theme.background.raised.base : undefined,
              _v$72 = props.theme.text.base;
            _v$71 !== _p$.e && (_p$.e = _$setProp(_el$107, "backgroundColor", _v$71, _p$.e));
            _v$72 !== _p$.t && (_p$.t = _$setProp(_el$108, "fg", _v$72, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$107;
        })()
      })];
    }
  });
}
function SlowCalls(props) {
  const width = useContentWidth();
  const compact = () => width() < 100;
  return _$createComponent(Section, {
    title: "\u0421\u0430\u043C\u044B\u0435 \u043C\u0435\u0434\u043B\u0435\u043D\u043D\u044B\u0435 \u0432\u044B\u0437\u043E\u0432\u044B \u043C\u043E\u0434\u0435\u043B\u0438",
    get theme() {
      return props.theme;
    },
    get children() {
      return [(() => {
        var _el$109 = _$createElement("text");
        _$setProp(_el$109, "wrapMode", "none");
        _$setProp(_el$109, "selectable", false);
        _$insert(_el$109, (() => {
          var _c$7 = _$memo(() => !!compact());
          return () => _c$7() ? `${pad("Длит.", 9)}${pad("Проект", 18)}${pad("Модель", 24)}${pad("Вых.", 7)}Расход` : `${pad("Длит.", 9)}${pad("Проект", 24)}${pad("Сессия", 30)}${pad("Модель", 28)}${pad("Вых.", 8)}Расход`;
        })());
        _$effect(_$p => _$setProp(_el$109, "fg", props.theme.text.muted, _$p));
        return _el$109;
      })(), _$createComponent(For, {
        get each() {
          return props.d.slowestCalls.slice(0, 12);
        },
        children: (call, index) => (() => {
          var _el$110 = _$createElement("box"),
            _el$111 = _$createElement("text");
          _$insertNode(_el$110, _el$111);
          _$setProp(_el$110, "flexDirection", "row");
          _$setProp(_el$110, "paddingLeft", 1);
          _$setProp(_el$110, "paddingRight", 1);
          _$setProp(_el$110, "onMouseUp", () => props.openSession(call.sessionID));
          _$setProp(_el$111, "wrapMode", "none");
          _$setProp(_el$111, "selectable", false);
          _$insert(_el$111, (() => {
            var _c$8 = _$memo(() => !!compact());
            return () => _c$8() ? `${pad(duration(call.duration), 9)}${pad(truncate(call.projectName, 16), 18)}${pad(truncate(shortProvider(call.model), 22), 24)}${pad(fmtTokens(call.tokens.output), 7)}${usd(call.cost)}` : `${pad(duration(call.duration), 9)}${pad(truncate(call.projectName, 22), 24)}${pad(truncate(sessionTitle(props.d, call.sessionID), 28), 30)}${pad(truncate(shortProvider(call.model), 26), 28)}${pad(fmtTokens(call.tokens.output), 8)}${usd(call.cost)}`;
          })());
          _$effect(_p$ => {
            var _v$73 = index() % 2 ? props.theme.background.raised.base : undefined,
              _v$74 = props.theme.text.base;
            _v$73 !== _p$.e && (_p$.e = _$setProp(_el$110, "backgroundColor", _v$73, _p$.e));
            _v$74 !== _p$.t && (_p$.t = _$setProp(_el$111, "fg", _v$74, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$110;
        })()
      })];
    }
  });
}
function SlowTools(props) {
  const width = useContentWidth();
  const compact = () => width() < 100;
  return _$createComponent(Section, {
    title: "\u0421\u0430\u043C\u044B\u0435 \u043C\u0435\u0434\u043B\u0435\u043D\u043D\u044B\u0435 \u0432\u044B\u0437\u043E\u0432\u044B \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442\u043E\u0432",
    get theme() {
      return props.theme;
    },
    get children() {
      return [(() => {
        var _el$112 = _$createElement("text");
        _$setProp(_el$112, "wrapMode", "none");
        _$setProp(_el$112, "selectable", false);
        _$insert(_el$112, (() => {
          var _c$9 = _$memo(() => !!compact());
          return () => _c$9() ? `${pad("Длит.", 9)}${pad("Инструм.", 11)}${pad("Проект", 18)}Ожид. / вып.` : `${pad("Длит.", 9)}${pad("Инструм.", 14)}${pad("Проект", 24)}${pad("Сессия", 32)}Ожид. / вып.`;
        })());
        _$effect(_$p => _$setProp(_el$112, "fg", props.theme.text.muted, _$p));
        return _el$112;
      })(), _$createComponent(For, {
        get each() {
          return props.d.slowestTools.slice(0, 12);
        },
        children: (tool, index) => (() => {
          var _el$113 = _$createElement("box"),
            _el$114 = _$createElement("text");
          _$insertNode(_el$113, _el$114);
          _$setProp(_el$113, "flexDirection", "row");
          _$setProp(_el$113, "paddingLeft", 1);
          _$setProp(_el$113, "paddingRight", 1);
          _$setProp(_el$113, "onMouseUp", () => props.openSession(tool.sessionID));
          _$setProp(_el$114, "wrapMode", "none");
          _$setProp(_el$114, "selectable", false);
          _$insert(_el$114, (() => {
            var _c$0 = _$memo(() => !!compact());
            return () => _c$0() ? `${pad(duration(tool.duration), 9)}${pad(truncate(tool.name, 9), 11)}${pad(truncate(tool.projectName, 16), 18)}${duration(tool.wait)} / ${duration(tool.execution)}` : `${pad(duration(tool.duration), 9)}${pad(truncate(tool.name, 12), 14)}${pad(truncate(tool.projectName, 22), 24)}${pad(truncate(sessionTitle(props.d, tool.sessionID), 30), 32)}${duration(tool.wait)} / ${duration(tool.execution)}`;
          })());
          _$effect(_p$ => {
            var _v$75 = index() % 2 ? props.theme.background.raised.base : undefined,
              _v$76 = props.theme.text.base;
            _v$75 !== _p$.e && (_p$.e = _$setProp(_el$113, "backgroundColor", _v$75, _p$.e));
            _v$76 !== _p$.t && (_p$.t = _$setProp(_el$114, "fg", _v$76, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$113;
        })()
      })];
    }
  });
}
function sessionTitle(d, id) {
  return d.sessions.find(session => session.id === id)?.title ?? id;
}
function Performance(props) {
  const latency = props.d.latency;
  return (() => {
    var _el$115 = _$createElement("box"),
      _el$116 = _$createElement("box"),
      _el$117 = _$createElement("text"),
      _el$119 = _$createElement("text"),
      _el$120 = _$createElement("span"),
      _el$121 = _$createElement("span"),
      _el$122 = _$createElement("text"),
      _el$123 = _$createElement("span"),
      _el$124 = _$createElement("span"),
      _el$125 = _$createElement("text"),
      _el$126 = _$createElement("span"),
      _el$127 = _$createElement("span"),
      _el$128 = _$createElement("text"),
      _el$129 = _$createElement("span"),
      _el$130 = _$createElement("span"),
      _el$131 = _$createElement("text"),
      _el$132 = _$createElement("span"),
      _el$133 = _$createElement("span"),
      _el$134 = _$createElement("text"),
      _el$135 = _$createElement("span"),
      _el$136 = _$createElement("span"),
      _el$137 = _$createElement("text");
    _$insertNode(_el$115, _el$116);
    _$setProp(_el$115, "flexDirection", "column");
    _$insertNode(_el$116, _el$117);
    _$insertNode(_el$116, _el$119);
    _$insertNode(_el$116, _el$122);
    _$insertNode(_el$116, _el$125);
    _$insertNode(_el$116, _el$128);
    _$insertNode(_el$116, _el$131);
    _$insertNode(_el$116, _el$134);
    _$insertNode(_el$116, _el$137);
    _$setProp(_el$116, "flexDirection", "column");
    _$insertNode(_el$117, _$createTextNode(`Задержки`));
    _$insertNode(_el$119, _el$120);
    _$insertNode(_el$119, _el$121);
    _$setProp(_el$119, "wrapMode", "word");
    _$setProp(_el$119, "selectable", false);
    _$insert(_el$120, () => pad("TTFT", 16));
    _$insert(_el$121, () => `p50 ${duration(latency.ttft.p50)} · p95 ${duration(latency.ttft.p95)} · p99 ${duration(latency.ttft.p99)} · ${latency.ttft.count} вызовов`);
    _$insertNode(_el$122, _el$123);
    _$insertNode(_el$122, _el$124);
    _$setProp(_el$122, "wrapMode", "word");
    _$setProp(_el$122, "selectable", false);
    _$insert(_el$123, () => pad("Длит. вызова", 16));
    _$insert(_el$124, () => `p50 ${duration(latency.duration.p50)} · p95 ${duration(latency.duration.p95)} · p99 ${duration(latency.duration.p99)} · ${latency.duration.count} вызовов`);
    _$insertNode(_el$125, _el$126);
    _$insertNode(_el$125, _el$127);
    _$setProp(_el$125, "wrapMode", "word");
    _$setProp(_el$125, "selectable", false);
    _$insert(_el$126, () => pad("Длит. шага", 16));
    _$insert(_el$127, () => `p50 ${duration(latency.step.p50)} · p95 ${duration(latency.step.p95)} · p99 ${duration(latency.step.p99)} · включая инструменты`);
    _$insertNode(_el$128, _el$129);
    _$insertNode(_el$128, _el$130);
    _$setProp(_el$128, "wrapMode", "word");
    _$setProp(_el$128, "selectable", false);
    _$insert(_el$129, () => pad("Скорость вывода", 16));
    _$insert(_el$130, () => `p50 ${latency.outputSpeed.p50?.toFixed(0) ?? "—"} ток/с · p95 ${latency.outputSpeed.p95?.toFixed(0) ?? "—"} ток/с`);
    _$insertNode(_el$131, _el$132);
    _$insertNode(_el$131, _el$133);
    _$setProp(_el$131, "wrapMode", "word");
    _$setProp(_el$131, "selectable", false);
    _$insert(_el$132, () => pad("Длит. тула", 16));
    _$insert(_el$133, () => `p50 ${duration(latency.toolDuration.p50)} · p95 ${duration(latency.toolDuration.p95)} · ${latency.toolDuration.count} вызовов`);
    _$insertNode(_el$134, _el$135);
    _$insertNode(_el$134, _el$136);
    _$setProp(_el$134, "wrapMode", "word");
    _$setProp(_el$134, "selectable", false);
    _$insert(_el$135, () => pad("Время сессии", 16));
    _$insert(_el$136, () => `общее ${duration(props.d.totals.wall)} · работа ${duration(props.d.totals.busy)} · простой ${duration(props.d.totals.idle)}`);
    _$insertNode(_el$137, _$createTextNode(`Скорость вывода: чем больше, тем лучше; остальные метрики — чем меньше, тем лучше. Перцентили не учитывают вызовы дольше 10 минут.`));
    _$setProp(_el$137, "wrapMode", "word");
    _$insert(_el$115, _$createComponent(PerformanceTable, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      },
      get openProject() {
        return props.openProject;
      }
    }), null);
    _$insert(_el$115, _$createComponent(SlowCalls, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      },
      get openSession() {
        return props.openSession;
      }
    }), null);
    _$insert(_el$115, _$createComponent(SlowTools, {
      get d() {
        return props.d;
      },
      get theme() {
        return props.theme;
      },
      get openSession() {
        return props.openSession;
      }
    }), null);
    _$effect(_p$ => {
      var _v$77 = TextAttributes.BOLD,
        _v$78 = props.theme.hue.accent[500],
        _v$79 = {
          fg: props.theme.text.muted
        },
        _v$80 = {
          fg: props.theme.text.base
        },
        _v$81 = {
          fg: props.theme.text.muted
        },
        _v$82 = {
          fg: props.theme.text.base
        },
        _v$83 = {
          fg: props.theme.text.muted
        },
        _v$84 = {
          fg: props.theme.text.base
        },
        _v$85 = {
          fg: props.theme.text.muted
        },
        _v$86 = {
          fg: props.theme.text.base
        },
        _v$87 = {
          fg: props.theme.text.muted
        },
        _v$88 = {
          fg: props.theme.text.base
        },
        _v$89 = {
          fg: props.theme.text.muted
        },
        _v$90 = {
          fg: props.theme.text.base
        },
        _v$91 = props.theme.text.muted;
      _v$77 !== _p$.e && (_p$.e = _$setProp(_el$117, "attributes", _v$77, _p$.e));
      _v$78 !== _p$.t && (_p$.t = _$setProp(_el$117, "fg", _v$78, _p$.t));
      _v$79 !== _p$.a && (_p$.a = _$setProp(_el$120, "style", _v$79, _p$.a));
      _v$80 !== _p$.o && (_p$.o = _$setProp(_el$121, "style", _v$80, _p$.o));
      _v$81 !== _p$.i && (_p$.i = _$setProp(_el$123, "style", _v$81, _p$.i));
      _v$82 !== _p$.n && (_p$.n = _$setProp(_el$124, "style", _v$82, _p$.n));
      _v$83 !== _p$.s && (_p$.s = _$setProp(_el$126, "style", _v$83, _p$.s));
      _v$84 !== _p$.h && (_p$.h = _$setProp(_el$127, "style", _v$84, _p$.h));
      _v$85 !== _p$.r && (_p$.r = _$setProp(_el$129, "style", _v$85, _p$.r));
      _v$86 !== _p$.d && (_p$.d = _$setProp(_el$130, "style", _v$86, _p$.d));
      _v$87 !== _p$.l && (_p$.l = _$setProp(_el$132, "style", _v$87, _p$.l));
      _v$88 !== _p$.u && (_p$.u = _$setProp(_el$133, "style", _v$88, _p$.u));
      _v$89 !== _p$.c && (_p$.c = _$setProp(_el$135, "style", _v$89, _p$.c));
      _v$90 !== _p$.w && (_p$.w = _$setProp(_el$136, "style", _v$90, _p$.w));
      _v$91 !== _p$.m && (_p$.m = _$setProp(_el$137, "fg", _v$91, _p$.m));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined,
      u: undefined,
      c: undefined,
      w: undefined,
      m: undefined
    });
    return _el$115;
  })();
}
function StatsApp(props) {
  const ctx = props.ctx;
  const theme = () => ctx.theme;
  const dimensions = useTerminalDimensions();
  let rootRef;
  let scrollRef;
  const [saved, setSaved] = ctx.storage.store("ui", {
    initial: {
      tab: "overview",
      range: "30d",
      metric: "cost",
      sort: "cost"
    }
  });
  const [tab, setTab] = createSignal(saved.tab);
  const [range, setRange] = createSignal(saved.range);
  const [metric, setMetric] = createSignal(saved.metric);
  const [sort, setSort] = createSignal(saved.sort);
  const [data, setData] = createSignal();
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  const [phase, setPhase] = createSignal("Загрузка статистики");
  const [progress, setProgress] = createSignal("");
  const [expanded, setExpanded] = createSignal({});
  const [detail, setDetail] = createSignal();
  const [focus, setFocus] = createSignal(0);
  let request = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
    request += 1;
  });
  async function load() {
    const id = ++request;
    setLoading(true);
    setError("");
    setPhase("Загрузка статистики");
    setProgress("");
    try {
      const result = await loadDashboard(ctx.client, range(), {
        onPhase: value => {
          if (alive && id === request) setPhase(value);
        },
        onProgress: (done, total) => {
          if (alive && id === request) setProgress(`${done}/${total} сессий`);
        }
      });
      if (!alive || id !== request) return;
      setData(result);
      setPhase("Готово");
      if (detail() && !result.sessions.some(session => session.id === detail())) setDetail(undefined);
    } catch (cause) {
      if (!alive || id !== request) return;
      setError(cause?.message ?? String(cause));
    } finally {
      if (alive && id === request) setLoading(false);
    }
  }
  function chooseTab(next) {
    setTab(next);
    setFocus(0);
    void setSaved(draft => {
      draft.tab = next;
    });
  }
  function chooseRange(next) {
    setRange(next);
    void setSaved(draft => {
      draft.range = next;
    });
    void load();
  }
  function chooseMetric(next) {
    setMetric(next);
    void setSaved(draft => {
      draft.metric = next;
    });
  }
  function chooseSort(next) {
    setSort(next);
    void setSaved(draft => {
      draft.sort = next;
    });
  }
  function cycleTab(step) {
    const index = TABS.findIndex(item => item.id === tab());
    chooseTab(TABS[(index + step + TABS.length) % TABS.length].id);
  }
  function cycleMetric() {
    const index = METRICS.findIndex(item => item.id === metric());
    chooseMetric(METRICS[(index + 1) % METRICS.length].id);
  }
  function cycleRange(step) {
    const index = RANGES.findIndex(item => item.id === range());
    chooseRange(RANGES[(index + step + RANGES.length) % RANGES.length].id);
  }
  function toggleProject(id) {
    setExpanded(current => ({
      ...current,
      [id]: !current[id]
    }));
  }
  function toggleDetail(id) {
    setDetail(current => current === id ? undefined : id);
  }
  function openSession(id) {
    ctx.ui.dialog.clear();
    ctx.ui.router.navigate({
      type: "session",
      sessionID: id
    });
  }
  function openProject(id) {
    chooseTab("projects");
    setExpanded(current => ({
      ...current,
      [id]: true
    }));
    const rows = projectRows();
    const index = rows.findIndex(row => row.kind === "project" && row.project.id === id);
    if (index >= 0) setFocus(index);
  }
  const projects = createMemo(() => data() ? sortProjects(data().projects, sort()) : []);
  const projectRows = createMemo(() => {
    if (!data() || tab() !== "projects") return [];
    const rows = [];
    for (const project of projects()) {
      rows.push({
        kind: "project",
        project
      });
      if (!expanded()[project.id]) continue;
      const roots = [...project.roots].sort((a, b) => b.cost - a.cost);
      for (const session of roots) rows.push({
        kind: "session",
        session,
        project
      });
    }
    return rows;
  });
  createEffect(() => {
    const count = projectRows().length;
    if (focus() >= count) setFocus(Math.max(0, count - 1));
  });
  function move(delta) {
    if (tab() === "projects") {
      const count = projectRows().length;
      setFocus(Math.max(0, Math.min(count - 1, focus() + delta)));
      return;
    }
    scrollRef?.scrollBy(delta);
  }
  function activate() {
    if (tab() !== "projects") return;
    const row = projectRows()[focus()];
    if (!row) return;
    if (row.kind === "project") toggleProject(row.project.id);else toggleDetail(row.session.id);
  }
  function collapse() {
    if (tab() !== "projects") return;
    const row = projectRows()[focus()];
    if (!row) return;
    if (row.kind === "project") {
      if (expanded()[row.project.id]) toggleProject(row.project.id);
    } else {
      setDetail(undefined);
    }
  }
  function expand() {
    if (tab() !== "projects") return;
    const row = projectRows()[focus()];
    if (!row) return;
    if (row.kind === "project") {
      if (!expanded()[row.project.id]) toggleProject(row.project.id);
    } else {
      setDetail(row.session.id);
    }
  }
  function openFocused() {
    if (tab() !== "projects") return;
    const row = projectRows()[focus()];
    if (row?.kind === "session") openSession(row.session.id);
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    priority: 1000,
    commands: [{
      bind: "escape",
      title: "Закрыть статистику",
      group: "Статистика",
      run: () => ctx.ui.dialog.clear()
    }, {
      bind: "tab",
      title: "Следующая вкладка",
      group: "Статистика",
      run: () => cycleTab(1)
    }, {
      bind: "shift+tab",
      title: "Предыдущая вкладка",
      group: "Статистика",
      run: () => cycleTab(-1)
    }, {
      bind: "1",
      title: "Обзор",
      group: "Статистика",
      run: () => chooseTab("overview")
    }, {
      bind: "2",
      title: "Проекты",
      group: "Статистика",
      run: () => chooseTab("projects")
    }, {
      bind: "3",
      title: "Скорость",
      group: "Статистика",
      run: () => chooseTab("performance")
    }, {
      bind: "r",
      title: "Обновить",
      group: "Статистика",
      run: () => load()
    }, {
      bind: "c",
      title: "Метрика теплокарты",
      group: "Статистика",
      run: () => cycleMetric()
    }, {
      bind: "[",
      title: "Предыдущий период",
      group: "Статистика",
      run: () => cycleRange(-1)
    }, {
      bind: "]",
      title: "Следующий период",
      group: "Статистика",
      run: () => cycleRange(1)
    }, {
      bind: "o",
      title: "Открыть сессию",
      group: "Статистика",
      run: () => openFocused()
    }, {
      bind: "up",
      title: "Вверх",
      group: "Статистика",
      run: () => move(-1)
    }, {
      bind: "down",
      title: "Вниз",
      group: "Статистика",
      run: () => move(1)
    }, {
      bind: "pageup",
      title: "Страница вверх",
      group: "Статистика",
      run: () => scrollRef?.scrollBy(-(scrollRef.height || 1))
    }, {
      bind: "pagedown",
      title: "Страница вниз",
      group: "Статистика",
      run: () => scrollRef?.scrollBy(scrollRef.height || 1)
    }, {
      bind: "return",
      title: "Развернуть/свернуть",
      group: "Статистика",
      run: () => activate()
    }, {
      bind: "space",
      title: "Развернуть/свернуть",
      group: "Статистика",
      run: () => activate()
    }, {
      bind: "left",
      title: "Свернуть",
      group: "Статистика",
      run: () => collapse()
    }, {
      bind: "right",
      title: "Развернуть",
      group: "Статистика",
      run: () => expand()
    }]
  }));
  onMount(() => {
    void load();
    setTimeout(() => rootRef?.focus?.(), 20);
  });
  const height = () => Math.max(16, Math.min(40, dimensions().height - 6));
  return (() => {
    var _el$139 = _$createElement("box"),
      _el$140 = _$createElement("box"),
      _el$141 = _$createElement("text"),
      _el$143 = _$createElement("text"),
      _el$144 = _$createElement("box"),
      _el$145 = _$createElement("text"),
      _el$147 = _$createElement("text"),
      _el$149 = _$createElement("box"),
      _el$150 = _$createElement("box"),
      _el$151 = _$createElement("text"),
      _el$153 = _$createElement("box"),
      _el$155 = _$createElement("scrollbox");
    _$insertNode(_el$139, _el$140);
    _$insertNode(_el$139, _el$149);
    _$insertNode(_el$139, _el$150);
    _$insertNode(_el$139, _el$155);
    _$use(element => {
      rootRef = element;
    }, _el$139);
    _$setProp(_el$139, "flexDirection", "column");
    _$setProp(_el$139, "gap", 1);
    _$setProp(_el$139, "paddingLeft", 3);
    _$setProp(_el$139, "paddingRight", 3);
    _$setProp(_el$139, "paddingTop", 1);
    _$setProp(_el$139, "paddingBottom", 1);
    _$setProp(_el$139, "onMouseDown", () => rootRef?.focus?.());
    _$insertNode(_el$140, _el$141);
    _$insertNode(_el$140, _el$143);
    _$insertNode(_el$140, _el$144);
    _$insertNode(_el$140, _el$145);
    _$insertNode(_el$140, _el$147);
    _$setProp(_el$140, "flexDirection", "row");
    _$setProp(_el$140, "flexShrink", 0);
    _$insertNode(_el$141, _$createTextNode(`Статистика использования`));
    _$insert(_el$143, () => `  ${data()?.window.label ?? ""}`);
    _$setProp(_el$144, "flexGrow", 1);
    _$insertNode(_el$145, _$createTextNode(`esc`));
    _$setProp(_el$145, "onMouseUp", () => ctx.ui.dialog.clear());
    _$setProp(_el$145, "selectable", false);
    _$insertNode(_el$147, _$createTextNode(` закрыть`));
    _$setProp(_el$149, "flexDirection", "row");
    _$setProp(_el$149, "flexShrink", 0);
    _$setProp(_el$149, "gap", 1);
    _$insert(_el$149, _$createComponent(For, {
      each: TABS,
      children: item => _$createComponent(Tab, {
        get active() {
          return tab() === item.id;
        },
        get label() {
          return item.label;
        },
        get theme() {
          return theme();
        },
        run: () => chooseTab(item.id)
      })
    }));
    _$insertNode(_el$150, _el$151);
    _$insertNode(_el$150, _el$153);
    _$setProp(_el$150, "flexDirection", "row");
    _$setProp(_el$150, "flexShrink", 0);
    _$setProp(_el$150, "gap", 1);
    _$insertNode(_el$151, _$createTextNode(`Период`));
    _$insert(_el$150, _$createComponent(For, {
      each: RANGES,
      children: item => _$createComponent(Option, {
        get active() {
          return range() === item.id;
        },
        get label() {
          return item.label;
        },
        get theme() {
          return theme();
        },
        run: () => chooseRange(item.id)
      })
    }), _el$153);
    _$setProp(_el$153, "flexGrow", 1);
    _$insert(_el$150, _$createComponent(Show, {
      get when() {
        return loading();
      },
      get children() {
        var _el$154 = _$createElement("text");
        _$insert(_el$154, () => `${phase()}${progress() ? ` ${progress()}` : ""}`);
        _$effect(_$p => _$setProp(_el$154, "fg", theme().text.feedback.warning.base, _$p));
        return _el$154;
      }
    }), null);
    _$use(element => {
      scrollRef = element;
    }, _el$155);
    _$setProp(_el$155, "flexGrow", 1);
    _$insert(_el$155, _$createComponent(Show, {
      get when() {
        return error();
      },
      get fallback() {
        return _$createComponent(Show, {
          get when() {
            return data();
          },
          keyed: true,
          get fallback() {
            return (() => {
              var _el$157 = _$createElement("text");
              _$insert(_el$157, () => `${phase()}${progress() ? ` · ${progress()}` : ""}…`);
              _$effect(_$p => _$setProp(_el$157, "fg", theme().text.muted, _$p));
              return _el$157;
            })();
          },
          children: current => [_$createComponent(Show, {
            get when() {
              return tab() === "overview";
            },
            get children() {
              return _$createComponent(Overview, {
                d: current,
                get metric() {
                  return metric();
                },
                setMetric: chooseMetric,
                get theme() {
                  return theme();
                }
              });
            }
          }), _$createComponent(Show, {
            get when() {
              return tab() === "projects";
            },
            get children() {
              return _$createComponent(Projects, {
                d: current,
                get projects() {
                  return projects();
                },
                get rows() {
                  return projectRows();
                },
                get focus() {
                  return focus();
                },
                setFocus: setFocus,
                get expanded() {
                  return expanded();
                },
                toggleProject: toggleProject,
                get detail() {
                  return detail();
                },
                toggleDetail: toggleDetail,
                openSession: openSession,
                get sort() {
                  return sort();
                },
                setSort: chooseSort,
                get theme() {
                  return theme();
                }
              });
            }
          }), _$createComponent(Show, {
            get when() {
              return tab() === "performance";
            },
            get children() {
              return _$createComponent(Performance, {
                d: current,
                get theme() {
                  return theme();
                },
                openSession: openSession,
                openProject: openProject
              });
            }
          })]
        });
      },
      get children() {
        var _el$156 = _$createElement("text");
        _$insert(_el$156, error);
        _$effect(_$p => _$setProp(_el$156, "fg", theme().text.feedback.error.base, _$p));
        return _el$156;
      }
    }));
    _$insert(_el$139, _$createComponent(Hints, {
      get theme() {
        return theme();
      },
      get items() {
        return tab() === "projects" ? [["tab", "дальше"], ["1/2/3", "вкладки"], ["↑↓", "движение"], ["enter", "свернуть"], ["o", "открыть"], ["←→", "свернуть/развернуть"], ["[ ]", "период"], ["c", "метрика"], ["r", "обновить"], ["esc", "закрыть"]] : [["tab", "дальше"], ["1/2/3", "вкладки"], ["↑↓", "скролл"], ["[ ]", "период"], ["c", "метрика"], ["r", "обновить"], ["esc", "закрыть"]];
      }
    }), null);
    _$effect(_p$ => {
      var _v$92 = height(),
        _v$93 = TextAttributes.BOLD,
        _v$94 = theme().hue.accent[500],
        _v$95 = theme().text.muted,
        _v$96 = theme().text.action.primary.selected,
        _v$97 = TextAttributes.BOLD,
        _v$98 = theme().text.muted,
        _v$99 = theme().text.muted;
      _v$92 !== _p$.e && (_p$.e = _$setProp(_el$139, "height", _v$92, _p$.e));
      _v$93 !== _p$.t && (_p$.t = _$setProp(_el$141, "attributes", _v$93, _p$.t));
      _v$94 !== _p$.a && (_p$.a = _$setProp(_el$141, "fg", _v$94, _p$.a));
      _v$95 !== _p$.o && (_p$.o = _$setProp(_el$143, "fg", _v$95, _p$.o));
      _v$96 !== _p$.i && (_p$.i = _$setProp(_el$145, "fg", _v$96, _p$.i));
      _v$97 !== _p$.n && (_p$.n = _$setProp(_el$145, "attributes", _v$97, _p$.n));
      _v$98 !== _p$.s && (_p$.s = _$setProp(_el$147, "fg", _v$98, _p$.s));
      _v$99 !== _p$.h && (_p$.h = _$setProp(_el$151, "fg", _v$99, _p$.h));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined
    });
    return _el$139;
  })();
}
const plugin = Plugin.define({
  id: "oc-stats",
  setup(context) {
    const open = () => {
      context.ui.dialog.show(() => _$createComponent(StatsApp, {
        ctx: context
      }));
      context.ui.dialog.set({
        size: "xlarge",
        centered: true
      });
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "oc-stats.open",
        title: "Статистика использования",
        description: "Общая, по проектам и сессиям статистика использования, стоимость и задержки",
        group: "Статистика",
        palette: true,
        slash: {
          name: "oc_stats"
        },
        run: open
      }]
    }));

    // Storage is first read when the panel draws, matching how the reference quota plugin behaves.
    let sidebarStore;
    const sidebar = () => sidebarStore ??= context.storage.store("sidebar", {
      initial: {
        open: true,
        range: "24h"
      }
    });
    const disposeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: props => {
        const [state, update] = sidebar();
        return _$createComponent(StatsSidebar, {
          ctx: context,
          get sessionID() {
            return props.sessionID;
          },
          state: state,
          update: update,
          openStats: open
        });
      }
    });
    return () => disposeSidebar();
  }
});
export default plugin;