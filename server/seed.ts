import { randomUUID } from 'node:crypto';
import { BrainService, owner } from './service.js';
import { one } from './db.js';

export async function seedDemo(service: BrainService) {
  const exists = await one(service.db, "SELECT value FROM preferences WHERE key='demo_seeded'");
  if (exists) return;
  const hasKnowledge = await one<{ n: number }>(
    service.db,
    'SELECT count(*)::int AS n FROM knowledge',
  );
  if (hasKnowledge?.n) return;
  const source = await service.importSource(owner, {
    title: 'Designing a useful second brain',
    tags: ['Knowledge systems', 'Learning'],
    project: 'Second brain',
    idempotency_key: 'seed-source-v1',
    text: '# Evidence comes first\n\nA useful second brain stores the source of a claim alongside the claim itself. Accepting a claim is a decision to keep it, while verifying it requires examining the evidence.\n\n# Finding connections\n\nSemantic search finds related language, while a knowledge graph makes relationships explicit. Search can combine exact terms, vector similarity, and bounded graph traversal.\n\n# Keeping knowledge useful\n\nA review interval schedules a check without deleting historical knowledge. Independent evidence must be counted by original source lineage rather than by the number of copied pages.',
  });
  await service.processNextJob();
  const candidates = (await service.reviewQueue(owner)).candidates;
  for (const k of candidates.slice(0, 4))
    await service.review(owner, k.id, {
      expected_version: k.version,
      decision: 'verify',
      rationale:
        'Demo: checked against the retained introductory source. This is sample knowledge.',
    });
  await service.addKnowledge(owner, {
    title: 'Make retrieval part of the workflow',
    statement:
      'I want project decisions to link back to what I learned and the evidence behind it. A useful second brain should be easy to query from my existing tools.',
    kind: 'personal_observation',
    tags: ['Knowledge systems', 'Projects'],
    project: 'Second brain',
    idempotency_key: 'seed-note-v1',
  });
  await service.addKnowledge(owner, {
    title: 'Small experiments beat vague conclusions',
    statement:
      'For workshop experiments, I record the setup, the changed variable, and the observed result. These are personal observations, and they may not generalize to a different material or machine.',
    kind: 'personal_observation',
    tags: ['Making', 'Learning'],
    project: 'Workshop',
    idempotency_key: 'seed-note-v2',
  });
  await service.addKnowledge(owner, {
    title: 'A hypothesis worth testing',
    statement:
      'Reviewing notes shortly after a project milestone might make it easier to find gaps in my understanding. I want to test this over several projects.',
    kind: 'hypothesis',
    tags: ['Learning', 'Projects'],
    project: 'Second brain',
    idempotency_key: 'seed-note-v3',
  });
  const active = (await service.allKnowledge(owner)).filter((k) => k.lifecycle === 'active');
  if (active.length > 1) await service.link(owner, active[0].id, active[1].id, 'related_to');
  // Sample overdue verification makes the freshness workflow visible on the first visit.
  const verified = (await service.allKnowledge(owner)).find((k) => k.verified_at);
  if (verified) {
    await service.db.query(
      "UPDATE knowledge SET verified_at=now()-interval '130 days' WHERE id=$1",
      [verified.id],
    );
    await service.db.query(
      "UPDATE versions SET snapshot=jsonb_set(snapshot,'{verified_at}',to_jsonb(now()-interval '130 days')) WHERE knowledge_id=$1 AND version=$2",
      [verified.id, verified.version],
    );
  }
  await service.db.query(
    "INSERT INTO preferences(key,value) VALUES('demo_seeded',$1) ON CONFLICT DO NOTHING",
    [
      JSON.stringify({
        job: source.id,
        seeded_at: new Date().toISOString(),
        demo: true,
        marker: randomUUID(),
      }),
    ],
  );
}
