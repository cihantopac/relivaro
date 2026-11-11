import type { Express } from 'express';

export function mount(app: Express, path: string) {
  app.get(path, (_req, res) => res.json({ ok: true }));
}
