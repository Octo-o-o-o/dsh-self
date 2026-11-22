import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const distDir = path.join(root, 'dist');
const port = Number.parseInt(process.env.PORT ?? '4173', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let filePath = path.join(distDir, rel.slice(1));
  if (!path.extname(filePath) && !rel.endsWith('/')) {
    filePath = `${filePath}.html`;
  }
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) filePath = path.join(filePath, 'index.html');
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    const fallback = rel.startsWith('/en/') ? path.join(distDir, 'en', '404.html') : path.join(distDir, '404.html');
    try {
      const body = await readFile(fallback);
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dsh-self website preview: http://127.0.0.1:${port}/`);
});
