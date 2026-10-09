import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { nsxFixture, media } from '../fixtures/nsx.js';

test('overview, graph exploration, settings, and responsive layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: "A place for everything you're learning." }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Accepted knowledge/ })).toBeVisible();
  await page.screenshot({
    path: path.resolve('.data/screenshots/overview-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Explore your graph' }).click();
  await expect(page.getByRole('heading', { name: 'The shape of what you know.' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Interactive knowledge graph' })).toBeVisible();
  const stage = page.locator('.full-graph .globe-stage');
  await expect(stage).toHaveAttribute('data-ready', 'true');
  const canvas = stage.locator('canvas');
  await expect(canvas).toBeVisible();
  expect(
    await canvas.evaluate((element: HTMLCanvasElement) => !!element.getContext('webgl2')),
  ).toBe(true);
  const before = await canvas.screenshot();
  await page.waitForTimeout(350);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await page.getByRole('button', { name: 'Pause animation' }).click();
  await expect(page.getByRole('button', { name: 'Resume animation' })).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Reset globe', exact: true }).click();
  await page.waitForTimeout(1400);
  await page.screenshot({
    path: path.resolve('.data/screenshots/globe-desktop.png'),
    fullPage: true,
  });
  // Click an actual rendered light, using its projected label as a screen anchor.
  const light = await stage.locator('.globe-node-label').evaluateAll((labels) => {
    const label = labels.find((element) => (element as HTMLElement).style.opacity === '1')!;
    const rect = label.getBoundingClientRect();
    return { label: label.textContent!, x: rect.left + rect.width / 2, y: rect.top - 13 };
  });
  await page.mouse.click(light.x, light.y);
  await expect(stage.locator('.globe-selection h3')).toHaveText(light.label);
  const claim = await page
    .getByLabel('Find a graph node')
    .locator('option')
    .evaluateAll((options) =>
      options.find((option) => option.textContent?.endsWith('· Claim'))?.getAttribute('value'),
    );
  expect(claim).toBeTruthy();
  await page.getByLabel('Find a graph node').selectOption(claim!);
  await page.getByRole('button', { name: 'Open knowledge', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Knowledge detail' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Focus connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear focus', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear focus', exact: true }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Connections' })).toBeVisible();
  await page.screenshot({ path: path.resolve('.data/screenshots/graph-list.png'), fullPage: true });
  await page.getByRole('button', { name: 'Globe', exact: true }).click();
  await expect(stage.locator('canvas')).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Reset globe', exact: true }).click();
  await page.waitForTimeout(1400);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: path.resolve('.data/screenshots/globe-mobile.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: 'Connections & settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect through MCP' })).toBeVisible();
  await expect(page.getByText('search_knowledge', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: "A place for everything you're learning." }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: path.resolve('.data/screenshots/overview-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge library', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('globe respects reduced motion and keeps knowledge accessible when WebGL is unavailable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?view=graph');
  await expect(page.getByLabel('Resume animation')).toBeDisabled();
  const canvas = page.locator('.full-graph canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.full-graph .globe-stage')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const first = await canvas.screenshot();
  await page.waitForTimeout(300);
  expect((await canvas.screenshot()).equals(first)).toBe(true);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect((await canvas.screenshot()).equals(first)).toBe(false);
  await canvas.dispatchEvent('webglcontextlost');
  await expect(page.getByRole('columnheader', { name: 'Connections' })).toBeVisible();
  await page.getByRole('button', { name: 'Globe', exact: true }).click();
  await expect(page.locator('.full-graph .globe-stage')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.full-graph canvas')).toHaveCount(1);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).includes('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.reload();
  await expect(
    page.getByText(
      '3D rendering is unavailable in this browser. Your knowledge is available below.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Connections' })).toBeVisible();
  await expect(page.locator('.globe-list tbody tr')).not.toHaveCount(0);
});

test('Note Station archive preview, notebook selection, retained dates, attachment download and backup', async ({
  page,
}) => {
  await page.goto('/?view=sources');
  await page.getByRole('button', { name: 'Import source', exact: true }).click();
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await page.getByLabel('Source document', { exact: true }).setInputFiles({
    name: 'notestation.nsx',
    mimeType: 'application/octet-stream',
    buffer: await nsxFixture(),
  });
  await page.getByRole('button', { name: 'Preview archive', exact: true }).click();
  await expect(page.getByText('2 notes', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: 'Extract claim candidates for review' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Personal (1 notes)' }).uncheck();
  await page.screenshot({
    path: path.resolve('.data/screenshots/nsx-preview.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Import selected notebooks', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Source queued');
  await page.getByRole('button', { name: /Versuch α/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Retained source' });
  await expect(dialog.getByText('Note Station · Research / Labor', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Created 14 Nov 2023/)).toBeVisible();
  await expect(
    dialog.getByText('Original tags: Workshop, Material', { exact: true }),
  ).toBeVisible();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('link', { name: /Messung ä.txt/ }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('Messung ä.txt');
  expect(await readFile((await download.path())!)).toEqual(media);
  await page.screenshot({ path: path.resolve('.data/screenshots/nsx-source.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
  await expect(page.locator('.library-source-card').filter({ hasText: 'Versuch α' })).toBeVisible();
  await page.getByRole('button', { name: 'Imported notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search library', exact: true }).fill('LabNeedle');
  await expect(page.locator('.library-source-card')).toHaveCount(1);
  await page.locator('.library-source-card').click();
  await page.getByRole('button', { name: 'Show connections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Clear focus', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear focus', exact: true }).click();
  await page.getByLabel('Graph notebook or project').selectOption('Labor');
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(
    page.locator('.globe-list').getByRole('button', { name: 'Versuch α', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connections & settings', exact: true }).click();
  const backupPending = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export backup', exact: true }).click();
  const backup = await backupPending;
  expect(backup.suggestedFilename()).toMatch(/\.zip$/);
  expect((await readFile((await backup.path())!)).subarray(0, 2).toString()).toBe('PK');
});

test('capture, search, inspect, edit, archive, restore, and forget a note', async ({ page }) => {
  const marker = `Observation-${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Capture an idea' }).click();
  await page.getByLabel('Title', { exact: true }).fill(marker);
  await page
    .getByLabel('Your knowledge', { exact: true })
    .fill('WorkshopStarlight is my test observation with a reproducible setup.');
  await page.getByLabel('Topics', { exact: true }).fill('Workshop, Tests');
  await page.getByLabel('Project', { exact: true }).fill('Spike validation');
  await page.getByRole('button', { name: 'Save knowledge', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Knowledge saved');
  await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Search library', exact: true })
    .fill('WorkshopStarlight');
  await page.getByRole('button', { name: new RegExp(marker) }).click();
  const dialog = page.getByRole('dialog', { name: 'Knowledge detail' });
  await expect(dialog.getByRole('heading', { name: marker, exact: true })).toBeVisible();
  await expect(dialog.getByText('Self Reported', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByLabel('Your knowledge', { exact: true })
    .fill('WorkshopStarlight is my revised observation after checking the material.');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Version 2', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Archived', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore knowledge', exact: true }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Forget this item', exact: true }).click();
  await page.getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('No accepted knowledge found', { exact: true })).toBeVisible();
});

test('import Markdown, review cited candidates, verify, and inspect retained source', async ({
  page,
}) => {
  const marker = `Imported-${Date.now()}`;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByRole('button', { name: 'Import source', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(marker);
  await page.getByRole('button', { name: 'Upload file', exact: true }).click();
  await page.getByLabel('Source document', { exact: true }).setInputFiles({
    name: 'spike.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Checked experiments\n\nSilverWorkshop observations should include the material, changed variable, and measured outcome.\n\n# Evidence\n\nA repeatable experiment has a retained setup and an explicitly recorded observation.',
    ),
  });
  await page.getByLabel('Topics', { exact: true }).fill('Experiments');
  await page.getByRole('button', { name: 'Import source', exact: true }).last().click();
  await expect(page.getByRole('status')).toContainText('Source queued');
  await expect(page.getByRole('button', { name: new RegExp(marker) })).toBeVisible();
  await page.getByRole('button', { name: 'Review queue', exact: false }).first().click();
  await page.getByRole('button', { name: /SilverWorkshop observations should/ }).click();
  const detail = page.getByRole('dialog', { name: 'Knowledge detail' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Candidate', { exact: true })).toBeVisible();
  await expect(detail.getByText('Cited', { exact: true })).toBeVisible();
  await expect(detail.getByText('Not yet verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept knowledge', exact: true }).click();
  await page
    .getByLabel('Review rationale', { exact: true })
    .fill('Useful experiment guidance; keeping it for review.');
  await page.getByRole('button', { name: 'Confirm accept', exact: true }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByText('Not yet verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verify against evidence', exact: true }).click();
  await page
    .getByLabel('Review rationale', { exact: true })
    .fill('Checked the exact retained source passage and experiment context.');
  await page.getByRole('button', { name: 'Confirm verify', exact: true }).click();
  await expect(page.getByText('Current', { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.resolve('.data/screenshots/knowledge-evidence.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'View retained source', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Retained source' })).toBeVisible();
  await expect(page.getByRole('heading', { name: marker, exact: true })).toBeVisible();
  await expect(
    page.getByText(
      'SilverWorkshop observations should include the material, changed variable, and measured outcome.',
      { exact: true },
    ),
  ).toBeVisible();
});
