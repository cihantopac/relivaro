import * as Sentry from '@sentry/node';
import express from 'express';
import { router } from './routes/users';

Sentry.init({ dsn: process.env.SENTRY_DSN });
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(router);

const server = app.listen(Number(process.env.PORT ?? 3000));

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
