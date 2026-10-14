import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = fs.realpathSync(path.resolve(process.argv[2] ?? process.cwd()));
const port = Number(process.argv[3] ?? 8123);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const target = path.join(root, pathname);
  if (!target.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    console.log(`403 ${pathname}`);
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      console.log(`404 ${pathname}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
    console.log(`200 ${pathname} (${data.length}B)`);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`static server ready at http://127.0.0.1:${port}/ root=${root}`);
});
