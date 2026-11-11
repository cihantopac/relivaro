import { describe, expect, it } from 'vitest';
import { pool } from '../src/db';
import { logger } from '../src/logger';

describe('log redaction', () => {
  it('redacts the authorization header', async () => {
    const lines: string[] = [];
    logger.on('line', (l: string) => lines.push(l));
    logger.info({ headers: { authorization: 'Bearer x' } });
    expect(lines.join('\n')).not.toContain('Bearer x');
  });

  it('reads each seeded row', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
    for (const id of ids) await pool.query('select 1 where id=$1', [id]);
  });
});
