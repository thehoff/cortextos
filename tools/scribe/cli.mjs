#!/usr/bin/env node
// Scribe CLI — manual markdown -> branded HTML publisher.
//   scribe build <srcDir> [--out <dir>]     render a markdown tree to a static site
//   scribe serve [<dir>] [--port <n>]       serve a built site
import { build } from "./src/build.mjs";
import { serve } from "./src/serve.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
function firstPositional(from = 1) {
  for (let i = from; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { i++; continue; }
    return argv[i];
  }
  return undefined;
}

const HELP = `Scribe — markdown -> hoff-ui branded HTML (manual tier).

Usage:
  scribe build <srcDir> [--out <dir>]   Render a markdown tree to /documentation + /dashboard
  scribe serve [<dir>] [--port <n>]     Serve a built site (default ./public :4321)

Examples:
  node cli.mjs build ../../docs --out ./public
  node cli.mjs serve ./public --port 4321`;

try {
  if (cmd === "build") {
    const src = firstPositional(1);
    if (!src) { console.error("build: missing <srcDir>\n\n" + HELP); process.exit(2); }
    const out = flag("out", "./public");
    let theme = flag("theme", "cortex-base.css");
    if (!theme.endsWith(".css")) theme += ".css";
    const res = await build(src, out, { theme });
    console.log(`scribe: built ${res.docs} doc(s) -> ${out}  (theme: ${res.theme}, mermaid: ${res.useMermaid ? "vendored" : "offline/skipped"})`);
  } else if (cmd === "serve") {
    const dir = firstPositional(1) || "./public";
    serve(dir, Number(flag("port", "4321")));
  } else {
    console.log(HELP);
    process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  console.error(`scribe: ${err.message}`);
  process.exit(1);
}
