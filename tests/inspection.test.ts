import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../server/db.js';

const execute = promisify(execFile);

it('inspects a separate copy, rejects unacknowledged access and write-through SQL, and preserves the original', async () => {
  const directory = await mkdtemp(path.resolve('.data/inspection-test-'));
  const database = path.join(directory, 'postgres');
  const db = await openDatabase(directory);
  await db.exec(
    "CREATE TABLE inspection_fixture(value text); INSERT INTO inspection_fixture VALUES ('original')",
  );
  await db.close();
  const run = (args: string[]) =>
    execute(process.execPath, ['--import', 'tsx', 'scripts/inspect-db.ts', database, ...args], {
      timeout: 30000,
    });
  await expect(run([])).rejects.toMatchObject({ code: 1 });
  const summary = await run(['--stopped']);
  expect(summary.stdout).toContain('Inspection copy:');
  expect(summary.stdout).toContain('postgres-inspect-');
  expect(summary.stdout).toContain('search_documents');
  const query = path.join(directory, 'query.sql');
  await writeFile(query, 'SELECT value FROM inspection_fixture');
  expect((await run(['--stopped', `--sql-file=${query}`])).stdout).toContain('original');
  await writeFile(
    query,
    'WITH changed AS (DELETE FROM inspection_fixture RETURNING *) SELECT * FROM changed',
  );
  await expect(run(['--stopped', `--sql-file=${query}`])).rejects.toMatchObject({
    stderr: expect.stringContaining('read-only transaction'),
  });
  const original = await openDatabase(directory);
  try {
    expect((await original.query('SELECT value FROM inspection_fixture')).rows).toEqual([
      { value: 'original' },
    ]);
  } finally {
    await original.close();
  }
}, 90000);
