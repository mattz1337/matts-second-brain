import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase, type DB } from '../../server/db';
import { BrainService, owner } from '../../server/service';
import { Assistant } from '../../server/assistant';
import { AssistantConfiguration } from '../../server/assistant-config';
import { createApp } from '../../server/app';
import { SafeZip } from '../../server/nsx';
import type { Express } from 'express';

let db: DB,
  brain: BrainService,
  assistant: Assistant,
  server: ReturnType<typeof createServer>,
  base: string,
  directory: string;
let modelCalls = 0;
const plan = {
  source: 'activities',
  sport: 'running',
  start: '2026-09-01',
  end: '2026-09-30',
  metric: 'sessions',
  group_by: 'month',
};
function model(content: string, calls: { name: string; args: unknown }[] = []) {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] })}\n\ndata: ${JSON.stringify({ usage: { cost: 0.0001 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orbit-browser-assistant-'));
  if (!directory.startsWith(path.resolve(tmpdir()) + path.sep))
    throw Error('Unsafe test directory');
  db = await openDatabase(directory);
  brain = new BrainService(db, undefined, path.join(directory, 'files'));
  await brain.addKnowledge(owner, {
    title: 'Deliberate learning',
    statement: 'I learn by practicing deliberately and reflecting on what happened.',
    tags: ['Learning'],
    idempotency_key: randomUUID(),
  });
  await brain.addKnowledge(owner, {
    title: 'Reflection notes',
    statement: 'Writing reflections can guide a subsequent practice session.',
    tags: ['Learning'],
    idempotency_key: randomUUID(),
  });
  const configuration = new AssistantConfiguration(directory, {});
  await configuration.update({
    provider: 'openrouter',
    model: 'fixture/model',
    daily_budget: 0.25,
    daily_calls: 60,
    api_key: 'fixture-key',
    garmin_url: 'http://127.0.0.1:4312',
    garmin_token: 'fixture-token',
  });
  modelCalls = 0;
  assistant = new Assistant(brain, {
    configuration,
    request: async (url, options) => {
      const body = JSON.parse(String(options?.body || '{}'));
      if (!String(url).includes('openrouter')) {
        const selected = body.plan || plan;
        const sessions = selected.start === '2026-09-01' ? 4 : 2;
        return Response.json({
          facts: {
            sessions,
            hours: sessions,
            first_session: selected.start,
            start: selected.start,
            end: selected.end,
            sport: 'running',
          },
          chart: {
            title: 'Recorded sessions',
            unit: 'sessions',
            points: [
              { date: selected.start, value: sessions - 1 },
              { date: selected.end, value: 1 },
            ],
            note: 'Synthetic recorded totals. Missing records are unknown.',
          },
          sources: [{ label: 'Fixture records', detail: 'Calculated locally' }],
          last_sync: null,
          plan: selected,
          calculation_version: 'fixture-v1',
          snapshot_hash: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
          captured_at: new Date().toISOString(),
        });
      }
      modelCalls++;
      const question =
        [...body.messages].reverse().find((m: { role: string }) => m.role === 'user')?.content ||
        '';
      if (question.includes('slow'))
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"Preparing an answer…"}}]}\n\n',
                ),
              );
              options?.signal?.addEventListener(
                'abort',
                () => controller.error(Error('cancelled')),
                { once: true },
              );
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      if (body.messages.at(-1).role === 'user') {
        if (question.includes('Garmin'))
          return model('', [
            {
              name: 'compare_garmin',
              args: { plan, baseline: { ...plan, start: '2026-08-01', end: '2026-08-31' } },
            },
          ]);
        return model('', [
          { name: 'search_knowledge', args: { query: 'learning' } },
          ...(question.includes('draft')
            ? [
                {
                  name: 'propose_note',
                  args: {
                    title: 'A practice plan',
                    statement: 'Practice deliberately, then write a short reflection [K1].',
                    tags: ['Learning'],
                    project: '',
                  },
                },
              ]
            : []),
        ]);
      }
      return question.includes('Garmin')
        ? model('Your recorded total increased by two sessions [G1] [G2].')
        : model(
            'Your learning note describes deliberate practice [K1]. The draft is ready for you to inspect and save.',
          );
    },
  });
  let app: Express;
  server = createServer((req, res) => app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  app = createApp(
    brain,
    { session: 'fixture-owner', assistant: 'fixture-assistant', reader: 'fixture-reader' },
    port,
    { mode: 'local' },
    { assistant },
  );
});
test.afterEach(async () => {
  await assistant.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

test('assistant streams cited answers, saves a reviewed draft with provenance, and restores the conversation', async ({
  page,
}) => {
  await page.goto(`${base}/?view=assistant`);
  await expect(page.getByRole('heading', { name: 'Ask Orbit', exact: true })).toBeVisible();
  await page.getByLabel('Use cloud AI', { exact: true }).check();
  await page.getByLabel('Message Orbit').fill('Please draft a learning routine.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeVisible();
  expect(await brain.allKnowledge(owner)).toHaveLength(2);
  await page.getByRole('button', { name: /\[K1\].*Deliberate learning/ }).click();
  await expect(page.getByRole('dialog', { name: 'Source [K1]' })).toContainText(
    'I learn by practicing',
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.screenshot({ path: '.data/screenshots/assistant-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('button', { name: /Open note/ })).toBeVisible();
  const saved = (await brain.allKnowledge(owner)).find((item) => item.title === 'A practice plan')!;
  expect(saved.verified_at).toBeNull();
  expect(
    (await brain.getKnowledge(owner, saved.id)).assistant_origin?.citations.length,
  ).toBeGreaterThan(0);
  await page.reload();
  await expect(
    page.getByText('Your learning note describes deliberate practice', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Open note/ })).toBeVisible();
  await page.getByRole('button', { name: /Open note/ }).click();
  await expect(page.getByRole('dialog', { name: 'Knowledge detail' })).toContainText(
    'A practice plan',
  );
});

test('local Garmin queries need no cloud call, comparisons render exact snapshots, and mobile does not overflow', async ({
  page,
}) => {
  await page.goto(`${base}/?view=assistant`);
  await page.getByLabel('Assistant context').selectOption('garmin');
  await page.getByLabel('Message Orbit').fill('running last month');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Local Garmin result', { exact: true })).toBeVisible();
  expect(modelCalls).toBe(0);
  await page.getByLabel('Use cloud AI', { exact: true }).check();
  await page.getByLabel('Message Orbit').fill('Compare Garmin periods.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(
    page.getByText('Your recorded total increased by two sessions', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: 'Recorded sessions' })).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/assistant-mobile.png', fullPage: true });
  await page.getByLabel('Message Orbit').fill('slow response');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('stopped');
});

test('Graphify import stages links and owner acceptance changes the graph', async ({ page }) => {
  await page.goto(`${base}/?view=settings`);
  await expect(
    page.getByRole('heading', { name: 'Graphify connections', exact: true }),
  ).toBeVisible();
  const exported = await page.request.get(`${base}/api/assistant/graphify/corpus`);
  expect(exported.ok()).toBe(true);
  const file = path.join(directory, 'corpus.zip');
  await writeFile(file, await exported.body());
  const zip = await SafeZip.open(file);
  let manifest: any;
  try {
    manifest = JSON.parse((await zip.read('orbit-manifest.json', 1000000)).toString('utf8'));
  } finally {
    zip.close();
  }
  const [a, b] = manifest.sources;
  const graph = {
    nodes: [
      { id: a.id, source_file: a.file },
      { id: b.id, source_file: b.file },
    ],
    links: [
      { source: a.id, target: b.id, relation: 'related learning concept', confidence: 'INFERRED' },
    ],
  };
  await page
    .getByLabel('Graphify graph.json', { exact: true })
    .setInputFiles({
      name: 'graph.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(graph)),
    });
  await page
    .getByLabel('Matching orbit-manifest.json', { exact: true })
    .setInputFiles({
      name: 'orbit-manifest.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(manifest)),
    });
  await page.getByRole('button', { name: 'Import suggestions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Accept connection', exact: true })).toBeVisible();
  expect((await brain.graph(owner, {})).edges.some((edge) => edge.type === 'related_to')).toBe(
    false,
  );
  await page.getByRole('button', { name: 'Accept connection', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Remove Graphify link', exact: true }),
  ).toBeVisible();
  expect((await brain.graph(owner, {})).edges.some((edge) => edge.type === 'related_to')).toBe(
    true,
  );
});
