// Scribe build: walk a markdown source tree -> a served static site with two
// roots — /documentation/ (narrative theme) and /dashboard/ (dashboard theme).
// Brand comes from the Hoff theme package plus the local cortex-base fallback.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./render.mjs";
import { renderDashboard } from "./dashboard.mjs";
import { page } from "./page.mjs";
import { esc } from "./util.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scribeRoot = join(here, "..");

export async function build(srcDir, outDir, { theme = "cortex-base.css" } = {}) {
  if (!existsSync(srcDir)) throw new Error(`source not found: ${srcDir}`);
  for (const d of ["assets", "assets/themes", "documentation", "dashboard"]) {
    mkdirSync(join(outDir, d), { recursive: true });
  }

  // Layout + theme assets. Scribe copies theme files verbatim; cortex-base is
  // local, and the Hoff brand is sourced directly from the Hoff theme package.
  writeFileSync(join(outDir, "assets", "scribe.css"), readFileSync(join(scribeRoot, "assets", "scribe.css"), "utf-8"));
  const themesDir = join(scribeRoot, "assets", "themes");
  const hoffThemeCss = join(scribeRoot, "..", "..", "packages", "hoff-ui", "theme", "theme.css");
  const themeSources = [
    ["cortex-base.css", join(themesDir, "cortex-base.css")],
  ];
  if (existsSync(hoffThemeCss)) {
    themeSources.push(["hoff.css", hoffThemeCss]);
  } else {
    console.warn("scribe: hoff theme package not found, publishing cortex-base only");
  }
  for (const [fileName, sourcePath] of themeSources) {
    writeFileSync(join(outDir, "assets", "themes", fileName), readFileSync(sourcePath, "utf-8"));
  }
  const useMermaid = await vendorMermaid(join(outDir, "assets", "mermaid.min.js"));

  // Render docs.
  const mdFiles = walk(srcDir).filter((f) => extname(f) === ".md");
  const docs = mdFiles.map((f) => {
    const { html, title } = renderMarkdown(readFileSync(f, "utf-8"));
    return { slug: basename(f).replace(/\.md$/, ""), title, html };
  }).sort((a, b) => a.title.localeCompare(b.title));

  const nav = navHtml(docs);
  for (const d of docs) {
    writeFileSync(
      join(outDir, "documentation", `${d.slug}.html`),
      page({ title: d.title, body: d.html, themeFile: theme, dark: false, narrow: true, nav, prefix: "..", useMermaid }),
    );
  }

  // Dashboard (rendered in dark mode for the ops feel).
  const dash = loadDash(srcDir);
  writeFileSync(
    join(outDir, "dashboard", "index.html"),
    page({ title: dash.title || "Dashboard", body: renderDashboard(dash), themeFile: theme, dark: true, narrow: false, nav, prefix: "..", useMermaid: false }),
  );

  // Landing page.
  writeFileSync(join(outDir, "index.html"), landing(docs, theme));

  return { docs: docs.length, useMermaid, theme };
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function navHtml(docs) {
  const links = docs.map((d) => `<a href="../documentation/${d.slug}.html">${esc(d.title)}</a>`).join("");
  return `<a class="nav-brand" href="../index.html">myCortex</a>
<div class="nav-group"><div class="nav-head">Documentation</div>${links || '<span class="nav-empty">none</span>'}</div>
<div class="nav-group"><div class="nav-head">Ops</div><a href="../dashboard/index.html">Dashboard</a></div>`;
}

function loadDash(srcDir) {
  for (const cand of [join(srcDir, "dashboard.json"), join(scribeRoot, "examples", "dashboard.json")]) {
    if (existsSync(cand)) {
      try { return JSON.parse(readFileSync(cand, "utf-8")); } catch { /* ignore */ }
    }
  }
  return { title: "Dashboard", subtitle: "No dashboard.json found — showing a placeholder.", stats: [], series: [] };
}

function landing(docs, theme) {
  const items = docs.map((d) => `<li><a href="documentation/${d.slug}.html">${esc(d.title)}</a></li>`).join("");
  const body = `<h1>myCortex</h1>
<p class="lead">Branded HTML for everything we produce — rendered by Scribe, no daemon required.</p>
<section class="card"><h3>Documentation</h3><ul class="doc-list">${items}</ul></section>
<section class="card"><h3>Ops</h3><p><a href="dashboard/index.html">Dashboard &rarr;</a></p></section>`;
  return page({ title: "myCortex", body, themeFile: theme, dark: false, narrow: true, nav: navHtml(docs).replace(/\.\.\//g, ""), prefix: ".", useMermaid: false });
}

async function vendorMermaid(dest) {
  if (existsSync(dest) && statSync(dest).size > 1000) return true; // already vendored
  try {
    const res = await fetch("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js");
    if (!res.ok) return false;
    writeFileSync(dest, await res.text());
    return true;
  } catch {
    return false; // offline -> mermaid blocks degrade to preformatted text
  }
}
