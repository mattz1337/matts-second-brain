import { test, expect } from '@playwright/test';
import type { Knowledge, Source, ImportJob } from '../../shared/contracts';

test('a failed file import reuses its upload and then exposes the queued job', async ({ page }) => {
  await page.goto('/?view=sources');
  await page.getByRole('button', { name: 'Import source', exact: true }).click();
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  const marker = `UXUpload-${Date.now()}`;
  await page.getByLabel('Source document').setInputFiles({
    name: `${marker}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('An original retained for upload retry testing.'),
  });
  let uploads = 0,
    attempts = 0;
  await page.route('**/api/uploads', async (route) => {
    if (route.request().method() === 'POST') uploads++;
    await route.continue();
  });
  await page.route('**/api/imports', async (route) => {
    if (route.request().method() === 'POST' && ++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Import queue temporarily unavailable.' } },
      });
    await route.continue();
  });
  const dialog = page.getByRole('dialog', { name: 'Capture something worth keeping' });
  await dialog.getByRole('button', { name: 'Import source', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Import queue temporarily unavailable');
  await dialog.getByRole('button', { name: 'Import source', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Import activity' }).getByText(marker, { exact: true }),
  ).toBeVisible();
  expect(uploads).toBe(1);
  expect(attempts).toBe(2);
});

test('capture protects drafts, exposes save errors and stays open until a delayed save completes', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Capture an idea' }).click();
  const dialog = page.getByRole('dialog', { name: 'Capture something worth keeping' });
  const marker = `UXDraft-${Date.now()}`;
  await expect(dialog.getByLabel('Title', { exact: true })).toBeFocused();
  await dialog.getByLabel('Title', { exact: true }).fill(marker);
  await dialog
    .getByLabel('Your knowledge', { exact: true })
    .fill('A draft worth preserving through a failed save.');
  await page.keyboard.press('Escape');
  await expect(dialog.getByText('Keep your changes?', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(dialog.getByLabel('Your knowledge', { exact: true })).toHaveValue(
    'A draft worth preserving through a failed save.',
  );
  let attempts = 0,
    release!: () => void,
    started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/knowledge', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: { message: 'Temporary save failure. Try again.' } },
      });
    started();
    await gate;
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Save knowledge', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Temporary save failure');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await dialog.getByLabel('Your knowledge', { exact: true }).focus();
  await page.keyboard.press('Control+Enter');
  await began;
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  release();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toContainText('Knowledge saved');
  expect(attempts).toBe(2);
  await page.getByRole('button', { name: 'Open note', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Knowledge detail' })
      .getByRole('heading', { name: marker, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Capture knowledge', exact: false }).click();
  await page.getByLabel('Title', { exact: true }).fill('Disposable draft');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('library search and filters survive reload and Back while global search clears unrelated filters', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected.' })).toBeVisible();
  const marker = `UXSearch-${Date.now()}`;
  const created = await page.request.post('/api/knowledge', {
    headers: { Origin: 'http://127.0.0.1:4311' },
    data: {
      title: marker,
      statement: 'A fixture for restoring search context.',
      tags: ['UXTopic'],
      project: 'UXProject',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(created.ok()).toBe(true);
  await page.goto('/?view=library');
  await page.getByLabel('Search library', { exact: true }).fill(marker);
  await page.getByRole('button', { name: 'Accepted', exact: true }).click();
  await page.getByLabel('Filter by topic', { exact: true }).selectOption('UXTopic');
  await page.getByLabel('Filter by notebook or project').selectOption('UXProject');
  await expect(page.locator('.knowledge-card').filter({ hasText: marker })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Search library', { exact: true })).toHaveValue(marker);
  await expect(page.getByLabel('Filter by topic', { exact: true })).toHaveValue('UXTopic');
  await expect(page.getByLabel('Filter by notebook or project')).toHaveValue('UXProject');
  await page.getByRole('button', { name: 'Knowledge graph', exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel('Search library', { exact: true })).toHaveValue(marker);
  await expect(page.getByRole('button', { name: 'Accepted', exact: true })).toHaveClass(/selected/);
  await expect(page.getByLabel('Search your knowledge')).toHaveValue(marker);
  await page.getByLabel('Search your knowledge').fill('Different search');
  await page.getByLabel('Search your knowledge').press('Enter');
  await expect(page.getByLabel('Filter by topic', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Filter by notebook or project')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'All', exact: true })).toHaveClass(/selected/);
});

test('search waits for typing to settle and ignores an evidence digest for a superseded query', async ({
  page,
}) => {
  await page.goto('/?view=library');
  let searches = 0;
  await page.route('**/api/search', async (route) => {
    searches++;
    await route.continue();
  });
  const search = page.getByLabel('Search library', { exact: true });
  await search.pressSequentially('DebounceFixture', { delay: 20 });
  await expect(page.locator('.library-browser')).toHaveAttribute('aria-busy', 'false');
  expect(searches).toBeLessThanOrEqual(2);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route('**/api/answer', async (route) => {
    started();
    await gate;
    await route.fulfill({
      json: {
        summary: 'Old query digest',
        gap: false,
        claims: [],
        passages: [],
        warnings: [],
        mode: 'lexical',
      },
    });
  });
  await page.getByRole('button', { name: 'Ask your brain', exact: true }).click();
  await began;
  await search.fill('New query');
  release();
  await expect(page.locator('.library-browser')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.answer-panel')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ask your brain', exact: true })).toBeEnabled();
});

test('sources put progress first, paginate large collections and provide import completion actions', async ({
  page,
}) => {
  const sources = Array.from({ length: 27 }, (_, i) => ({
    id: crypto.randomUUID(),
    title: `UXSource-${String(i).padStart(2, '0')}`,
    origin: 'text',
    url: null,
    status: 'active',
    tags: [],
    project: i === 26 ? 'Kitchen' : '',
    created_at: '2026-10-10T12:00:00Z',
    metadata: null,
    claim_count: 0,
    revision_count: 1,
  })) as Source[];
  const job = {
    id: crypto.randomUUID(),
    title: 'Notebook import',
    status: 'completed',
    stage: 'completed',
    progress: 100,
    error: null,
    warnings: [],
    result: { notes: 27, imported: 27, claims: 0, attachments: 0 },
    created_at: '2026-10-10T12:00:00Z',
    updated_at: '2026-10-10T12:00:00Z',
    attempts: 1,
  } as ImportJob;
  await page.route('**/api/sources', (route) => route.fulfill({ json: sources }));
  await page.route('**/api/imports', (route) => route.fulfill({ json: [job] }));
  await page.goto('/?view=sources');
  await expect(page.locator('.source-row')).toHaveCount(25);
  const activity = page.getByRole('region', { name: 'Import activity' });
  expect((await activity.boundingBox())!.y).toBeLessThan(
    (await page.locator('.source-row').first().boundingBox())!.y,
  );
  await expect(
    activity.getByText('Your original notes are available in the library.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Next source page' }).click();
  await expect(page.locator('.source-row')).toHaveCount(2);
  await page.getByLabel('Search sources').fill('Kitchen');
  await expect(page.locator('.source-row')).toHaveCount(1);
  await expect(page.locator('.source-row')).toContainText('UXSource-26');
  await page.getByRole('button', { name: 'Clear source search' }).click();
  await expect(page.locator('.source-row')).toHaveCount(25);
  await activity.getByRole('button', { name: 'Browse imported notes' }).click();
  await expect(page.getByRole('button', { name: 'Imported notes', exact: true })).toHaveClass(
    /selected/,
  );
});

test('batch review retains failed items and rationale and retries with their refreshed versions', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected.' })).toBeVisible();
  const records = (await (await page.request.get('/api/knowledge')).json()) as {
    items: Knowledge[];
  };
  const first = {
    ...records.items[0],
    id: crypto.randomUUID(),
    title: 'Batch fixture first',
    lifecycle: 'candidate',
    version: 1,
  };
  const second = { ...first, id: crypto.randomUUID(), title: 'Batch fixture second' };
  let candidates = [first, second],
    attempts = 0;
  await page.route('**/api/review', (route) =>
    route.fulfill({ json: { candidates, due: [], conflicts: [] } }),
  );
  await page.route('**/api/review/batch', async (route) => {
    attempts++;
    const body = route.request().postDataJSON();
    if (attempts === 1) {
      expect(body.items).toHaveLength(2);
      candidates = [{ ...second, version: 2 }];
      await route.fulfill({
        json: {
          results: [
            { id: first.id, ok: true },
            { id: second.id, ok: false, error: 'Changed in another session. Refresh and retry.' },
          ],
        },
      });
    } else {
      expect(body.items).toEqual([{ id: second.id, expected_version: 2 }]);
      expect(body.rationale).toBe('Checked fixture evidence.');
      candidates = [];
      await route.fulfill({ json: { results: [{ id: second.id, ok: true }] } });
    }
  });
  await page.getByRole('button', { name: 'Review queue', exact: true }).click();
  await page.getByLabel('Select this page').check();
  await page.getByRole('button', { name: 'Accept selected', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Accept selected candidates' });
  await dialog.getByLabel('Review rationale').fill('Checked fixture evidence.');
  await dialog.getByRole('button', { name: 'Confirm accept' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Changed in another session');
  await expect(dialog.getByLabel('Review rationale')).toHaveValue('Checked fixture evidence.');
  await expect(dialog.getByText('Review 1 candidates.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry remaining', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'All caught up.' })).toBeVisible();
  expect(attempts).toBe(2);
});

test('graph empty filters can be reset and network errors in the library can be retried', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected.' })).toBeVisible();
  await page.route('**/api/graph', async (route) => {
    const body = route.request().postDataJSON();
    if (body.topic === 'UXEmpty')
      return route.fulfill({
        json: { nodes: [], edges: [], truncated: false, total_nodes: 0, total_edges: 0 },
      });
    await route.continue();
  });
  await page.route('**/api/dashboard', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.topics.push({ name: 'UXEmpty', count: 1 });
    await route.fulfill({ response, json: data });
  });
  await page.goto('/?view=graph');
  await page.getByLabel('Graph topic', { exact: true }).selectOption('UXEmpty');
  await expect(page.getByRole('heading', { name: 'No connections in this view' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all connections', exact: true }).click();
  await expect(page.getByLabel('Graph topic', { exact: true })).toHaveValue('');
  await expect(page.getByRole('img', { name: 'Interactive knowledge graph' })).toBeVisible();
  let fail = true;
  await page.route('**/api/search', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Search is temporarily unavailable.' } },
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Search is temporarily unavailable');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
