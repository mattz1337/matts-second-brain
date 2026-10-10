import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import request from 'supertest';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { NsxArchive, SafeZip, storedPath, storeAttachment } from '../server/nsx.js';
import { createApp } from '../server/app.js';
import { backupStream, restoreBundle } from '../server/backup.js';
import { nsxFixture, zipBytes, media } from './fixtures/nsx.js';

let db: DB;
let service: BrainService;
let root: string;
const fixtureFile = async (bytes: Buffer) => {
  const file = path.join(root, `${randomUUID()}.nsx`);
  await writeFile(file, bytes);
  return file;
};
const importArchive = async (bytes: Buffer, options = {}) => {
  const upload = await service.upload(owner, bytes, 'migration.nsx', 'application/octet-stream');
  const job = await service.importSource(owner, {
    title: 'Note Station migration',
    upload_id: upload.id,
    note_station: { extract_claims: false, ...options },
    idempotency_key: randomUUID(),
  });
  await service.processNextJob();
  const completed = await service.getJob(owner, job.id);
  expect(completed.status, completed.error || '').toBe('completed');
  return completed;
};
beforeAll(async () => {
  root = path.resolve(`.data/nsx-tests-${Date.now()}`);
  await mkdir(root, { recursive: true });
  db = await openDatabase();
});
beforeEach(async () => {
  await db.exec(
    'TRUNCATE nodes CASCADE; TRUNCATE jobs,uploads,idempotency,activity,tombstones,preferences;',
  );
  service = new BrainService(db, undefined, path.join(root, randomUUID()));
});
afterAll(async () => db.close());

describe('Note Station migration', () => {
  it('previews notebook counts and parses Unicode, timestamps, tags and links without executing HTML', async () => {
    const archive = await NsxArchive.open(await fixtureFile(await nsxFixture()));
    try {
      const preview = await archive.preview();
      expect(preview).toMatchObject({
        notes: 2,
        attachments: 2,
        missing_attachments: 0,
        unreadable_notes: 0,
      });
      expect(preview.notebooks.map((book) => [book.title, book.notes])).toEqual([
        ['Labor', 1],
        ['Personal', 1],
      ]);
      const note = await archive.note('note-a');
      expect(note.text).toContain('https://example.com/lab');
      expect(note.text).not.toContain('Never execute');
      expect(note.metadata).toMatchObject({
        notebook: 'Labor',
        stack: 'Research',
        original_tags: ['Workshop', 'Material'],
        created_at: '2023-11-14T22:13:20.000Z',
      });
    } finally {
      archive.close();
    }
  });
  it('reports missing media, encrypted content, and malformed notes explicitly', async () => {
    const archive = await NsxArchive.open(
      await fixtureFile(await nsxFixture({ missing: true, encrypted: true, malformed: true })),
    );
    try {
      const preview = await archive.preview();
      expect(preview.missing_attachments).toBe(1);
      expect(preview.unreadable_notes).toBe(2);
      expect(preview.warnings).toHaveLength(3);
    } finally {
      archive.close();
    }
    const job = await importArchive(
      await nsxFixture({ missing: true, encrypted: true, malformed: true }),
    );
    expect(job.result).toMatchObject({ imported: 1, skipped: 1, claims: 0, attachments: 0 });
    expect(job.warnings.join(' ')).toContain('Encrypted note');
  });
  it('imports selected notebooks, indexes full notes, retains media, and proposes no claims by default', async () => {
    const job = await importArchive(await nsxFixture(), { notebook_ids: ['book-a'] });
    expect(job.result).toMatchObject({ notes: 1, imported: 1, claims: 0, attachments: 1 });
    const sources = await service.sources(owner);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      title: 'Versuch α',
      origin: 'note_station',
      project: 'Labor',
      tags: ['Workshop', 'Material'],
    });
    expect((await service.search(owner, { query: 'LabNeedle' })).passages).not.toHaveLength(0);
    expect(await service.allKnowledge(owner)).toHaveLength(0);
    const detail = await service.sourceDetail(owner, sources[0].id);
    const attachment = await service.attachment(owner, String(detail.attachments[0].id));
    expect(await readFile(attachment.file)).toEqual(media);
    expect((await db.query('SELECT * FROM uploads')).rows).toHaveLength(0);
  });
  it('lists and graphs imported originals without requiring accepted claims', async () => {
    await importArchive(await nsxFixture());
    expect(await service.allKnowledge(owner)).toHaveLength(0);
    const notes = await service.browseSources(owner, { limit: 1 });
    expect(notes.total).toBe(2);
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0].excerpt).toBeTruthy();
    const second = await service.browseSources(owner, { limit: 1, offset: 1 });
    expect(second.items[0].id).not.toBe(notes.items[0].id);
    const search = await service.browseSources(owner, { query: 'LabNeedle' });
    expect(search.items.map((source) => source.title)).toEqual(['Versuch α']);
    const graph = await service.graph(owner, {});
    expect(graph.nodes.filter((node) => node.type === 'source')).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.type === 'in_project')).toHaveLength(2);
    const source = search.items[0];
    const focused = await service.graph(owner, { focus_id: source.id, limit: 2, hops: 2 });
    expect(focused.nodes.some((node) => node.id === source.id)).toBe(true);
    expect(focused.truncated).toBe(true);
    const filtered = await service.graph(owner, { project: 'Labor' });
    expect(
      filtered.nodes.filter((node) => node.type === 'source').map((node) => node.label),
    ).toEqual(['Versuch α']);
    expect((await service.dashboard(owner)).topics.map((topic) => topic.name)).toContain(
      'Material',
    );
    expect((await service.dashboard(owner)).projects?.map((project) => project.name)).toContain(
      'Labor',
    );
  });
  it('deduplicates repeated exports and stores changed notes as new revisions', async () => {
    await importArchive(await nsxFixture());
    const duplicate = await importArchive(await nsxFixture());
    expect(duplicate.result).toMatchObject({ imported: 0, duplicates: 2 });
    const changed = await importArchive(await nsxFixture({ changed: true }));
    expect(changed.result).toMatchObject({ imported: 1, duplicates: 1 });
    const source = (await service.sources(owner)).find((source) => source.title === 'Versuch α')!;
    expect(source.revision_count).toBe(2);
    expect(source.metadata?.modified_at).toBe('2027-01-15T08:00:00.000Z');
    const detail = await service.sourceDetail(owner, source.id);
    expect(detail.revisions).toHaveLength(2);
  });
  it('optionally extracts cited candidates without accepting or verifying them', async () => {
    const job = await importArchive(await nsxFixture(), {
      notebook_ids: ['book-a'],
      extract_claims: true,
    });
    expect(job.result.claims).toBeGreaterThan(0);
    const items = await service.allKnowledge(owner);
    for (const item of items) {
      expect(item.lifecycle).toBe('candidate');
      expect(item.verified_at).toBeNull();
      expect((await service.getKnowledge(owner, item.id)).evidence).toHaveLength(1);
    }
  });
  it('can extract claims later from an unchanged export without duplicating notes or candidates', async () => {
    await importArchive(await nsxFixture(), { notebook_ids: ['book-a'] });
    const later = await importArchive(await nsxFixture(), {
      notebook_ids: ['book-a'],
      extract_claims: true,
    });
    expect(later.result).toMatchObject({ imported: 0, duplicates: 1 });
    expect(later.result.claims).toBeGreaterThan(0);
    const count = (await service.allKnowledge(owner)).length;
    await importArchive(await nsxFixture(), { notebook_ids: ['book-a'], extract_claims: true });
    expect((await service.allKnowledge(owner)).length).toBe(count);
    expect(await service.sources(owner)).toHaveLength(1);
  });
  it('retries after a partially committed batch without duplicating previously imported notes', async () => {
    const upload = await service.upload(
      owner,
      await nsxFixture(),
      'notes.nsx',
      'application/octet-stream',
    );
    const job = await service.importSource(owner, {
      title: 'Recoverable migration',
      upload_id: upload.id,
      note_station: { extract_claims: true },
      idempotency_key: randomUUID(),
    });
    const transaction = db.transaction.bind(db);
    let commits = 0;
    db.transaction = ((...args: Parameters<typeof db.transaction>) => {
      if (++commits === 2) return Promise.reject(new Error('Simulated interruption'));
      return transaction(...args);
    }) as typeof db.transaction;
    try {
      await service.processNextJob();
    } finally {
      db.transaction = transaction;
    }
    expect((await service.getJob(owner, job.id)).status).toBe('failed');
    expect(await service.sources(owner)).toHaveLength(1);
    await service.retryJob(owner, job.id);
    await service.processNextJob();
    expect((await service.getJob(owner, job.id)).result).toMatchObject({
      imported: 1,
      duplicates: 1,
    });
    expect(await service.sources(owner)).toHaveLength(2);
  });
  it('keeps shared attachments until the last referring source is forgotten', async () => {
    await importArchive(await nsxFixture());
    const sources = await service.sources(owner);
    const detail = await service.sourceDetail(owner, sources[0].id);
    const attachment = await service.attachment(owner, String(detail.attachments[0].id));
    await service.forgetSource(owner, sources[0].id);
    expect((await stat(attachment.file)).size).toBe(media.length);
    await service.forgetSource(owner, sources[1].id);
    await expect(stat(attachment.file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('writes media atomically and repairs an interrupted or corrupted stored copy', async () => {
    const digest = await storeAttachment(service.storageRoot, media);
    const file = storedPath(service.storageRoot, digest, 'attachments');
    await writeFile(file, Buffer.from('partial write'));
    expect(await storeAttachment(service.storageRoot, media)).toBe(digest);
    expect(await readFile(file)).toEqual(media);
  });
  it.each(['orbit-export', 'commonplace-export'])(
    'restores a %s ZIP backup with metadata and exact attachment bytes',
    async (format) => {
      await importArchive(await nsxFixture());
      const file = path.join(root, `${randomUUID()}.zip`);
      await pipeline(await backupStream(service, owner), createWriteStream(file));
      const archive = await SafeZip.open(file);
      try {
        const manifest = JSON.parse(
          (await archive.read('brain.json', 64 * 1024 * 1024)).toString('utf8'),
        );
        expect(manifest.format).toBe('orbit-export');
        if (format === 'commonplace-export') {
          manifest.format = format;
          const entries: { name: string; bytes: Buffer }[] = [
            { name: 'brain.json', bytes: Buffer.from(JSON.stringify(manifest)) },
          ];
          for (const name of archive.entries.keys())
            if (name !== 'brain.json')
              entries.push({ name, bytes: await archive.read(name, 64 * 1024 * 1024) });
          archive.close();
          await writeFile(file, await zipBytes(entries));
        }
      } finally {
        archive.close();
      }
      const restoredDb = await openDatabase();
      const restored = new BrainService(restoredDb, undefined, path.join(root, randomUUID()));
      try {
        expect(await restoreBundle(restored, owner, file)).toMatchObject({ sources: 2 });
        const detail = await restored.sourceDetail(owner, (await restored.sources(owner))[0].id);
        const attachment = await restored.attachment(owner, String(detail.attachments[0].id));
        expect(await readFile(attachment.file)).toEqual(media);
        expect(detail.metadata?.note_id).toBeTruthy();
        expect(
          (await restored.search(owner, { query: 'LabNeedle' })).passages.length,
        ).toBeGreaterThan(0);
      } finally {
        await restoredDb.close();
      }
    },
  );
  it('supports disk uploads and authenticated preview/download routes while denying readers upload access', async () => {
    const app = createApp(service, {
      assistant: 'writer-key',
      reader: 'reader-key',
      session: 'owner-key',
    });
    await request(app)
      .post('/api/uploads')
      .set('Host', 'localhost')
      .set('Authorization', 'Bearer reader-key')
      .attach('file', await nsxFixture(), 'notes.nsx')
      .expect(403);
    const uploaded = await request(app)
      .post('/api/uploads')
      .set('Host', 'localhost')
      .set('Authorization', 'Bearer writer-key')
      .attach('file', await nsxFixture(), 'notes.nsx')
      .expect(201);
    await request(app)
      .get(`/api/uploads/${uploaded.body.id}/preview`)
      .set('Host', 'localhost')
      .set('Authorization', 'Bearer writer-key')
      .expect(200)
      .expect((response) => expect(response.body.notes).toBe(2));
    await service.importSource(owner, {
      title: 'HTTP migration',
      upload_id: uploaded.body.id,
      note_station: { notebook_ids: ['book-a'] },
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    const detail = await service.sourceDetail(owner, (await service.sources(owner))[0].id);
    await request(app)
      .get(`/api/attachments/${detail.attachments[0].id}`)
      .set('Host', 'localhost')
      .expect(401);
    const downloaded = await request(app)
      .get(`/api/attachments/${detail.attachments[0].id}`)
      .set('Host', 'localhost')
      .set('Authorization', 'Bearer reader-key')
      .expect(200);
    expect(downloaded.text).toBe(media.toString());
    expect(downloaded.headers['content-disposition']).toContain('attachment;');
    const revisionId = String(detail.revisions[0].id);
    const original = await request(app)
      .get(`/api/sources/${detail.id}/revisions/${revisionId}/original`)
      .set('Host', 'localhost')
      .set('Authorization', 'Bearer reader-key')
      .expect(200);
    expect(original.body.title).toBe('Versuch α');
    expect(original.body.content).toContain('<script>');
    expect(original.headers['content-disposition']).toContain('attachment;');
  });
  it('rejects unsafe ZIP paths, symlinks, malformed archives and storage keys', async () => {
    const bytes = await zipBytes([{ name: 'safe.txt', bytes: Buffer.from('safe') }]);
    const unsafe = Buffer.from(bytes);
    let offset = 0;
    while ((offset = unsafe.indexOf(Buffer.from('safe.txt'), offset)) !== -1) {
      Buffer.from('../x.txt').copy(unsafe, offset);
      offset += 8;
    }
    await expect(SafeZip.open(await fixtureFile(unsafe))).rejects.toThrow();
    await expect(
      SafeZip.open(
        await fixtureFile(
          await zipBytes([{ name: 'link', bytes: Buffer.from('elsewhere'), mode: 0o120777 }]),
        ),
      ),
    ).rejects.toThrow('symlinks');
    await expect(NsxArchive.open(await fixtureFile(Buffer.from('not a ZIP')))).rejects.toThrow(
      'readable ZIP',
    );
    expect(() => storedPath(root, '../secret', 'attachments')).toThrow('identifier');
  });
});
