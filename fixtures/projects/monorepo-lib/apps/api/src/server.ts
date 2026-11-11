import express from 'express';

const app = express();
app.get('/v1/health', (_req, res) => res.json({ ok: true }));
const server = app.listen(3000);
process.on('SIGTERM', () => server.close());
