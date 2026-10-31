import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('public');

// Regression: path containment is checked before reading.
createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) return response.writeHead(403).end();
  response.end(await readFile(file));
}).listen(8080);
