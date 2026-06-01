// Tiny static file server (Law 5: Node, zero deps). `scribe serve <dir>`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export function serve(rootDir, port = 4321) {
  const server = createServer(async (req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath.endsWith("/")) urlPath += "index.html";
      // contain within rootDir
      const filePath = normalize(join(rootDir, urlPath));
      if (!filePath.startsWith(normalize(rootDir))) { res.writeHead(403).end("forbidden"); return; }
      const info = await stat(filePath).catch(() => null);
      const target = info && info.isDirectory() ? join(filePath, "index.html") : filePath;
      const data = await readFile(target);
      res.writeHead(200, {
        "content-type": TYPES[extname(target)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>");
    }
  });
  server.listen(port, () => {
    console.log(`scribe: serving ${rootDir} at http://localhost:${port}`);
  });
  return server;
}
