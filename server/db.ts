import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFile } from 'node:fs/promises';

export type DB = PGlite;
export type QueryDB = Pick<PGlite, 'query' | 'exec'>;
export async function openDatabase(dataDir?: string) {
  const db = new PGlite(dataDir ? `${dataDir}/postgres` : 'memory://', { extensions: { vector } });
  await db.waitReady;
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}
export async function rows<T>(db: QueryDB, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
export async function one<T>(
  db: QueryDB,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  return (await rows<T>(db, sql, params))[0];
}
