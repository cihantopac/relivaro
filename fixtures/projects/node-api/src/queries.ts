import express from 'express';
import { pool } from './db';

const COLUMNS = ['id', 'name', 'email'];

export async function lockOrder(id: string, lock: boolean) {
  return pool.query(`SELECT * FROM orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
}

export async function appendFilter(params: unknown[], status: string) {
  return pool.query(`SELECT * FROM orders WHERE status = $${params.length + 1}`, [...params, status]);
}

export async function quotedColumns(id: string) {
  return pool.query(`SELECT ${['a', 'b'].map((c) => `"${c}"`).join(',')} FROM t WHERE id = $1`, [id]);
}

export async function listColumns(id: string) {
  return pool.query(`SELECT ${COLUMNS.map((c) => c).join(', ')} FROM users WHERE id = $1`, [id]);
}

export const queries = express.Router();
queries.get('/orders', async (req, res) => {
  const lock = req.query.lock === '1';
  const rows = await pool.query(`SELECT * FROM orders ${lock ? 'FOR UPDATE' : req.query.mode}`); // expect: sec/sql-injection
  res.json(rows.rows);
});
