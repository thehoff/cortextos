// Deterministic dashboard renderer (Law 5): a JSON spec -> stat cards + an
// inline SVG bar chart. No charting library. Bars use the active theme's
// --chart-1..5 variables, so the chart follows whatever theme is loaded
// (base gold/blue/purple/…, or a brand override) — the brand adapts, not Scribe.
import { esc } from "./util.mjs";

/** spec: { title, chartTitle, stats:[{label,value,delta,tone}], series:[{label,value}] } */
export function renderDashboard(spec) {
  const stats = (spec.stats || []).map((s) => `
    <div class="card stat ${s.tone ? "tone-" + s.tone : ""}">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value">${esc(s.value)}</div>
      ${s.delta != null ? `<div class="stat-delta">${esc(s.delta)}</div>` : ""}
    </div>`).join("");

  const series = spec.series || [];
  const chart = series.length
    ? `<section class="card"><h3>${esc(spec.chartTitle || "Overview")}</h3>${barChart(series)}</section>`
    : "";

  return `<h1>${esc(spec.title || "Dashboard")}</h1>
${spec.subtitle ? `<p class="lead">${esc(spec.subtitle)}</p>` : ""}
<section class="stat-grid">${stats}</section>
${chart}`;
}

function barChart(series) {
  const max = Math.max(...series.map((s) => Number(s.value) || 0), 1);
  const W = 680, barH = 22, gap = 12, padL = 150, padR = 48;
  const H = series.length * (barH + gap) + gap;
  const rows = series.map((s, i) => {
    const y = gap + i * (barH + gap);
    const w = Math.round(((Number(s.value) || 0) / max) * (W - padL - padR));
    const c = `var(--chart-${(i % 5) + 1})`;
    return `<text x="${padL - 10}" y="${y + barH / 2 + 4}" text-anchor="end" class="bar-label">${esc(s.label)}</text>
<rect x="${padL}" y="${y}" width="${Math.max(w, 2)}" height="${barH}" rx="3" fill="${c}"></rect>
<text x="${padL + Math.max(w, 2) + 8}" y="${y + barH / 2 + 4}" class="bar-val">${esc(s.value)}</text>`;
  }).join("\n");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="bar chart">${rows}</svg>`;
}
