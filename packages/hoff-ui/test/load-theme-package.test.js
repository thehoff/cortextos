import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import theming from "../../../src/theming/index.ts";

const { loadThemePackageFromSpecifier } = theming;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("loadThemePackageFromSpecifier resolves the hoff theme package by repo-relative path", () => {
  const theme = loadThemePackageFromSpecifier("packages/hoff-ui/theme", repoRoot);
  assert.ok(theme, "expected theme package to resolve");
  assert.equal(theme.id, "hoff");
  assert.equal(theme.name, "Hoff");
  assert.equal(theme.themeDir, join(repoRoot, "packages/hoff-ui/theme"));
  assert.equal(theme.themeJsonPath, join(repoRoot, "packages/hoff-ui/theme/theme.json"));
  assert.equal(theme.themeCssPath, join(repoRoot, "packages/hoff-ui/theme/theme.css"));
  assert.equal(theme.light["--primary"], "#ff2e88");
});
