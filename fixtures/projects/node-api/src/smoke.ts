import { pool } from './db';

export async function warmCaches() {
  for (const kind of ['a', 'b', 'c']) await pool.query('SELECT count(*) FROM items WHERE kind = $1', [kind]);
}

export async function touchKinds(ids: string[]) {
  for (const id of ids) {
    for (const kind of ['a', 'b']) await pool.query('SELECT 1 FROM items WHERE id = $1 AND kind = $2', [id, kind]); // expect: perf/query-in-loop
  }
}

export async function touchRows(rows: string[]) {
  for (const r of rows) await pool.query('UPDATE items SET seen = now() WHERE id = $1', [r]); // expect: perf/query-in-loop
}
