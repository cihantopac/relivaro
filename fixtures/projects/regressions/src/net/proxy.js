import http from 'node:http';

export function startProxy(allowed) {
  return http.createServer((req, res) => {
    // Regression: the target passes through an allowlist function before use.
    const u = req.url && /^http:\/\//i.test(req.url) ? allowed(req.url) : null;
    if (!u) return res.writeHead(403).end();
    const upstream = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: req.method, timeout: 5000 });
    req.pipe(upstream);
  });
}

export function token(req, expected) {
  return req.headers['x-admin-token'] !== expected; // expect: sec/timing-unsafe-comparison
}
