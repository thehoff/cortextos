// HTML shell. Loads a theme stylesheet (the shadcn contract) + scribe layout.
// Theme is chosen by file; light/dark via the `.dark` class (base convention).
import { esc } from "./util.mjs";

export function page({ title, body, themeFile = "cortex-base.css", dark = false, narrow = false, nav = "", prefix = ".", useMermaid = false }) {
  const htmlClass = dark ? ' class="dark"' : "";
  const mermaid = useMermaid
    ? `<script src="${prefix}/assets/mermaid.min.js"></script>
<script>if(window.mermaid){window.mermaid.initialize({startOnLoad:true,theme:${dark ? "'dark'" : "'default'"},securityLevel:'loose'});}</script>`
    : "";
  return `<!doctype html>
<html lang="en"${htmlClass}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${prefix}/assets/themes/${themeFile}">
<link rel="stylesheet" href="${prefix}/assets/scribe.css">
</head>
<body>
<div class="shell">
<aside class="nav">${nav}</aside>
<main class="main${narrow ? " narrow" : ""}">${body}</main>
</div>
${mermaid}
</body>
</html>`;
}
