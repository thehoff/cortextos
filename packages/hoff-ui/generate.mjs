#!/usr/bin/env node
// hoff-ui theme package generator.
//
// This package is now a thin overlay on the shared theming framework:
// validate packages/hoff-ui/theme/theme.json and regenerate theme/theme.css.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildThemePackage } from "../../scripts/build-theme.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf-8");
const readBuildConfig = () => JSON.parse(read("branding.json"));

function resolveThemeDir() {
  const config = readBuildConfig();
  const theme = typeof config.theme === "string" && config.theme.trim() ? config.theme.trim() : "theme";
  return resolve(root, theme);
}

/** Validate the manifest and regenerate theme/theme.css. */
export function generate() {
  const themeDir = resolveThemeDir();
  return buildThemePackage(themeDir);
}

// Run directly: node generate.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = generate();
  console.log(`hoff-ui: validated ${result.themeJsonPath} and regenerated ${result.themeCssPath}`);
}
