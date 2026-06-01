// Markdown -> HTML fragment. Deterministic (Law 5): markdown-it + highlight.js,
// no AI. ```mermaid fences become <pre class="mermaid"> for client-side render.
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import hljs from "highlight.js";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(str, lang) {
    if (lang && lang !== "mermaid" && hljs.getLanguage(lang)) {
      try {
        return `<pre class="code"><code class="hljs language-${lang}">${
          hljs.highlight(str, { language: lang }).value
        }</code></pre>`;
      } catch { /* fall through */ }
    }
    return `<pre class="code"><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

md.use(anchor, { permalink: anchor.permalink.headerLink() });

// Intercept mermaid fences before they reach the highlighter.
const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info || "").trim();
  if (info === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(tokens[idx].content)}</pre>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

/** Render markdown source -> { html, title }. Title = first H1, else "Untitled". */
export function renderMarkdown(src) {
  const html = md.render(src);
  const m = src.match(/^#\s+(.+?)\s*$/m);
  const title = m ? m[1].replace(/[*_`]/g, "").trim() : "Untitled";
  return { html, title };
}
