import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { cp, mkdtemp, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../server/config.js';

const args = process.argv.slice(2);
const source = path.resolve(
  args.find((argument) => !argument.startsWith('--')) || path.join(config.dataDir, 'postgres'),
);
const sqlArgument = args.find((argument) => argument.startsWith('--sql-file='));
if (!args.includes('--stopped')) {
  console.error(
    'Stop the API/container first, then run db:inspect -- --stopped [database-directory] [--sql-file=queries.sql]. This command copies the stopped database and only queries that copy.',
  );
  process.exitCode = 1;
} else {
  if (!(await stat(path.join(source, 'PG_VERSION')).catch(() => null))?.isFile())
    throw new Error('That directory does not contain an existing PGlite database.');
  const directory = await mkdtemp(path.join(path.dirname(source), 'postgres-inspect-'));
  const target = path.join(directory, 'postgres');
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  console.log(`Inspection copy: ${target}`);
  const db = new PGlite(target, { extensions: { vector } });
  try {
    await db.waitReady;
    // Apply read-only mode to every subsequent transaction, including custom SQL.
    await db.exec('SET default_transaction_read_only = on');
    await db.exec('BEGIN READ ONLY');
    await db.exec("SET LOCAL statement_timeout = '10s'");
    if (sqlArgument) {
      const sql = await readFile(path.resolve(sqlArgument.slice('--sql-file='.length)), 'utf8');
      if (
        !/^\s*(SELECT|WITH|EXPLAIN|SHOW)\b/i.test(sql) ||
        /;\s*\S/.test(sql.trim().replace(/;$/, ''))
      )
        throw new Error('Supply one read-only SELECT, WITH, EXPLAIN, or SHOW statement.');
      console.table((await db.query(sql)).rows);
    } else {
      console.table(
        (
          await db.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
          )
        ).rows,
      );
      console.table(
        (
          await db.query(
            "SELECT 'knowledge' AS collection,count(*) AS records FROM knowledge UNION ALL SELECT 'sources',count(*) FROM sources UNION ALL SELECT 'passages',count(*) FROM passages UNION ALL SELECT 'relations',count(*) FROM relations UNION ALL SELECT 'search_documents',count(*) FROM search_documents",
          )
        ).rows,
      );
    }
    await db.exec('ROLLBACK');
  } finally {
    await db.close();
  }
}
