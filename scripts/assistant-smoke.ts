import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.js';
import { AssistantConfiguration } from '../server/assistant-config.js';
import { Assistant } from '../server/assistant.js';
import { BrainService, owner } from '../server/service.js';
import { openDatabase } from '../server/db.js';

if (!process.argv.includes('--live-model'))
  throw Error('Pass --live-model to explicitly run a small paid test with invented data.');
const source = await new AssistantConfiguration(config.dataDir).read();
assert.ok(source.api_key, 'Configure an OpenRouter key first.');
const directory = await mkdtemp(path.join(tmpdir(), 'orbit-synthetic-model-check-'));
assert.ok(directory.startsWith(path.resolve(tmpdir()) + path.sep));
const db = await openDatabase(directory);
const brain = new BrainService(db, undefined, path.join(directory, 'files'));
const settings = new AssistantConfiguration(directory, {
  OPENROUTER_API_KEY: source.api_key,
  ASSISTANT_PROVIDER: 'openrouter',
  ASSISTANT_MODEL: source.model,
});
const assistant = new Assistant(brain, { configuration: settings });
try {
  await brain.addKnowledge(owner, {
    title: 'Invented deliberate practice fixture',
    statement:
      'This is invented test data. The fixture note defines deliberate practice as practising one small skill and then recording a short reflection.',
    idempotency_key: randomUUID(),
  });
  const conversation = await assistant.create(owner);
  const response = await assistant.send(
    owner,
    conversation.id,
    {
      content:
        'What does my fixture note say about deliberate practice? Please cite the retrieved note.',
      request_id: randomUUID(),
      scope: 'knowledge',
      cloud: true,
      general: false,
    },
    new AbortController().signal,
    () => {},
  );
  assert.ok(response.payload.citations?.length, 'A retrieved citation is required.');
  assert.ok(
    response.payload.tools?.some((t) => t.name === 'search_knowledge' && t.status === 'completed'),
  );
  assert.ok(
    !response.payload.notices?.some((n) => n.includes('model did not')),
    'The model must produce grounded output itself.',
  );
  assert.equal(
    (await brain.allKnowledge(owner)).length,
    1,
    'The model must not save knowledge automatically.',
  );
  console.log(
    JSON.stringify({
      passed: true,
      model: source.model,
      citations: response.payload.citations.length,
      ...response.payload.usage,
      context: 'invented fixture only; no private notes or Garmin data',
    }),
  );
} finally {
  await assistant.close();
  await db.close();
}
