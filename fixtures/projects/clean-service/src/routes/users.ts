import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { listUsers, pool } from '../lib/db';

export const router = Router();
const UPLOADS = path.resolve('uploads');
const CreateUser = z.object({ name: z.string().min(1), email: z.string().email() });

router.get('/users', async (req, res, next) => {
  try {
    res.json(await listUsers(String(req.query.sort ?? ''), Number(req.query.page ?? 0)));
  } catch (err) {
    next(err);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const input = CreateUser.parse(req.body);
    const { rows } = await pool.query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id', [input.name, input.email]);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/files/:name', async (req, res, next) => {
  try {
    const file = path.join(UPLOADS, path.basename(req.params.name));
    res.send(await readFile(file));
  } catch (err) {
    next(err);
  }
});

router.get('/next', (req, res) => {
  const target = String(req.query.to ?? '/');
  res.redirect(target.startsWith('/') && !target.startsWith('//') ? target : '/');
});

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});
