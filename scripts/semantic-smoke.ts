import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { Embeddings } from '../server/embeddings.js';
import { BrainService, owner } from '../server/service.js';

const db = await openDatabase();
const embeddings = new Embeddings(db);
await embeddings.initialize();
assert.equal((await embeddings.status()).state, 'ready', 'Embedding model must load.');
const service = new BrainService(db, embeddings);
const printing = await service.addKnowledge(owner, {
  title: 'Printing experiments',
  statement: 'Changing the retraction distance can reduce stringing during 3D printing.',
  kind: 'personal_observation',
  idempotency_key: randomUUID(),
});
await service.addKnowledge(owner, {
  title: 'Garden experiments',
  statement: 'Watering tomato plants consistently helps keep the soil moist.',
  kind: 'personal_observation',
  idempotency_key: randomUUID(),
});
await embeddings.indexPending(10);
const observations = [];
for (const query of [
  'How can I stop fine hairs between parts of a printed model?',
  'Wie verhindere ich Fäden beim 3D-Druck?',
  'What is the distance from Earth to Neptune?',
]) {
  const vector = await embeddings.embed(query, true);
  const distances = await db.query<{ title: string; similarity: number }>(
    'SELECT title,1-(embedding <=> $1::vector) AS similarity FROM search_documents WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector',
    [JSON.stringify(vector)],
  );
  const result = await service.search(owner, { query, graph_expansion: false });
  observations.push({ query, ranking: distances.rows, returned: result.items.map((x) => x.title) });
  if (query !== 'What is the distance from Earth to Neptune?') {
    assert.equal(
      distances.rows[0].title,
      printing.title,
      'English and German paraphrases must favor the printing observation.',
    );
    assert.equal(
      result.items[0]?.id,
      printing.id,
      'Semantic retrieval must return the matching observation.',
    );
    assert.equal(result.items.length, 1, 'Unrelated garden knowledge should not be returned.');
  } else {
    assert.equal(
      result.items.length,
      0,
      'Unrelated space questions should not return printing knowledge.',
    );
    assert.equal((await service.answer(owner, { query })).gap, true);
  }
}
console.log(
  JSON.stringify(
    { model: (await embeddings.status()).model, dimensions: 384, observations },
    null,
    2,
  ),
);
await db.close();
