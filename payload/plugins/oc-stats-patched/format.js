/** Small display helpers shared by the stats views. */

export function usd(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  if (abs === 0) return "$0.00";
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 10) return `$${value.toFixed(2)}`;
  if (abs < 1000) return `$${value.toFixed(1)}`;
  return `$${Math.round(value).toLocaleString("ru-RU")}`;
}
export function tokens(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}млрд`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}млн`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}тыс`;
  return String(Math.round(value));
}

/** Milliseconds as a compact duration: 850ms, 3.2s, 1m 12s, 1h 4m. */
export function duration(value) {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}мс`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}с`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}м ${rest}с`;
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${minutes % 60}м`;
}
export function date(value) {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleDateString("ru-RU", {
    month: "short",
    day: "numeric"
  });
}
export function dateTime(value) {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return "—";
  return new Date(value).toLocaleString("ru-RU", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
export function pct(value) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}
export function pad(text, width) {
  if (text.length >= width) return text.slice(0, width);
  return text + " ".repeat(width - text.length);
}
export function truncate(text, width) {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return "…";
  return text.slice(0, width - 1) + "…";
}
export function delta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "—";
  const now = Number(current);
  const before = Number(previous);
  if (before === 0) return now === 0 ? "0%" : "нов.";
  const change = (now - before) / before;
  const sign = change > 0 ? "+" : "";
  return `${sign}${(change * 100).toFixed(0)}%`;
}
export function shortModel(model) {
  if (!model) return "—";
  const provider = model.providerID ?? "";
  const id = model.modelID ?? model.id ?? "";
  if (!id) return provider || "—";
  return provider ? `${provider}/${id}` : id;
}