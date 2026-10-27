import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { openDatabase, type DB } from '../server/db';
import { BrainService, owner } from '../server/service';
import { Assistant } from '../server/assistant';
import { AssistantConfiguration } from '../server/assistant-config';
import { AssistantModel, type ModelMessage } from '../server/assistant-model';
import { createApp } from '../server/app';
import { GarminConnector } from '../server/garmin-connector';
import type { AssistantInput } from '../shared/assistant';

function sse(content: string, calls: { name: string; args: unknown }[] = []) {
  const lines = [': heartbeat\n\n'];
  for (const [index, call] of calls.entries()) {
    const text = JSON.stringify(call.args),
      middle = Math.floor(text.length / 2);
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: `call-${index}`, function: { name: call.name, arguments: text.slice(0, middle) } }] } }] })}\n\n`,
    );
    lines.push(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: text.slice(middle) } }] } }] })}\n\n`,
    );
  }
  if (content) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  lines.push(
    `data: ${JSON.stringify({ usage: { cost: 0.0001 }, choices: [] })}\n\ndata: [DONE]\n\n`,
  );
  const bytes = new TextEncoder().encode(lines.join(''));
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 17)
          controller.enqueue(bytes.slice(offset, offset + 17));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
let db: DB, brain: BrainService, assistant: Assistant, configuration: AssistantConfiguration;
let requests: { url: string; body: any }[] = [];
let respond: (body: any) => Response | Promise<Response>;
let directory: string;
const input = (overrides: Partial<AssistantInput> = {}): AssistantInput => ({
  content: 'learning',
  scope: 'knowledge',
  cloud: true,
  general: false,
  request_id: randomUUID(),
  ...overrides,
});
const send = async (message: AssistantInput, conversation?: string) =>
  assistant.send(
    owner,
    conversation || (await assistant.create(owner)).id,
    message,
    new AbortController().signal,
    () => {},
  );
const fixture = async () =>
  brain.addKnowledge(owner, {
    title: 'Learning routine',
    statement: 'Deliberate practice helps me learn; this is a personal observation.',
    tags: ['Learning'],
    idempotency_key: randomUUID(),
  });
const settings = {
  provider: 'openrouter',
  model: 'fixture/tool-model',
  daily_budget: 0.25,
  daily_calls: 60,
  garmin_url: 'http://127.0.0.1:4312',
  api_key: 'fixture-secret-key',
  garmin_token: 'fixture-garmin-token',
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orbit-assistant-test-'));
  if (!directory.startsWith(path.resolve(tmpdir()) + path.sep))
    throw Error('Test database must be inside the OS temporary directory.');
  db = await openDatabase(directory);
  brain = new BrainService(db, undefined, path.join(directory, 'files'));
  configuration = new AssistantConfiguration(directory, {});
  assistant = new Assistant(brain, {
    configuration,
    request: async (url, options) => {
      const body = JSON.parse(String(options?.body || '{}'));
      requests.push({ url: String(url), body });
      return respond(body);
    },
  });
  expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM nodes')).rows[0].n).toBe(0);
  requests = [];
  await configuration.update(settings);
  respond = () => sse('No evidence is available.');
});
afterEach(async () => {
  await assistant?.close();
  await db?.close();
});

describe('assistant model and privacy', () => {
  it('assembles fragmented SSE tool arguments without executing partial calls', async () => {
    const model = new AssistantModel(async () =>
      sse('Grüße', [{ name: 'search_knowledge', args: { query: 'learning' } }]),
    );
    const tokens: string[] = [];
    const result = await model.complete(
      await configuration.read(),
      [{ role: 'user', content: 'fixture' }],
      [],
      new AbortController().signal,
      (text) => tokens.push(text),
    );
    expect(result.content).toBe('Grüße');
    expect(tokens.join('')).toBe('Grüße');
    expect(JSON.parse(result.calls[0].function.arguments)).toEqual({ query: 'learning' });
    expect(result.cost).toBe(0.0001);
  });
  it('rejects incomplete streams and keeps credentials outside returned errors', async () => {
    const model = new AssistantModel(async () => new Response('data: {"choices":[]}\n\n'));
    await expect(
      model.complete(await configuration.read(), [], [], new AbortController().signal, () => {}),
    ).rejects.toMatchObject({ code: 'model_stream' });
    expect(JSON.stringify(await assistant.config(owner))).not.toMatch(
      /fixture-secret|fixture-garmin/,
    );
    expect(await readFile(path.join(directory, 'assistant-config.json'), 'utf8')).toContain(
      'fixture-secret-key',
    );
  });
  it('does local search without contacting OpenRouter, even with a configured key', async () => {
    await fixture();
    const result = await send(input({ cloud: false }));
    expect(result.content).toContain('Deliberate practice');
    expect(result.payload.citations).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });
  it('retrieves cited evidence with fail-closed provider routing and safe history', async () => {
    await fixture();
    respond = (body) =>
      body.messages.at(-1).role === 'user'
        ? sse('', [{ name: 'search_knowledge', args: { query: 'learning' } }])
        : sse('Your saved observation describes deliberate practice [K1].');
    const result = await send(input());
    expect(result.content).toContain('[K1]');
    expect(result.payload.citations?.[0].title).toBe('Learning routine');
    expect(requests[0].body.provider).toMatchObject({
      zdr: true,
      data_collection: 'deny',
      require_parameters: true,
    });
    expect(result.payload.usage?.calls).toBe(2);
  });
  it('denies owner-only/model-invented tools and never verifies its own output', async () => {
    const note = await fixture();
    respond = (body) =>
      body.messages.at(-1).role === 'user'
        ? sse('', [
            { name: 'review_knowledge', args: { id: note.id, decision: 'verify' } },
            { name: 'search_knowledge', args: { query: 'learning' } },
          ])
        : sse('The retrieved note remains an observation [K1].');
    const result = await send(input());
    expect(result.payload.tools?.[0].status).toBe('failed');
    expect((await brain.getKnowledge(owner, note.id)).verified_at).toBeNull();
    expect(
      requests[1].body.messages.find((m: ModelMessage) => m.role === 'tool')?.content,
    ).toContain('unavailable');
  });
  it('requires explicit cloud consent and returns no key in public settings', async () => {
    await configuration.update({ ...settings, api_key: '', clear_api_key: true });
    await expect(send(input())).rejects.toMatchObject({ code: 'model_disabled' });
    expect(requests).toHaveLength(0);
    const publicConfig = await assistant.config(owner);
    expect(publicConfig.configured).toBe(false);
    expect(publicConfig).not.toHaveProperty('api_key');
  });
  it('does not send prior Garmin conversation context when knowledge-only is selected', async () => {
    const conversation = (await assistant.create(owner)).id;
    const run = randomUUID();
    await db.query(
      "INSERT INTO assistant_runs(id,conversation_id,request_id,input_hash,budget_day,status,cloud) VALUES($1,$2,$3,'fixture','old','completed',false)",
      [run, conversation, randomUUID()],
    );
    await db.query(
      "INSERT INTO assistant_messages(id,conversation_id,run_id,role,content,payload) VALUES($1,$2,$3,'assistant','PRIVATE-GARMIN-HISTORY',$4)",
      [randomUUID(), conversation, run, JSON.stringify({ scope: 'garmin', cloud: false })],
    );
    await send(input(), conversation);
    expect(JSON.stringify(requests)).not.toContain('PRIVATE-GARMIN-HISTORY');
  });
  it('withholds Garmin-backed evidence and graph labels in knowledge-only context', async () => {
    const item = await fixture();
    const job = await brain.importSource(owner, {
      title: 'PRIVATE-HEALTH-TITLE',
      text: 'PRIVATE-HEALTH-EVIDENCE recorded by the device.',
      tags: ['gArMiN'],
      idempotency_key: randomUUID(),
      extract_claims: false,
    });
    await brain.processNextJob();
    const completed = await brain.getJob(owner, job.id);
    const source = await brain.sourceDetail(owner, completed.result.source_id!);
    await brain.attachEvidence(owner, item.id, {
      passage_id: source.passages[0].id,
      relation: 'supports',
      rationale: 'Fixture evidence',
      expected_version: 1,
      idempotency_key: randomUUID(),
    });
    let phase = 0;
    respond = () =>
      phase++ === 0
        ? sse('', [{ name: 'get_knowledge', args: { id: item.id } }])
        : phase === 2
          ? sse('', [{ name: 'query_graph', args: { id: item.id } }])
          : sse('Your saved observation discusses learning [K1].');
    await send(input());
    const results = requests.flatMap((r) =>
      r.body.messages.filter((m: ModelMessage) => m.role === 'tool'),
    );
    expect(JSON.stringify(results)).not.toContain('PRIVATE-HEALTH');
    expect(JSON.stringify(results)).toContain('\\"evidence\\":[]');
  });
  it('reads a mounted connector token without returning it in public settings', async () => {
    const file = path.join(directory, 'mounted-token.json');
    await writeFile(file, JSON.stringify({ token: 'mounted-connector-token-with-32-characters' }));
    const mounted = new AssistantConfiguration(directory, { GARMIN_CONNECTOR_TOKEN_FILE: file });
    expect((await mounted.read()).garmin_token).toBe('mounted-connector-token-with-32-characters');
    const configured = new Assistant(brain, { configuration: mounted });
    expect(JSON.stringify(await configured.config(owner))).not.toContain('mounted-connector-token');
    await configured.close();
  });
});

describe('assistant writes and accounting', () => {
  it('drafts without writing, then saves atomically once with provenance and no verification', async () => {
    await fixture();
    respond = (body) =>
      body.messages.at(-1).role === 'user'
        ? sse('', [
            { name: 'search_knowledge', args: { query: 'learning' } },
            {
              name: 'propose_note',
              args: {
                title: 'Draft routine',
                statement: 'Practice deliberately and reflect on progress [K1].',
                tags: ['Learning'],
                project: '',
              },
            },
          ])
        : sse('I drafted a routine based on your note [K1].');
    const message = await send(input({ content: 'Draft a routine' }));
    expect(await brain.allKnowledge(owner)).toHaveLength(1);
    const action = message.payload.actions![0];
    const result = (await assistant.decide(owner, action.id, 'apply')) as { id: string };
    expect(await assistant.decide(owner, action.id, 'apply')).toEqual(result);
    expect(await brain.allKnowledge(owner)).toHaveLength(2);
    const saved = await brain.getKnowledge(owner, result.id);
    expect(saved.verified_at).toBeNull();
    expect(saved.kind).toBe('derived_inference');
    expect(saved.assistant_origin?.citations).toHaveLength(1);
    await assistant.remove(owner, (await assistant.conversations(owner))[0].id);
    expect((await brain.getKnowledge(owner, result.id)).assistant_origin?.citations).toHaveLength(
      1,
    );
    expect((await assistant.config(owner)).today_calls).toBe(2);
  });
  it('returns a completed retry without another model call, and rejects key reuse for changed input', async () => {
    const conversation = (await assistant.create(owner)).id,
      body = input();
    const first = await send(body, conversation);
    const count = requests.length;
    expect((await send(body, conversation)).id).toBe(first.id);
    expect(requests).toHaveLength(count);
    await expect(send({ ...body, content: 'Different' }, conversation)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });
  it('blocks another request when the conservative daily allowance is exhausted', async () => {
    await configuration.update({ ...settings, daily_budget: 0.01 });
    await expect(send(input())).rejects.toMatchObject({ code: 'assistant_budget' });
    expect(requests).toHaveLength(0);
  });
  it('cancels a running response without applying a draft and conservatively accounts unknown cost', async () => {
    const abort = new AbortController();
    const config = new AssistantConfiguration(directory, {});
    const pending = new Assistant(brain, {
      configuration: config,
      request: async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(Error('aborted')), {
            once: true,
          });
          setTimeout(() => abort.abort(), 20);
        }),
    });
    const conversation = (await pending.create(owner)).id;
    await expect(
      pending.send(owner, conversation, input(), abort.signal, () => {}),
    ).rejects.toMatchObject({ code: 'cancelled' });
    const messages = await pending.messages(owner, conversation);
    expect(messages.at(-1)?.content).toContain('stopped');
    expect((await pending.config(owner)).today_cost).toBeGreaterThan(0);
  });
  it('retains conservative accounting on recovery and chat deletion', async () => {
    const conversation = (await assistant.create(owner)).id,
      run = randomUUID();
    const budgetDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await db.query(
      "INSERT INTO assistant_runs(id,conversation_id,request_id,input_hash,budget_day,status,cloud,reserved_cost,reserved_calls) VALUES($1,$2,$3,'hash',$4,'running',true,0.1,6)",
      [run, conversation, randomUUID(), budgetDay],
    );
    await assistant.recover();
    await assistant.remove(owner, conversation);
    expect((await assistant.config(owner)).today_cost).toBeCloseTo(0.1);
    expect((await assistant.config(owner)).today_calls).toBe(6);
  });
  it('rejects stale edits after their item changes', async () => {
    const note = await fixture();
    let phase = 0;
    respond = () =>
      phase++ === 0
        ? sse('', [{ name: 'get_knowledge', args: { id: note.id } }])
        : phase === 2
          ? sse('', [
              {
                name: 'propose_edit',
                args: { id: note.id, expected_version: 1, statement: 'A drafted change.' },
              },
            ])
          : sse('I drafted the requested edit [K1].');
    const answer = await send(input());
    await brain.update(owner, note.id, {
      expected_version: 1,
      statement: 'An intervening owner correction.',
    });
    await expect(
      assistant.decide(owner, answer.payload.actions![0].id, 'apply'),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
  it('backs up conversations and saved provenance, and redacts cached answers on forget', async () => {
    const note = await fixture();
    respond = (body) =>
      body.messages.at(-1).role === 'user'
        ? sse('', [{ name: 'search_knowledge', args: { query: 'learning' } }])
        : sse('Your note says deliberate practice [K1].');
    const answer = await send(input());
    const backup = await brain.exportData(owner);
    expect(backup.data.assistant_messages).toHaveLength(2);
    const target = await openDatabase(await mkdtemp(path.join(directory, 'restore-')));
    try {
      const copy = new BrainService(target, undefined, path.join(directory, 'restore-files'));
      await copy.restoreData(owner, backup);
      expect((await target.query('SELECT * FROM assistant_messages')).rows).toHaveLength(2);
    } finally {
      await target.close();
    }
    await brain.forget(owner, note.id, 1);
    const thread = await assistant.messages(owner, (await assistant.conversations(owner))[0].id);
    expect(thread.find((m) => m.id === answer.id)?.content).toContain('removed or retracted');
    expect(thread.find((m) => m.id === answer.id)?.payload.citations).toBeUndefined();
  });
});

describe('Garmin integration and HTTP scopes', () => {
  const plan = {
    source: 'activities',
    sport: 'running',
    start: '2026-09-01',
    end: '2026-09-30',
    metric: 'sessions',
    group_by: 'week',
  };
  const snapshot = (p = plan) => ({
    facts: {
      sessions: p.start === '2026-09-01' ? 4 : 2,
      hours: 4,
      raw_rows: [{ gps: 'PRIVATE-GPS' }],
    },
    chart: {
      title: 'Sessions',
      unit: 'sessions',
      points: [{ date: p.start, value: p.start === '2026-09-01' ? 4 : 2 }],
    },
    sources: [{ label: 'Local records', detail: 'Calculated locally' }],
    last_sync: null,
    plan: p,
    calculation_version: 'fixture-v1',
    snapshot_hash: createHash('sha256').update(JSON.stringify(p)).digest('hex'),
    captured_at: new Date().toISOString(),
  });
  it('allows bounded local queries, strips raw fields and rejects model-provided SQL', async () => {
    const connector = new GarminConnector(async () => Response.json(snapshot()));
    const result = await connector.query(
      await configuration.read(),
      plan,
      new AbortController().signal,
    );
    expect(result.facts).not.toHaveProperty('raw_rows');
    await expect(
      connector.query(
        await configuration.read(),
        { ...plan, sql: 'DROP DATABASE' },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });
  it('computes period differences locally, with no raw rows in model context', async () => {
    let phase = 0;
    respond = (body) => {
      if (body.plan) return Response.json(snapshot(body.plan));
      return phase++ === 0
        ? sse('', [
            {
              name: 'compare_garmin',
              args: { plan, baseline: { ...plan, start: '2026-08-01', end: '2026-08-31' } },
            },
          ])
        : sse('The recorded total increased by two sessions [G1] [G2].');
    };
    const result = await send(input({ scope: 'garmin', content: 'Compare periods' }));
    expect(result.payload.citations).toHaveLength(2);
    const provider = requests.filter((r) => r.url.includes('openrouter'));
    expect(provider.at(-1)?.body.messages.at(-1).content).toContain('"difference":2');
    expect(JSON.stringify(provider)).not.toContain('PRIVATE-GPS');
  });
  it('does not expose Garmin tools in knowledge-only context', async () => {
    respond = (body) =>
      body.messages.at(-1).role === 'user'
        ? sse('', [{ name: 'query_garmin', args: { plan } }])
        : sse('Garmin is unavailable in this context.');
    const answer = await send(input());
    expect(answer.payload.tools?.[0].status).toBe('failed');
    expect(requests.every((r) => r.url.includes('openrouter'))).toBe(true);
  });
  it('keeps assistant configuration and conversations owner-only', async () => {
    const app = createApp(
      brain,
      { session: 'owner-key', assistant: 'writer-key', reader: 'reader-key' },
      4310,
      { mode: 'local' },
      { assistant },
    );
    expect(
      (await request(app).get('/api/assistant/config').set('Authorization', 'Bearer reader-key'))
        .status,
    ).toBe(403);
    expect((await request(app).get('/api/assistant/conversations')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/assistant/conversations')
          .set('Origin', 'http://127.0.0.1:4310')
          .set('Cookie', 'orbit_session=owner-key')
          .send({})
      ).status,
    ).toBe(201);
    await expect(
      configuration.update({ ...settings, garmin_url: 'http://169.254.169.254' }),
    ).rejects.toMatchObject({ code: 'connector_url' });
  });
});
