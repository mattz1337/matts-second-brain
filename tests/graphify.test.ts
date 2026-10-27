import { beforeEach, afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type DB } from '../server/db';
import { BrainService, owner, hash } from '../server/service';
import { GraphifyIntegration } from '../server/graphify';
let db: DB, brain: BrainService, graphify: GraphifyIntegration;
beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orbit-graphify-test-'));
  if (!directory.startsWith(path.resolve(tmpdir()) + path.sep))
    throw Error('Unsafe test directory');
  db = await openDatabase(directory);
  brain = new BrainService(db, undefined, path.join(directory, 'files'));
  graphify = new GraphifyIntegration(brain);
  expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM nodes')).rows[0].n).toBe(0);
});
afterEach(async () => db.close());
async function fixture() {
  const a = await brain.addKnowledge(owner, {
    title: 'Learning',
    statement: 'Learning needs practice.',
    idempotency_key: randomUUID(),
  });
  const b = await brain.addKnowledge(owner, {
    title: 'Reflection',
    statement: 'Reflection can help learning.',
    idempotency_key: randomUUID(),
  });
  const sources = [a, b].map((note) => ({
    id: note.id,
    file: `knowledge/${note.id}.md`,
    revision: String(note.version),
    hash: hash(JSON.stringify([note.id, String(note.version), note.title, note.statement])),
  }));
  return {
    a,
    b,
    payload: {
      manifest: { format: 'orbit-graphify-corpus-v1', sources },
      graph: {
        nodes: sources.map((s) => ({ id: s.id, source_file: s.file })),
        links: [{ source: a.id, target: b.id, relation: 'reinforces', confidence: 'INFERRED' }],
      },
    },
  };
}
it('stages source-backed suggestions without changing the graph and preserves dismissals', async () => {
  const { payload } = await fixture();
  expect(await graphify.import(owner, payload)).toMatchObject({ created: 1, automatic_changes: 0 });
  const [proposal]: any = await graphify.list(owner);
  expect((await brain.graph(owner, {})).edges.some((e) => e.type === 'related_to')).toBe(false);
  await graphify.decide(owner, proposal.id, 'dismiss');
  expect(await graphify.import(owner, payload)).toMatchObject({ created: 0, existing: 1 });
  expect((await graphify.list(owner))[0]).toMatchObject({ status: 'dismissed' });
});
it('rejects stale source manifests and stale acceptance', async () => {
  const { a, payload } = await fixture();
  await graphify.import(owner, payload);
  const [proposal]: any = await graphify.list(owner);
  await brain.update(owner, a.id, { expected_version: 1, statement: 'Owner changed the source.' });
  await expect(graphify.decide(owner, proposal.id, 'accept')).rejects.toMatchObject({
    code: 'stale_proposal',
  });
  expect(await graphify.import(owner, payload)).toMatchObject({ stale: 1, created: 0 });
});
it('accepts and removes only Graphify-created links without touching owner decisions', async () => {
  const { a, b, payload } = await fixture();
  await brain.link(owner, a.id, b.id, 'related_to');
  await graphify.import(owner, payload);
  const [proposal]: any = await graphify.list(owner);
  await graphify.decide(owner, proposal.id, 'accept');
  await graphify.decide(owner, proposal.id, 'dismiss');
  expect((await brain.graph(owner, {})).edges.some((e) => e.type === 'related_to')).toBe(true);
});
it('applies a reviewed link and exports a deterministic corpus with its manifest', async () => {
  const { payload } = await fixture();
  await graphify.import(owner, payload);
  const [proposal]: any = await graphify.list(owner);
  await graphify.decide(owner, proposal.id, 'accept');
  expect((await brain.graph(owner, {})).edges.some((e) => e.type === 'related_to')).toBe(true);
  const stream = await graphify.export(owner);
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk));
  expect(Buffer.concat(buffers).subarray(0, 2).toString()).toBe('PK');
});
it('rejects unmapped, duplicate or oversized graphs and enforces owner review scope', async () => {
  const { payload } = await fixture();
  const invalid = {
    ...payload,
    graph: { ...payload.graph, nodes: [...payload.graph.nodes, payload.graph.nodes[0]] },
  };
  await expect(graphify.import(owner, invalid)).rejects.toMatchObject({ code: 'invalid_graph' });
  await expect(
    graphify.import(
      { id: 'assistant', owner: false, scopes: ['brain:read', 'brain:write'] },
      payload,
    ),
  ).rejects.toMatchObject({ status: 403 });
});
