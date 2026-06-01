// Collision / contract test for the hoff-ui BrandPack (node --test).
// Proves the generator is deterministic and that the two themes carry the
// correct, distinct signal palettes onto the SAME token names (--accent etc.)
// so a consumer switches brand by flipping data-theme, with no clash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../generate.mjs";

test("generator emits all four artifacts", () => {
  const out = generate();
  for (const k of ["brand.css", "brand.mjs", "brand.manifest.json", "chart-palette.json"]) {
    assert.ok(out[k] && out[k].length > 0, `missing ${k}`);
  }
});

test("generator is deterministic", () => {
  assert.deepEqual(generate(), generate());
});

test("brand.css carries both themes on the same --accent token (no clash)", () => {
  const css = generate()["brand.css"];
  // narrative pink under data-theme="narrative"
  assert.match(css, /\[data-theme="narrative"\][\s\S]*?--accent:\s*#ff2e88/);
  // dashboard mint under data-theme="dashboard"
  assert.match(css, /\[data-theme="dashboard"\][\s\S]*?--accent:\s*#7fd3a6/);
});

test("manifest exposes the semantic contract consumers depend on", () => {
  const m = JSON.parse(generate()["brand.manifest.json"]);
  assert.equal(m.id, "hoff");
  assert.equal(m.defaultTheme, "narrative");
  assert.ok(m.themes.narrative && m.themes.dashboard);
  assert.equal(m.themes.narrative.palette.accent, "#ff2e88");
  assert.equal(m.themes.dashboard.palette.accent, "#7fd3a6");
  assert.ok(Array.isArray(m.chartPalette) && m.chartPalette.length >= 5);
});
