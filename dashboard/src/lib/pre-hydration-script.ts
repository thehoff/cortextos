/**
 * Pre-hydration bootstrap script — runs synchronously before React hydration
 * and before paint. Applies user preferences saved in localStorage so the
 * first paint matches the saved state (no flash-of-default).
 *
 * Today it owns two things:
 *   - `ctx-density` → `<html data-density="compact|comfortable">`
 *   - `ctx-org-theme-css` → `<style id="ctx-org-theme-override">` (per-org
 *      brand color overrides — feeder lands in #9; the slot exists today)
 *
 * next-themes ships its own pre-hydration script for the light/dark class —
 * this script is additive, not a replacement. Both run before paint.
 *
 * The script is plain ES5 (no const / arrow / optional chaining) so it
 * works without transpilation when inlined via `<script dangerouslySetInnerHTML>`.
 */

export const PRE_HYDRATION_SCRIPT = `
(function () {
  try {
    var d = document.documentElement;

    // Density (consumed by #14 once spacing is migrated to --density-scale).
    var density = localStorage.getItem('ctx-density');
    if (density === 'compact' || density === 'comfortable') {
      d.dataset.density = density;
    }

    // Per-org theme CSS (feeder lands in #9). The slot exists so the
    // contract is testable end-to-end without #9 yet shipping.
    var themeCss = localStorage.getItem('ctx-org-theme-css');
    if (themeCss && typeof themeCss === 'string' && themeCss.length < 8192) {
      var styleEl = document.getElementById('ctx-org-theme-override');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'ctx-org-theme-override';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = themeCss;
    }
  } catch (e) { /* swallow — never block paint on a preferences read */ }
})();
`;
