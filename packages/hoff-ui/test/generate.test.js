// Contract test for the hoff theme package (node --test).
// Proves the generator is deterministic and that the package manifest still
// emits the expected Hoff palette into the shared shadcn token contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../generate.mjs";
import { readFileSync } from "node:fs";
import { buildThemeCss, loadThemeManifest } from "../../../scripts/build-theme.mjs";

test("generator validates and rewrites the hoff theme css", () => {
  const out = generate();
  assert.equal(out.manifest.id, "hoff");
  assert.equal(out.manifest.name, "Hoff");
  assert.ok(out.themeJsonPath.endsWith("packages/hoff-ui/theme/theme.json"));
  assert.ok(out.themeCssPath.endsWith("packages/hoff-ui/theme/theme.css"));
  assert.equal(readFileSync(out.themeCssPath, "utf-8"), out.css);
  assert.equal(out.css, buildThemeCss(out.manifest));
});

test("generator is deterministic", () => {
  const first = generate();
  const second = generate();
  assert.deepEqual(second.manifest, first.manifest);
  assert.equal(second.css, first.css);
});

test("theme manifest round-trips through the framework loader", () => {
  const out = generate();
  const manifest = loadThemeManifest(out.themeJsonPath);
  assert.ok(manifest);
  assert.equal(manifest.id, "hoff");
  assert.equal(manifest.light["--primary"], "#ff2e88");
  assert.equal(manifest.dark["--background"], "#0c0b10");
});
