/**
 * Pre-hydration bootstrap script — runs synchronously before React hydration
 * and before paint. Applies user preferences saved in localStorage so the
 * first paint matches the saved state (no flash-of-default).
 *
 * Today it owns two things:
 *   - `ctx-density` → `<html data-density="compact|comfortable">`
 *   - `ctx-theme-bootstrap` → `<style id="ctx-theme-package-css">` (server-
 *      resolved theme package CSS, serialized by layout.tsx)
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

    var density = localStorage.getItem('ctx-density');
    if (density === 'compact' || density === 'comfortable') {
      d.dataset.density = density;
    }

    var bootstrap = document.getElementById('ctx-theme-bootstrap');
    if (bootstrap && bootstrap.textContent) {
      var payload = JSON.parse(bootstrap.textContent);
      if (payload && typeof payload.css === 'string' && payload.css.length < 32768) {
        var styleEl = document.getElementById('ctx-theme-package-css');
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ctx-theme-package-css';
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = payload.css;
      }
    }
  } catch (error) {
    // Ignore storage / JSON / DOM errors to avoid blocking hydration.
  }
})();
`;
