import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
/**
 * The oc-stats panel in the session sidebar.
 *
 * It is intentionally cheap: a `experimental.session.stats` request for the selected range,
 * one more for the previous range, and one scoped to the current project. No message fetching.
 * The full `/oc_stats` window remains the place for projects, sessions and latency detail.
 */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { dayKey, loadPriceMap, loadSidebarSummary, projectLabel, sessionCostSplit, totalTokens } from "./data.js";
import { delta, pad, pct, tokens as fmtTokens, truncate, usd } from "./format.js";
const RANGES = ["24h", "7d", "30d", "90d", "all"];
const RANGE_LABELS = {
  "24h": "24ч",
  "7d": "7д",
  "30d": "30д",
  "90d": "90д",
  all: "всё"
};
function rangeLabel(range) {
  return RANGE_LABELS[range] ?? range;
}
const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
/** Columns the panel uses until it knows its real width. */
const DEFAULT_WIDTH = 36;
function nextRange(range) {
  const index = RANGES.indexOf(range);
  return RANGES[(index + 1) % RANGES.length];
}
function sparkline(values) {
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  return values.map(value => SPARKS[Math.min(SPARKS.length - 1, Math.round(value / max * (SPARKS.length - 1)))]).join("");
}

/** The last `days` daily step counts, filling days the server did not report with zero. */
function recentSteps(activity, days) {
  const byDay = new Map(activity.map(item => [item.date, item.steps]));
  const values = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - offset);
    values.push(byDay.get(dayKey(day.getTime())) ?? 0);
  }
  return values;
}
function Row(props) {
  return (() => {
    var _el$ = _$createElement("text"),
      _el$2 = _$createElement("span"),
      _el$3 = _$createElement("span");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "wrapMode", "none");
    _$setProp(_el$, "selectable", false);
    _$insert(_el$2, () => pad(props.label, 8));
    _$insert(_el$3, () => props.value);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return props.note;
      },
      get children() {
        var _el$4 = _$createElement("span");
        _$insert(_el$4, () => `  ${props.note}`);
        _$effect(_$p => _$setProp(_el$4, "style", {
          fg: props.noteColor ?? props.theme.text.muted
        }, _$p));
        return _el$4;
      }
    }), null);
    _$effect(_p$ => {
      var _v$ = {
          fg: props.theme.text.muted
        },
        _v$2 = {
          fg: props.color ?? props.theme.text.base
        };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "style", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "style", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$;
  })();
}

/** A section title with a colored rule, so session/project/range read as separate blocks. */
function Header(props) {
  const left = () => props.note ? `${props.label} ${props.note} ` : `${props.label} `;
  const rule = () => "─".repeat(Math.max(0, props.width - left().length));
  return (() => {
    var _el$5 = _$createElement("text"),
      _el$6 = _$createElement("span"),
      _el$8 = _$createElement("span");
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$8);
    _$setProp(_el$5, "wrapMode", "none");
    _$setProp(_el$5, "selectable", false);
    _$insert(_el$6, () => props.label);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return props.note;
      },
      get children() {
        var _el$7 = _$createElement("span");
        _$insert(_el$7, () => ` ${props.note}`);
        _$effect(_$p => _$setProp(_el$7, "style", {
          fg: props.noteColor ?? props.theme.text.muted,
          ...props.noteStyle
        }, _$p));
        return _el$7;
      }
    }), _el$8);
    _$insert(_el$8, () => ` ${rule()}`);
    _$effect(_p$ => {
      var _v$3 = props.onPress,
        _v$4 = {
          fg: props.color,
          bold: true
        },
        _v$5 = {
          fg: props.theme.text.muted
        };
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$5, "onMouseDown", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "style", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$8, "style", _v$5, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$5;
  })();
}

/** Split `width` cells across `values` so the rounded parts add up to exactly `width`. */
function splitCells(values, total, width) {
  if (width <= 0 || total <= 0) return values.map(() => 0);
  const raw = values.map(value => value / total * width);
  const cells = raw.map(value => Math.floor(value));
  const remaining = width - cells.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({
    index,
    fraction: value - Math.floor(value)
  })).sort((a, b) => b.fraction - a.fraction);
  for (let index = 0; index < remaining; index += 1) cells[order[index % order.length].index] += 1;
  return cells;
}

/** The session's spend split by output, billed input and cached tokens, as one stacked bar. */
function CostBar(props) {
  const colors = () => [props.theme.text.feedback.warning.base, props.theme.hue.accent[500], props.theme.text.feedback.success.base];
  const values = () => [props.split.output, props.split.input, props.split.cached];
  const cells = () => Math.max(8, props.width - 8);
  const parts = () => splitCells(values(), props.split.total, cells());
  const share = value => props.split.total > 0 ? value / props.split.total : 0;
  return (() => {
    var _el$9 = _$createElement("box"),
      _el$0 = _$createElement("text"),
      _el$1 = _$createElement("span"),
      _el$13 = _$createElement("text"),
      _el$14 = _$createElement("span"),
      _el$16 = _$createElement("span"),
      _el$17 = _$createElement("span"),
      _el$19 = _$createElement("span"),
      _el$20 = _$createElement("span"),
      _el$22 = _$createElement("span");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$13);
    _$setProp(_el$9, "flexDirection", "column");
    _$insertNode(_el$0, _el$1);
    _$setProp(_el$0, "wrapMode", "none");
    _$setProp(_el$0, "selectable", false);
    _$insert(_el$1, () => pad("Траты", 8));
    _$insert(_el$0, _$createComponent(Show, {
      get when() {
        return props.split.total > 0;
      },
      get fallback() {
        return (() => {
          var _el$23 = _$createElement("span");
          _$insert(_el$23, () => "░".repeat(cells()));
          _$effect(_$p => _$setProp(_el$23, "style", {
            fg: props.theme.text.muted
          }, _$p));
          return _el$23;
        })();
      },
      get children() {
        return [(() => {
          var _el$10 = _$createElement("span");
          _$insert(_el$10, () => "█".repeat(parts()[0]));
          _$effect(_$p => _$setProp(_el$10, "style", {
            fg: colors()[0]
          }, _$p));
          return _el$10;
        })(), (() => {
          var _el$11 = _$createElement("span");
          _$insert(_el$11, () => "█".repeat(parts()[1]));
          _$effect(_$p => _$setProp(_el$11, "style", {
            fg: colors()[1]
          }, _$p));
          return _el$11;
        })(), (() => {
          var _el$12 = _$createElement("span");
          _$insert(_el$12, () => "█".repeat(parts()[2]));
          _$effect(_$p => _$setProp(_el$12, "style", {
            fg: colors()[2]
          }, _$p));
          return _el$12;
        })()];
      }
    }), null);
    _$insertNode(_el$13, _el$14);
    _$insertNode(_el$13, _el$16);
    _$insertNode(_el$13, _el$17);
    _$insertNode(_el$13, _el$19);
    _$insertNode(_el$13, _el$20);
    _$insertNode(_el$13, _el$22);
    _$setProp(_el$13, "wrapMode", "none");
    _$setProp(_el$13, "selectable", false);
    _$insertNode(_el$14, _$createTextNode(`        `));
    _$insert(_el$16, () => `вых ${pct(share(values()[0]))}`);
    _$insertNode(_el$17, _$createTextNode(` · `));
    _$insert(_el$19, () => `вх ${pct(share(values()[1]))}`);
    _$insertNode(_el$20, _$createTextNode(` · `));
    _$insert(_el$22, () => `кэш ${pct(share(values()[2]))}`);
    _$effect(_p$ => {
      var _v$6 = {
          fg: props.theme.text.muted
        },
        _v$7 = {
          fg: props.theme.text.muted
        },
        _v$8 = {
          fg: colors()[0]
        },
        _v$9 = {
          fg: props.theme.text.muted
        },
        _v$0 = {
          fg: colors()[1]
        },
        _v$1 = {
          fg: props.theme.text.muted
        },
        _v$10 = {
          fg: colors()[2]
        };
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$1, "style", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$14, "style", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$16, "style", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$17, "style", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp(_el$19, "style", _v$0, _p$.i));
      _v$1 !== _p$.n && (_p$.n = _$setProp(_el$20, "style", _v$1, _p$.n));
      _v$10 !== _p$.s && (_p$.s = _$setProp(_el$22, "style", _v$10, _p$.s));
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
    return _el$9;
  })();
}
export function StatsSidebar(props) {
  const theme = () => props.ctx.theme;
  const [summary, setSummary] = createSignal();
  const [project, setProject] = createSignal();
  const [error, setError] = createSignal("");
  const [width, setWidth] = createSignal(DEFAULT_WIDTH);
  const [prices, setPrices] = createSignal(new Map());
  let alive = true;
  let request = 0;
  const session = () => {
    try {
      return props.ctx.data?.session?.get?.(props.sessionID);
    } catch {
      return undefined;
    }
  };
  async function load() {
    const id = ++request;
    const projectID = session()?.projectID;
    try {
      const [global, scoped] = await Promise.all([loadSidebarSummary(props.ctx.client, props.state.range, {
        previous: true
      }), projectID ? loadSidebarSummary(props.ctx.client, props.state.range, {
        project: projectID,
        previous: false
      }).catch(() => undefined) : Promise.resolve(undefined)]);
      if (!alive || id !== request) return;
      setSummary(global);
      setProject(scoped);
      setError("");
    } catch (cause) {
      if (!alive || id !== request) return;
      setError(cause?.message ?? String(cause));
    }
  }
  onCleanup(() => {
    alive = false;
    request += 1;
  });

  // Reload when the range or the session changes, and every minute otherwise.
  createEffect(() => {
    props.state.range;
    props.sessionID;
    session()?.projectID;
    void load();
  });
  onMount(() => {
    void loadPriceMap(props.ctx.client).then(value => {
      if (alive) setPrices(value);
    });
    const timer = setInterval(() => void load(), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  const sessionCost = () => Number(session()?.cost ?? 0);
  const sessionInput = () => Number(session()?.tokens?.input ?? 0);
  const sessionOutput = () => Number(session()?.tokens?.output ?? 0);
  const sessionCached = () => Number(session()?.tokens?.cache?.read ?? 0);
  const sessionCacheWrite = () => Number(session()?.tokens?.cache?.write ?? 0);
  const sessionCacheHit = () => {
    const read = sessionCached();
    const total = read + sessionInput() + sessionCacheWrite();
    return total > 0 ? read / total : 0;
  };
  const split = createMemo(() => sessionCostSplit(session(), prices()));
  const projectName = () => {
    try {
      const projectID = session()?.projectID;
      const value = projectID ? props.ctx.data?.project?.get?.(projectID) : undefined;
      return truncate(projectLabel(value ?? {
        canonical: session()?.directory
      }), 16);
    } catch {
      return "проект";
    }
  };
  const toolErrorRate = () => {
    const tools = summary()?.tools;
    return tools && tools.calls > 0 ? tools.failed / tools.calls : 0;
  };
  const spark = createMemo(() => sparkline(recentSteps(summary()?.activity ?? [], Math.max(8, Math.min(20, width() - 9)))));
  const costNote = () => {
    const previous = summary()?.previous?.cost;
    if (previous === undefined) return undefined;
    return delta(summary().cost, previous);
  };
  const costNoteColor = () => {
    const previous = summary()?.previous?.cost;
    if (previous === undefined) return theme().text.muted;
    return summary().cost <= previous ? theme().text.feedback.success.base : theme().text.feedback.warning.base;
  };
  const errorNoteColor = () => toolErrorRate() > 0.05 ? theme().text.feedback.error.base : theme().text.muted;
  function toggle() {
    void props.update(draft => {
      draft.open = !draft.open;
    });
  }
  function cycleRange() {
    void props.update(draft => {
      draft.range = nextRange(draft.range);
    });
  }
  return (() => {
    var _el$24 = _$createElement("box"),
      _el$25 = _$createElement("box"),
      _el$26 = _$createElement("text"),
      _el$27 = _$createElement("b"),
      _el$29 = _$createElement("text");
    _$insertNode(_el$24, _el$25);
    _$setProp(_el$24, "flexDirection", "column");
    _$setProp(_el$24, "onSizeChange", function () {
      const measured = this.width;
      if (measured > 0) queueMicrotask(() => setWidth(measured));
    });
    _$insertNode(_el$25, _el$26);
    _$insertNode(_el$25, _el$29);
    _$setProp(_el$25, "flexDirection", "row");
    _$setProp(_el$25, "flexShrink", 0);
    _$insertNode(_el$26, _el$27);
    _$setProp(_el$26, "wrapMode", "none");
    _$setProp(_el$26, "selectable", false);
    _$setProp(_el$26, "onMouseDown", toggle);
    _$insertNode(_el$27, _$createTextNode(`Статистика`));
    _$setProp(_el$29, "wrapMode", "none");
    _$setProp(_el$29, "selectable", false);
    _$setProp(_el$29, "onMouseDown", toggle);
    _$insert(_el$29, () => props.state.open ? " ▾" : " ▸");
    _$insert(_el$24, _$createComponent(Show, {
      get when() {
        return !props.state.open;
      },
      get children() {
        var _el$30 = _$createElement("text");
        _$setProp(_el$30, "wrapMode", "none");
        _$setProp(_el$30, "selectable", false);
        _$insert(_el$30, (() => {
          var _c$ = _$memo(() => !!summary());
          return () => _c$() ? `${usd(sessionCost())} сессия · ${usd(summary().cost)} ${rangeLabel(props.state.range)}` : "…";
        })());
        _$effect(_$p => _$setProp(_el$30, "fg", theme().text.muted, _$p));
        return _el$30;
      }
    }), null);
    _$insert(_el$24, _$createComponent(Show, {
      get when() {
        return props.state.open;
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return error();
          },
          get children() {
            var _el$31 = _$createElement("text");
            _$setProp(_el$31, "wrapMode", "word");
            _$setProp(_el$31, "selectable", false);
            _$insert(_el$31, () => `Статистика недоступна: ${error()}`);
            _$effect(_$p => _$setProp(_el$31, "fg", theme().text.feedback.error.base, _$p));
            return _el$31;
          }
        }), _$createComponent(Show, {
          get when() {
            return summary();
          },
          get fallback() {
            return (() => {
              var _el$37 = _$createElement("text");
              _$insertNode(_el$37, _$createTextNode(`Загрузка статистики…`));
              _$effect(_$p => _$setProp(_el$37, "fg", theme().text.muted, _$p));
              return _el$37;
            })();
          },
          get children() {
            return [_$createComponent(Header, {
              get theme() {
                return theme();
              },
              label: "\u0421\u0435\u0441\u0441\u0438\u044F",
              get color() {
                return theme().hue.accent[500];
              },
              get width() {
                return width();
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0420\u0430\u0441\u0445\u043E\u0434",
              get value() {
                return usd(sessionCost());
              },
              get color() {
                return theme().text.feedback.success.base;
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0412\u0445\u043E\u0434",
              get value() {
                return fmtTokens(sessionInput());
              },
              note: "\u043F\u043B\u0430\u0442\u043D\u043E"
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0412\u044B\u0445\u043E\u0434",
              get value() {
                return fmtTokens(sessionOutput());
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u041A\u044D\u0448",
              get value() {
                return fmtTokens(sessionCached());
              },
              get note() {
                return pct(sessionCacheHit());
              },
              get color() {
                return theme().hue.accent[500];
              }
            }), _$createComponent(CostBar, {
              get theme() {
                return theme();
              },
              get width() {
                return width();
              },
              get split() {
                return split();
              }
            }), _$createComponent(Show, {
              get when() {
                return project();
              },
              get children() {
                return [_$createComponent(Header, {
                  get theme() {
                    return theme();
                  },
                  label: "\u041F\u0440\u043E\u0435\u043A\u0442",
                  get color() {
                    return theme().text.feedback.warning.base;
                  },
                  get note() {
                    return projectName();
                  },
                  get width() {
                    return width();
                  }
                }), _$createComponent(Row, {
                  get theme() {
                    return theme();
                  },
                  label: "\u0420\u0430\u0441\u0445\u043E\u0434",
                  get value() {
                    return usd(project().cost);
                  },
                  get color() {
                    return theme().text.feedback.success.base;
                  }
                })];
              }
            }), _$createComponent(Header, {
              get theme() {
                return theme();
              },
              label: "\u041F\u0435\u0440\u0438\u043E\u0434",
              get color() {
                return theme().text.feedback.success.base;
              },
              get note() {
                return `${rangeLabel(props.state.range)} ↻`;
              },
              get noteColor() {
                return theme().text.action.primary.selected;
              },
              noteStyle: {
                bold: true,
                underline: true
              },
              get width() {
                return width();
              },
              onPress: cycleRange
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0420\u0430\u0441\u0445\u043E\u0434",
              get value() {
                return usd(summary().cost);
              },
              get note() {
                return costNote();
              },
              get noteColor() {
                return costNoteColor();
              },
              get color() {
                return theme().text.feedback.success.base;
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0422\u043E\u043A\u0435\u043D\u044B",
              get value() {
                return fmtTokens(totalTokens(summary().tokens));
              },
              get note() {
                return `кэш ${pct(summary().cacheHit)}`;
              },
              get color() {
                return theme().hue.accent[500];
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0412\u044B\u0437\u043E\u0432\u044B",
              get value() {
                return fmtTokens(summary().tools.calls);
              },
              get note() {
                return `${pct(toolErrorRate())} ош.`;
              },
              get noteColor() {
                return errorNoteColor();
              }
            }), _$createComponent(Row, {
              get theme() {
                return theme();
              },
              label: "\u0421\u0435\u0440\u0438\u044F",
              get value() {
                return `${summary().streak} дн.`;
              },
              get note() {
                return `${summary().sessions + summary().subagents} сессий`;
              }
            }), (() => {
              var _el$32 = _$createElement("text"),
                _el$33 = _$createElement("span"),
                _el$34 = _$createElement("span");
              _$insertNode(_el$32, _el$33);
              _$insertNode(_el$32, _el$34);
              _$setProp(_el$32, "wrapMode", "none");
              _$setProp(_el$32, "selectable", false);
              _$insert(_el$33, () => pad("Шаги", 8));
              _$insert(_el$34, () => spark() || "—");
              _$effect(_p$ => {
                var _v$11 = {
                    fg: theme().text.muted
                  },
                  _v$12 = {
                    fg: theme().hue.accent[500]
                  };
                _v$11 !== _p$.e && (_p$.e = _$setProp(_el$33, "style", _v$11, _p$.e));
                _v$12 !== _p$.t && (_p$.t = _$setProp(_el$34, "style", _v$12, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$32;
            })()];
          }
        }), (() => {
          var _el$35 = _$createElement("text");
          _$insertNode(_el$35, _$createTextNode(`открыть /oc_stats ↗`));
          _$setProp(_el$35, "wrapMode", "none");
          _$setProp(_el$35, "selectable", false);
          _$effect(_p$ => {
            var _v$13 = theme().text.action.primary.selected,
              _v$14 = props.openStats;
            _v$13 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$13, _p$.e));
            _v$14 !== _p$.t && (_p$.t = _$setProp(_el$35, "onMouseUp", _v$14, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$35;
        })()];
      }
    }), null);
    _$effect(_p$ => {
      var _v$15 = {
          fg: theme().hue.accent[500]
        },
        _v$16 = theme().text.muted;
      _v$15 !== _p$.e && (_p$.e = _$setProp(_el$27, "style", _v$15, _p$.e));
      _v$16 !== _p$.t && (_p$.t = _$setProp(_el$29, "fg", _v$16, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$24;
  })();
}