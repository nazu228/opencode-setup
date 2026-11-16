import {
  createComponent as _$createComponent,
  createElement as _$createElement,
  effect as _$effect,
  insert as _$insert,
  insertNode as _$insertNode,
  setProp as _$setProp,
} from "@opentui/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { pad, pct, truncate } from "./format.js";

const REFRESH_MS = 30000;
const CLOCK_MS = 100;
const ANIMATION_MS = 900;

function message(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value ?? 0)));
}

function level(value, status) {
  if ((status && status !== "ok") || value >= 100) return "bad";
  if (value >= 80) return "warn";
  return "ok";
}

function colorOf(theme, kind, value, status) {
  const state = level(value, status);
  if (state === "bad") return theme.text.feedback.error.base;
  if (state === "warn") return theme.text.feedback.warning.base;
  return kind === "five" ? theme.hue.blue[300] : theme.hue.blue[200];
}

function barString(value, cells, clock, shimmerOn) {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * cells);
  const shimmer = shimmerOn ? (Math.floor(clock / 120) % (cells + 4)) - 2 : -1;
  let out = "";
  for (let index = 0; index < cells; index += 1) {
    if (index >= filled) out += "░";
    else out += index === shimmer ? "▓" : "█";
  }
  return out;
}

async function loadAccount(id, label, active, access) {
  const base = { id, label, active };
  try {
    const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
      headers: {
        Authorization: `Bearer ${access}`,
        "User-Agent": "opencode-oc-stats/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return { ...base, rolling: body.usage?.rolling, weekly: body.usage?.weekly };
  } catch (cause) {
    return { ...base, error: message(cause) };
  }
}

async function loadLimits(client) {
  let entries;
  try {
    const response = await client.credential.list();
    entries = Array.isArray(response) ? response : response?.data ?? [];
  } catch (cause) {
    return { error: message(cause), accounts: [] };
  }
  const pending = entries.flatMap((entry) => {
    const value = entry.value;
    if (entry.integrationID !== "opencode" || value?.type !== "oauth" || !value.access) return [];
    return [loadAccount(entry.id, entry.label, entry.active === true, value.access)];
  });
  return { accounts: await Promise.all(pending) };
}

function LimitHeader(props) {
  const left = () => `${props.label} `;
  const rule = () => "─".repeat(Math.max(0, props.width - left().length));
  return (() => {
    var _el = _$createElement("text"),
      _label = _$createElement("span"),
      _rule = _$createElement("span");
    _$insertNode(_el, _label);
    _$insertNode(_el, _rule);
    _$setProp(_el, "wrapMode", "none");
    _$setProp(_el, "selectable", false);
    _$insert(_label, () => props.label);
    _$insert(_rule, () => ` ${rule()}`);
    _$effect(
      (_p) => {
        var _v = { fg: props.color, bold: true },
          _v2 = { fg: props.theme.text.muted };
        _v !== _p.e && (_p.e = _$setProp(_label, "style", _v, _p.e));
        _v2 !== _p.t && (_p.t = _$setProp(_rule, "style", _v2, _p.t));
        return _p;
      },
      { e: undefined, t: undefined },
    );
    return _el;
  })();
}

function LimitRow(props) {
  return (() => {
    var _el = _$createElement("text"),
      _label = _$createElement("span"),
      _value = _$createElement("span");
    _$insertNode(_el, _label);
    _$insertNode(_el, _value);
    _$setProp(_el, "wrapMode", "none");
    _$setProp(_el, "selectable", false);
    _$insert(_label, () => props.label);
    _$insert(_value, () => props.value);
    _$effect(
      (_p) => {
        var _v = { fg: props.labelColor ?? props.theme.text.muted },
          _v2 = { fg: props.color ?? props.theme.text.base };
        _v !== _p.e && (_p.e = _$setProp(_label, "style", _v, _p.e));
        _v2 !== _p.t && (_p.t = _$setProp(_value, "style", _v2, _p.t));
        return _p;
      },
      { e: undefined, t: undefined },
    );
    return _el;
  })();
}

export function LimitsFooter(props) {
  const ctx = props.ctx;
  const theme = () => ctx.theme;
  const [accounts, setAccounts] = createSignal([]);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [width, setWidth] = createSignal(36);
  const [clock, setClock] = createSignal(Date.now());
  const [animations, setAnimations] = createSignal([]);

  const targets = new Map();
  let alive = true;
  let request = 0;
  let refreshTimer;

  const cells = () => Math.max(10, Math.min(40, width() - 17));
  const spinner = () => ["◐", "◓", "◑", "◒"][Math.floor(clock() / 150) % 4];

  function animate(list) {
    const next = new Map();
    for (const account of list) {
      next.set(`${account.id}:five`, clamp(account.rolling?.percent));
      next.set(`${account.id}:week`, clamp(account.weekly?.percent));
    }
    const now = Date.now();
    const changes = [];
    for (const [key, to] of next) {
      const from = targets.get(key) ?? 0;
      if (Math.abs(from - to) >= 0.01) changes.push({ key, from, to, start: now });
    }
    targets.clear();
    for (const [key, value] of next) targets.set(key, value);
    setAnimations(changes);
  }

  function animated(key, target) {
    const animation = animations().find((item) => item.key === key);
    if (!animation) return target;
    const progress = Math.min(1, Math.max(0, (clock() - animation.start) / ANIMATION_MS));
    const eased = 1 - Math.pow(1 - progress, 3);
    return animation.from + (animation.to - animation.from) * eased;
  }

  async function load() {
    const id = ++request;
    try {
      const result = await loadLimits(ctx.client);
      if (!alive || id !== request) return;
      setAccounts(result.accounts);
      setError(result.error ?? "");
      setLoading(false);
      animate(result.accounts);
    } catch (cause) {
      if (!alive || id !== request) return;
      setError(message(cause));
      setLoading(false);
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void load();
    }, 1500);
  }

  onMount(() => {
    void load();
    const clockTimer = setInterval(() => setClock(Date.now()), CLOCK_MS);
    const refresh = setInterval(() => void load(), REFRESH_MS);
    const stopSwitch = ctx.data.on("credential.switched", scheduleRefresh);
    const stopUsage = ctx.data.on("session.usage.updated", scheduleRefresh);
    onCleanup(() => {
      alive = false;
      clearInterval(clockTimer);
      clearInterval(refresh);
      if (refreshTimer) clearTimeout(refreshTimer);
      stopSwitch();
      stopUsage();
    });
  });

  return (() => {
    var _el = _$createElement("box");
    _$setProp(_el, "flexDirection", "column");
    _$setProp(_el, "flexShrink", 0);
    _$setProp(_el, "onSizeChange", function () {
      const measured = this.width;
      if (measured > 0) queueMicrotask(() => setWidth(measured));
    });
    _$setProp(_el, "onMouseDown", () => void load());
    _$insert(
      _el,
      _$createComponent(Show, {
        get when() {
          return accounts().length > 0;
        },
        get fallback() {
          var _fallback = _$createElement("text");
          _$setProp(_fallback, "wrapMode", "word");
          _$setProp(_fallback, "selectable", false);
          _$insert(_fallback, () => (error() ? ` Лимиты: ${error()}` : ` Лимиты · загрузка ${spinner()}`));
          _$effect(
            (_p) =>
              _$setProp(
                _fallback,
                "fg",
                error() ? theme().text.feedback.error.base : theme().text.muted,
                _p,
              ),
            { e: undefined },
          );
          return _fallback;
        },
        get children() {
          return _$createComponent(For, {
            get each() {
              return accounts();
            },
            children: (account, index) => {
              const five = () => clamp(account.rolling?.percent);
              const week = () => clamp(account.weekly?.percent);
              const fiveShown = () => animated(`${account.id}:five`, five());
              const weekShown = () => animated(`${account.id}:week`, week());
              const fiveColor = () => colorOf(theme(), "five", fiveShown(), account.rolling?.status);
              const weekColor = () => colorOf(theme(), "week", weekShown(), account.weekly?.status);
              const labelColor = () =>
                account.error
                  ? theme().text.feedback.error.base
                  : account.active
                    ? theme().hue.blue[200]
                    : theme().text.muted;
              const row = (getLabel, getValue, getLabelColor, getColor) =>
                _$createComponent(LimitRow, {
                  get theme() {
                    return theme();
                  },
                  get label() {
                    return getLabel();
                  },
                  get value() {
                    return getValue();
                  },
                  get labelColor() {
                    return getLabelColor();
                  },
                  get color() {
                    return getColor();
                  },
                });
              const block = _$createElement("box");
              _$setProp(block, "flexDirection", "column");
              _$setProp(block, "flexShrink", 0);
              _$insert(
                block,
                row(
                  () => `${pad(`${account.active ? "●" : "○"} ${truncate(account.label, 6)}`, 8)} 5ч`,
                  () =>
                    account.error
                      ? " —"
                      : ` ${barString(fiveShown(), cells(), clock(), account.active)} ${pct(fiveShown() / 100)}`,
                  labelColor,
                  () => (account.error ? theme().text.feedback.error.base : fiveColor()),
                ),
              );
              _$insert(
                block,
                row(
                  () => pad("      нед", 11),
                  () =>
                    account.error
                      ? " —"
                      : ` ${barString(weekShown(), cells(), clock(), account.active)} ${pct(weekShown() / 100)}`,
                  () => theme().text.muted,
                  () => (account.error ? theme().text.feedback.error.base : weekColor()),
                ),
              );
              _$insert(
                block,
                _$createComponent(Show, {
                  get when() {
                    return index() < accounts().length - 1;
                  },
                  get children() {
                    const spacer = _$createElement("text");
                    _$setProp(spacer, "wrapMode", "none");
                    _$setProp(spacer, "selectable", false);
                    _$insert(spacer, () => " ");
                    return spacer;
                  },
                }),
              );
              return block;
            },
          });
        },
      }),
    );
    return _el;
  })();
}
