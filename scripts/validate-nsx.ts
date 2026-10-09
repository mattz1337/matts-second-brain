import { randomUUID } from 'node:crypto';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { storedPath } from '../server/nsx.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: npm run nsx:validate -- path/to/export.nsx');
const root = path.resolve(`.data/nsx-validation-${Date.now()}`);
await mkdir(path.join(root, 'files', 'incoming'), { recursive: true });
const db = await openDatabase(root);
const service = new BrainService(db, undefined, path.join(root, 'files'));
const started = Date.now();
try {
  const storageKey = randomUUID();
  await copyFile(path.resolve(file), storedPath(service.storageRoot, storageKey, 'incoming'));
  const upload = await service.uploadDisk(
    owner,
    storageKey,
    path.basename(file),
    'application/octet-stream',
  );
  const job = await service.importSource(owner, {
    title: 'NSX migration validation',
    upload_id: upload.id,
    note_station: { extract_claims: false },
    idempotency_key: randomUUID(),
  });
  const timer = setInterval(() => {
    void service.getJob(owner, job.id).then((current) =>
      console.log(
        JSON.stringify({
          status: current.status,
          progress: current.progress,
          imported: current.result.imported,
        }),
      ),
    );
  }, 15000);
  try {
    await service.processNextJob();
  } finally {
    clearInterval(timer);
  }
  const completed = await service.getJob(owner, job.id);
  if (completed.status !== 'completed') throw new Error(completed.error || 'Migration failed.');
  const count = async (table: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  console.log(
    JSON.stringify(
      {
        validation_directory: root,
        elapsed_seconds: Math.round((Date.now() - started) / 1000),
        imported_sources: await count('sources'),
        retained_attachments: await count('source_attachments'),
        indexed_passages: await count('passages'),
        claims: await count('knowledge'),
        missing_or_empty_warnings: completed.warnings.length,
        skipped: completed.result.skipped,
      },
      null,
      2,
    ),
  );
} finally {
  await db.close();
}
