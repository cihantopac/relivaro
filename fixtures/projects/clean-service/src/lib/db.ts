import { Pool } from 'pg';

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 5000 });

const SORTABLE = new Set(['created_at', 'name']);
const PAGE_SIZE = 50;

export async function listUsers(sort: string, page: number) {
  const column = SORTABLE.has(sort) ? sort : 'created_at';
  const offset = Number(page) * PAGE_SIZE;
  return pool.query(`SELECT id, name FROM users ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET $1`, [offset]).then((r) => ({ column, rows: r.rows }));
}
