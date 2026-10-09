import { ZipFile } from 'yazl';
import type { BrainService } from './service.js';
import type { Actor } from '../shared/contracts.js';
import { SafeZip, sha256, storedPath, storeAttachment } from './nsx.js';
import { stat } from 'node:fs/promises';
import { requireCondition } from './errors.js';

export async function backupStream(service: BrainService, actor: Actor) {
  const manifest = await service.exportData(actor, false);
  const hashes = [
    ...new Set(
      (manifest.data.source_attachments as { content_hash: string }[]).map(
        (att) => att.content_hash,
      ),
    ),
  ];
  const files = [];
  for (const digest of hashes) {
    const file = storedPath(service.storageRoot, digest, 'attachments');
    await stat(file);
    files.push({ file, digest });
  }
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'brain.json');
  for (const { file, digest } of files)
    zip.addFile(file, `attachments/${digest}`, { compress: false });
  zip.on('error', (error) => (zip.outputStream as import('node:stream').Readable).destroy(error));
  zip.end();
  return zip.outputStream;
}

export async function restoreBundle(service: BrainService, actor: Actor, file: string) {
  const { scope } = await import('./service.js');
  scope(actor, 'brain:admin');
  const occupied = (await service.db.query<{ n: number }>('SELECT count(*)::int AS n FROM nodes'))
    .rows[0].n;
  requireCondition(
    occupied === 0,
    409,
    'restore_not_empty',
    'Restore requires an empty workspace.',
  );
  const archive = await SafeZip.open(file);
  try {
    requireCondition(
      archive.entries.has('brain.json') &&
        [...archive.entries.keys()].every(
          (name) => name === 'brain.json' || /^attachments\/[a-f0-9]{64}$/.test(name),
        ),
      400,
      'invalid_backup',
      'Choose a Commonplace ZIP backup containing brain.json and attachments.',
    );
    const manifest = JSON.parse(
      (await archive.read('brain.json', 64 * 1024 * 1024)).toString('utf8'),
    );
    requireCondition(
      manifest?.format === 'commonplace-export' &&
        manifest.data &&
        [1, 2].includes(manifest.version),
      400,
      'invalid_backup',
      'Invalid backup manifest.',
    );
    const required = new Map<string, number>();
    for (const attachment of manifest.data.source_attachments || []) {
      requireCondition(
        /^[a-f0-9]{64}$/.test(attachment.content_hash) &&
          Number.isSafeInteger(Number(attachment.size)) &&
          Number(attachment.size) <= 64 * 1024 * 1024,
        400,
        'invalid_backup',
        'Invalid attachment metadata.',
      );
      required.set(attachment.content_hash, Number(attachment.size));
    }
    for (const [digest, size] of required) {
      const bytes = await archive.read(`attachments/${digest}`, 64 * 1024 * 1024);
      requireCondition(
        sha256(bytes) === digest && bytes.length === size,
        400,
        'invalid_backup',
        'An attachment in the backup failed its checksum/size check.',
      );
      await storeAttachment(service.storageRoot, bytes);
    }
    return await service.restoreData(actor, manifest);
  } finally {
    archive.close();
  }
}
