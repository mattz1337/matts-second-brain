import { test, expect } from '@playwright/test';
test('graph selections preview formatted knowledge and fullscreen retains the selection and opens detail correctly', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your knowledge, connected.' })).toBeVisible();
  const marker = `Preview-${Date.now()}`;
  const response = await page.request.post('/api/knowledge', {
    headers: { Origin: 'http://127.0.0.1:4311' },
    data: {
      title: marker,
      statement:
        '## Training routine\n\n- **Backwards walk** 5–10 minutes\n- Heel toe taps, 12 per side\n\n[Reference](https://example.com/routine)',
      idempotency_key: crypto.randomUUID(),
    },
  });
  expect(response.ok()).toBe(true);
  const item = await response.json();
  await page.goto('/?view=graph');
  await page.getByLabel('Find a graph node').selectOption(item.id);
  const preview = page.getByRole('complementary', { name: 'Selected graph node' });
  await expect(
    preview.getByRole('heading', { name: 'Training routine', exact: true }),
  ).toBeVisible();
  await expect(preview.locator('ul li')).toHaveCount(2);
  await expect(preview.locator('strong').filter({ hasText: 'Backwards walk' })).toBeVisible();
  await page.screenshot({ path: '.data/screenshots/graph-reading-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  const graph = page.locator('.full-graph .graph-component');
  await expect(graph).toHaveAttribute('data-fullscreen', 'true');
  const box = await graph.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 2);
  expect(box!.height).toBeGreaterThanOrEqual(viewport.height - 2);
  await expect(preview.getByRole('heading', { name: marker, exact: true })).toBeVisible();
  await page.screenshot({ path: '.data/screenshots/graph-reading-fullscreen.png' });
  await preview.getByRole('button', { name: 'Open knowledge', exact: true }).click();
  await expect(graph).toHaveAttribute('data-fullscreen', 'false');
  const detail = page.getByRole('dialog', { name: 'Knowledge detail' });
  await expect(
    detail.getByRole('heading', { name: 'Training routine', exact: true }),
  ).toBeVisible();
  await detail.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.locator('.globe-list').getByRole('button', { name: marker, exact: true }).click();
  await expect(preview.getByRole('heading', { name: marker, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(graph).toHaveAttribute('data-fullscreen', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.data/screenshots/graph-reading-mobile.png', fullPage: true });
});
test('source reading keeps original document structure and moves citation passages and hashes to secondary views', async ({
  page,
}) => {
  await page.goto('/?view=sources');
  await page.getByRole('button', { name: 'Import source', exact: true }).click();
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  const marker = `Reading-${Date.now()}`;
  await page.getByLabel('Source document').setInputFiles({
    name: `${marker}.html`,
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<h2>Daily routine</h2><ol><li><strong>Backwards walk</strong> 5–10 minutes</li><li>Heel toe taps, 12 per side</li><li>Split squats, 6–12 per side</li></ol><p>Keep the pace <em>comfortable</em>.</p><script>window.readerExecuted=true</script><a href="javascript:alert(1)">Unsafe link</a>',
    ),
  });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Import source', exact: true })
    .click();
  await expect(page.locator('.source-row').filter({ hasText: marker })).toBeVisible({
    timeout: 20000,
  });
  await page.locator('.source-row').filter({ hasText: marker }).click();
  const dialog = page.getByRole('dialog', { name: 'Retained source' });
  await expect(dialog.getByRole('heading', { name: 'Daily routine', exact: true })).toBeVisible();
  await expect(dialog.locator('.reading-document ol li')).toHaveCount(3);
  await expect(dialog.locator('.source-passages')).toHaveCount(0);
  await expect(dialog.getByText(/Content SHA-256:/)).not.toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, 'readerExecuted'))).toBe(false);
  expect(await dialog.locator('a[href^="javascript:"]').count()).toBe(0);
  await page.screenshot({ path: '.data/screenshots/source-reading-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Citation passages', exact: true }).click();
  await expect(dialog.locator('.source-passages article').first()).toBeVisible();
  await dialog.getByText('Source details & original', { exact: true }).click();
  await expect(dialog.getByText(/Content SHA-256:/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Read', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
  await page.getByLabel('Search library', { exact: true }).fill(marker);
  await page.locator('.library-source-card').filter({ hasText: marker }).click();
  await expect(
    page
      .getByRole('region', { name: 'Selected library item' })
      .getByRole('heading', { name: 'Daily routine', exact: true }),
  ).toBeVisible();
  const sourcesResponse = await page.request.get('/api/sources');
  const sources = await sourcesResponse.json();
  const source = sources.find((entry: { title: string }) => entry.title === marker);
  expect(source).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/?view=graph');
  await page.getByLabel('Find a graph node').selectOption(source.id);
  const preview = page.getByRole('complementary', { name: 'Selected graph node' });
  await expect(preview.getByRole('heading', { name: 'Daily routine', exact: true })).toBeVisible();
  await expect(preview.locator('ol li')).toHaveCount(3);
  await preview.getByRole('button', { name: 'Open source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Retained source' })).toBeVisible();
});
test('fullscreen has a viewport fallback when native fullscreen is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: () => Promise.reject(Error('Fullscreen blocked')),
      configurable: true,
    });
  });
  await page.goto('/?view=graph');
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  const graph = page.locator('.full-graph .graph-component');
  await expect(graph).toHaveAttribute('data-fullscreen', 'true');
  await page.keyboard.press('Escape');
  await expect(graph).toHaveAttribute('data-fullscreen', 'false');
  await expect(page.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeFocused();
});
