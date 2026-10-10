import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import path from 'node:path';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { suggestCategories } from '../server/categorization.js';
import { createApp } from '../server/app.js';
import { invokeTool } from '../server/mcp.js';
import { nsxFixture } from './fixtures/nsx.js';
import type { Actor } from '../shared/contracts.js';

let db: DB;
let service: BrainService;
const reader: Actor = { id: 'reader', scopes: ['brain:read'], owner: false };
const assistant: Actor = { id: 'assistant', scopes: ['brain:read', 'brain:write'], owner: false };
const note = (overrides: Record<string, unknown> = {}) => ({
  title: 'PostgreSQL database notes',
  statement: 'SQL and vector embeddings help retrieve data.',
  idempotency_key: randomUUID(),
  ...overrides,
});
beforeEach(async () => {
  db = await openDatabase();
  service = new BrainService(db, undefined, path.resolve(`.data/category-tests/${randomUUID()}`));
});
afterEach(async () => {
  await db.close();
});

describe('automatic category hierarchy', () => {
  it('uses specific bilingual keyword matches and keeps uncertain content uncategorized', () => {
    const classify = (title: string, text: string) =>
      suggestCategories({ title, text, tags: [], project: '' });
    expect(classify('Rezepte zum Backen', 'Zutaten und ein Rezept für Brot.')[0].path).toEqual([
      'Life',
      'Food & cooking',
    ]);
    expect(
      classify('Random thought', 'The word vacationer is not a travel keyword.')[0].method,
    ).toBe('fallback');
    expect(classify('Simple note', 'A single incidental reference to python.')[0].method).toBe(
      'fallback',
    );
  });
  it('creates real child-parent edges on capture and recategorizes edits without overwriting tags', async () => {
    const item = await service.addKnowledge(owner, note({ tags: ['Personal / Learning'] }));
    const graph = await service.graph(owner, { focus_id: item.id });
    const data = graph.nodes.find((node) => node.label === 'Data & AI')!;
    const parent = graph.nodes.find((node) => node.label === 'Technology')!;
    expect(
      graph.edges.some(
        (edge) =>
          edge.source === item.id &&
          edge.target === data.id &&
          edge.type === 'categorized_as' &&
          edge.properties?.rationale?.includes('vector'),
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.source === data.id && edge.target === parent.id && edge.type === 'category_parent',
      ),
    ).toBe(true);
    expect(graph.nodes.some((node) => node.label === 'Personal')).toBe(true);
    const edited = await service.update(owner, item.id, {
      expected_version: 1,
      title: 'Recipes for baking',
      statement: 'Cooking recipes list ingredients for baking.',
      tags: [],
    });
    const after = await service.graph(owner, { focus_id: item.id });
    expect(after.nodes.some((node) => node.label === 'Food & cooking')).toBe(true);
    expect(after.nodes.some((node) => node.label === 'Data & AI')).toBe(false);
    expect(edited.verified_at).toBeNull();
    expect(
      (await service.classification.list()).some((category) => category.label === 'Technology'),
    ).toBe(false);
  });
  it('categorizes imports, hides candidates by default, and filters an entire parent branch', async () => {
    const first = await service.addKnowledge(owner, note());
    const second = await service.addKnowledge(
      owner,
      note({ title: 'Cooking recipes', statement: 'Baking recipes require ingredients.' }),
    );
    const candidate = await service.addKnowledge(assistant, note());
    const job = await service.importSource(owner, {
      title: 'Database reference',
      text: 'PostgreSQL is a database with SQL support and vector embeddings.',
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    const imported = await service.getJob(owner, job.id);
    expect(imported.status, imported.error || '').toBe('completed');
    const categories = await service.classification.list();
    const technology = categories.find((category) => category.label === 'Technology')!;
    expect(technology.count).toBe(2); // one original source and one accepted note
    const filtered = await service.graph(owner, { category_id: technology.id });
    expect(filtered.nodes.some((node) => node.id === first.id)).toBe(true);
    expect(filtered.nodes.some((node) => node.id === imported.result.source_id)).toBe(true);
    expect(filtered.nodes.some((node) => node.id === second.id || node.id === candidate.id)).toBe(
      false,
    );
    expect(
      (await service.classification.list(true)).find((category) => category.id === technology.id)!
        .count,
    ).toBeGreaterThan(technology.count);
  });
  it('preserves NSX notebook provenance without turning import folders into categories', async () => {
    const fixture = await nsxFixture();
    const upload = await service.upload(owner, fixture, 'categories.nsx', 'application/zip');
    const job = await service.importSource(owner, {
      title: 'Category fixture',
      upload_id: upload.id,
      note_station: { extract_claims: false },
      idempotency_key: randomUUID(),
    });
    await service.processNextJob();
    expect((await service.getJob(owner, job.id)).status).toBe('completed');
    const categories = await service.classification.list();
    expect(categories.some((category) => ['Notebooks', 'Labor'].includes(category.label))).toBe(
      false,
    );
    const source = (await service.sources(owner)).find((source) => source.title === 'Versuch α')!;
    expect((await service.sourceDetail(owner, source.id)).metadata).toMatchObject({
      notebook: 'Labor',
      stack: 'Research',
    });
    const graph = await service.graph(owner, { project: 'Labor' });
    expect(graph.nodes.some((node) => node.type === 'source')).toBe(true);
    expect(graph.edges.some((edge) => edge.type === 'category_parent')).toBe(true);
    expect((await service.classification.status()).pending).toBe(0);
  });
  it('retires legacy import branches on startup, rescan and restore while preserving custom owner decisions', async () => {
    const item = await service.addKnowledge(owner, note());
    await service.classification.decide(owner, item.id, {
      action: 'accept',
      path: ['Notebooks', 'My actual topic'],
      expected_version: 0,
    });
    const root: string = randomUUID(),
      folder: string = randomUUID();
    await db.query(
      "INSERT INTO nodes(id,type,label) VALUES($1,'category','Notebooks'),($2,'category','Old notebook')",
      [root, folder],
    );
    await db.query(
      "INSERT INTO entities(id,canonical,type) VALUES($1,'collections:[\"notebooks\"]','category'),($2,'collections:[\"notebooks\",\"old notebook\"]','category')",
      [root, folder],
    );
    await db.query(
      "INSERT INTO relations(id,source_node,target_node,type) VALUES($1,$2,$3,'category_parent'),($4,$5,$2,'categorized_as')",
      [randomUUID(), folder, root, randomUUID(), item.id],
    );
    await db.query(
      "INSERT INTO category_decisions(node_id,category_id,decision,actor) VALUES($1,$2,'accept','owner')",
      [item.id, folder],
    );
    const legacy = await service.exportData(owner);
    await service.classification.ensureBackfill();
    await service.classification.queue();
    await service.processNextJob();
    const assertMigrated = async (brain: BrainService) => {
      const detail = await brain.classification.detail(item.id);
      expect(
        detail.assigned.some(
          (entry) =>
            entry.path.join('/') === 'Notebooks/My actual topic' && entry.method === 'manual',
        ),
      ).toBe(true);
      expect(detail.assigned.some((entry) => entry.category_id === folder)).toBe(false);
      expect(detail.decisions.some((entry) => entry.category_id === folder)).toBe(false);
      expect(
        (await brain.graph(owner, {})).nodes.some((node) => [root, folder].includes(node.id)),
      ).toBe(false);
      expect((await brain.entities(owner)).some((node) => [root, folder].includes(node.id))).toBe(
        false,
      );
      const backup = await brain.exportData(owner);
      expect(
        backup.data!.category_decisions!.some(
          (raw) => (raw as { category_id: string }).category_id === folder,
        ),
      ).toBe(true);
    };
    await assertMigrated(service);
    const other = await openDatabase();
    try {
      const restored = new BrainService(other);
      await restored.restoreData(owner, legacy);
      await assertMigrated(restored);
    } finally {
      await other.close();
    }
  });
  it('backfills legacy data, deduplicates jobs, recovers interruptions and preserves verification/history', async () => {
    const item = await service.addKnowledge(owner, note());
    const verified = await service.review(owner, item.id, {
      expected_version: 1,
      decision: 'verify',
      rationale: 'Checked against a reference.',
    });
    const before = await service.getKnowledge(owner, item.id);
    await db.query("DELETE FROM relations WHERE type IN ('categorized_as','category_parent')");
    await db.query('DELETE FROM categorizations');
    expect((await service.classification.status()).pending).toBe(1);
    await service.classification.ensureBackfill();
    const scan = await service.classification.queue();
    expect((await service.classification.queue()).id).toBe(scan.id);
    await db.query("UPDATE jobs SET status='running' WHERE id=$1", [scan.id]);
    await service.recoverJobs();
    await service.processNextJob();
    const done = await service.getJob(owner, scan.id);
    expect(done.status, done.error || '').toBe('completed');
    expect(done.result.scanned).toBe(1);
    expect(
      (await service.graph(owner, {})).edges.some((edge) => edge.type === 'category_parent'),
    ).toBe(true);
    const after = await service.getKnowledge(owner, item.id);
    expect(after.version).toBe(verified.version);
    expect(after.verified_at).toBe(before.verified_at);
    expect(after.versions).toEqual(before.versions);
    const edgeIds = (await service.graph(owner, {})).edges.map((edge) => edge.id).sort();
    await service.classification.queue();
    await service.processNextJob();
    expect((await service.graph(owner, {})).edges.map((edge) => edge.id).sort()).toEqual(edgeIds);
  });
  it('round-trips category provenance and rebuilds older backups without classification metadata', async () => {
    const item = await service.addKnowledge(owner, note());
    const archive = await service.exportData(owner);
    const other = await openDatabase();
    try {
      const restored = new BrainService(other);
      await restored.restoreData(owner, archive);
      expect(
        (await restored.graph(owner, { focus_id: item.id })).edges.some(
          (edge) => edge.properties?.method === 'content_rule',
        ),
      ).toBe(true);
      await other.exec('TRUNCATE nodes CASCADE');
      const legacy = structuredClone(archive);
      delete legacy.data.categorizations;
      legacy.data.relations = legacy.data.relations
        .filter(
          (raw) => !['categorized_as', 'category_parent'].includes((raw as { type: string }).type),
        )
        .map((raw) => {
          const entry = { ...(raw as Record<string, unknown>) };
          delete entry.properties;
          return entry;
        });
      await restored.restoreData(owner, legacy);
      expect((await restored.classification.status()).pending).toBe(0);
      expect((await restored.graph(owner, {})).nodes.some((node) => node.type === 'category')).toBe(
        true,
      );
    } finally {
      await other.close();
    }
  });
  it('keeps category ancestors with the bounded sample and drops deleted memberships', async () => {
    const items = await Promise.all(
      Array.from({ length: 20 }, () => service.addKnowledge(owner, note())),
    );
    const graph = await service.graph(owner, { limit: 10 });
    expect(graph.nodes.length).toBeLessThanOrEqual(10);
    expect(graph.truncated).toBe(true);
    const leaf = graph.nodes.find((node) => node.label === 'Data & AI')!;
    expect(leaf).toBeTruthy();
    expect(graph.nodes.some((node) => node.label === 'Technology')).toBe(true);
    expect(
      graph.edges.some((edge) => edge.target === leaf.id && edge.type === 'categorized_as'),
    ).toBe(true);
    await service.forget(owner, items[0].id, 1);
    expect(
      (await service.classification.list()).find((category) => category.id === leaf.id)!.count,
    ).toBe(19);
  });
  it('enforces read/write scopes for REST and MCP rescans', async () => {
    const keys = {
      session: 'fixture-session',
      assistant: 'fixture-assistant',
      reader: 'fixture-reader',
    };
    const app = createApp(service, keys);
    await request(app)
      .post('/api/categories/rescan')
      .set('Authorization', `Bearer ${keys.reader}`)
      .send({})
      .expect(403);
    await request(app)
      .get('/api/categories')
      .set('Authorization', `Bearer ${keys.reader}`)
      .expect(200);
    await request(app)
      .post('/api/categories/rescan')
      .set('Authorization', `Bearer ${keys.assistant}`)
      .send({})
      .expect(202);
    await expect(invokeTool(service, reader, 'rescan_categories', {})).rejects.toMatchObject({
      status: 403,
    });
    expect(await invokeTool(service, reader, 'list_categories', {})).toHaveProperty('status');
  });
});
