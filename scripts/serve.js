// Serves files from the given directory with CORS headers, so web players such
// as TurboWarp can load a local .sb3 via ?project_url=http://localhost:PORT/file.sb3
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.env.PORT || process.argv[3] || 8765);
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
