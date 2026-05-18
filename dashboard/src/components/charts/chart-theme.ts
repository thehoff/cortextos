/**
 * cortextOS Dashboard - Chart theme configuration.
 * Gold/mustard palette for all Recharts components.
 *
 * These hex values mirror the OKLCh tokens in `dashboard/src/app/globals.css`
 * (`--chart-1` … `--chart-5`). Recharts SVG props can't resolve `var(--chart-N)`
 * directly, so we keep static hex here as a transit layer between globals.css
 * and the chart components. Issue #13 + a future PR will move charts to a
 * runtime `getComputedStyle()` lookup so this file becomes derived rather
 * than authored. Until then: if you edit globals.css, edit the matching value
 * here too.
 *
 * Source-of-truth mapping:
 *   --chart-1: oklch(0.762 0.125 82)  → #D4AF37 (gold, matches --accent light)
 *   --chart-2: oklch(0.546 0.2 262)   → #2563EB (blue)
 *   --chart-3: oklch(0.507 0.22 293)  → #7C3AED (purple)
 *   --chart-4: oklch(0.543 0.22 340)  → #DB2777 (pink)
 *   --chart-5: oklch(0.555 0.17 160)  → #059669 (green)
 *
 * `CHART_GOLD` was previously `#D4A017` (drift); aligned to `#D4AF37` to
 * match `--chart-1` and `--accent`. The extra orange in `CHART_COLORS` is
 * a non-token fallback for the 6th series — not in globals.css.
 */

// -- Color palette --

export const CHART_GOLD = '#D4AF37';
export const CHART_GOLD_LIGHT = '#F5D76E';
export const CHART_GOLD_DARK = '#A67C00';
export const CHART_GOLD_MUTED = 'rgba(212, 175, 55, 0.15)';

export const CHART_COLORS = [
  '#D4AF37', // gold     (matches globals.css --chart-1)
  '#2563EB', // blue     (matches globals.css --chart-2)
  '#7C3AED', // purple   (matches globals.css --chart-3)
  '#DB2777', // pink     (matches globals.css --chart-4)
  '#059669', // green    (matches globals.css --chart-5)
  '#EA580C', // orange   (extra 6th series; not a globals.css token)
] as const;

// -- Model-specific colors (for cost charts) --

export const MODEL_COLORS: Record<string, string> = {
  opus: '#D4A017',
  sonnet: '#2563EB',
  haiku: '#7C3AED',
};

// -- Severity colors --

export const SEVERITY_COLORS: Record<string, string> = {
  info: '#2563EB',
  warning: '#D4A017',
  error: '#EF4444',
};

// -- Recharts default props --

export const AXIS_STYLE = {
  fontSize: 11,
  fill: 'hsl(var(--muted-foreground))',
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_STYLE = {
  strokeDasharray: '3 3',
  stroke: 'hsl(var(--border))',
  strokeOpacity: 0.5,
} as const;

export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderRadius: 8,
    fontSize: 12,
    padding: '8px 12px',
    color: 'hsl(var(--foreground))',
  },
  labelStyle: {
    color: 'hsl(var(--foreground))',
    fontSize: 11,
    fontWeight: 500,
    marginBottom: 4,
  },
  itemStyle: {
    color: 'hsl(var(--foreground))',
  },
} as const;

// -- Helper functions --

/** Get a color by index, cycling through CHART_COLORS */
export function getChartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

/** Get a model color with fallback */
export function getModelColor(model: string): string {
  const key = model.toLowerCase();
  for (const [name, color] of Object.entries(MODEL_COLORS)) {
    if (key.includes(name)) return color;
  }
  return CHART_COLORS[0];
}

/** Generate a gradient ID for an area chart */
export function gradientId(prefix: string, index: number = 0): string {
  return `${prefix}-gradient-${index}`;
}
