import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit.js';
import { listFixtures, materialize, ROOT } from '../helpers/fixtures.js';
import { type Schema, validate } from '../helpers/schema.js';

const schema = (): Schema => JSON.parse(readFileSync(join(ROOT, 'schemas', 'run.schema.json'), 'utf8'));

describe('schema validator', () => {
  it('reports type, required, enum and additional-property violations', () => {
    const s: Schema = {
      type: 'object',
      required: ['a'],
      additionalProperties: false,
      properties: { a: { type: 'string', enum: ['x'] }, b: { $ref: '#/$defs/n' } },
      $defs: { n: { type: 'integer', minimum: 0 } },
    };
    expect(validate({ a: 'x', b: 1 }, s)).toEqual([]);
    expect(validate({ a: 'y', b: -1, c: 1 }, s)).toEqual([
      '$.a: "y" not in enum',
      '$.b: -1 < minimum 0',
      '$.c: additional property not allowed',
    ]);
    expect(validate({}, s)).toEqual(['$: missing required "a"']);
  });
});

describe('run record schema', () => {
  for (const name of listFixtures())
    it(`${name}: run.json validates against schemas/run.schema.json`, async () => {
      const fx = materialize(name);
      try {
        const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
        expect(run.$schema).toBe(
          'https://raw.githubusercontent.com/cihantopac/relivaro/main/schemas/run.schema.json',
        );
        expect(validate(JSON.parse(JSON.stringify(run)), schema())).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });

  it('a release run (with the release assessment) validates', async () => {
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({ root: fx.dir, command: 'release', noWrite: true, release: true });
      expect(validate(JSON.parse(JSON.stringify(run)), schema())).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
