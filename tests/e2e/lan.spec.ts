import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { openDatabase } from '../../server/db.js';
import { BrainService } from '../../server/service.js';
import { createApp } from '../../server/app.js';
import { hashPassword } from '../../server/password.js';

test('direct LAN HTTP supports password login, capture, assistant UUIDs, reload and logout in an insecure browser context', async ({
  browser,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'orbit-lan-browser-'));
  if (!directory.startsWith(path.resolve(tmpdir()) + path.sep))
    throw Error('Unsafe test directory');
  const db = await openDatabase(directory);
  const service = new BrainService(db, undefined, path.join(directory, 'files'));
  let app: Express;
  // A local HTTP proxy transports a private-IP URL without reaching a LAN host.
  // Chromium still sees a real non-loopback HTTP origin (no secure-context override).
  const server = createServer((req, res) => {
    req.url =
      new URL(req.url || '/', 'http://192.168.178.124').pathname +
      new URL(req.url || '/', 'http://192.168.178.124').search;
    app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://192.168.178.124:${port}`;
  const password = 'Synthetic LAN browser password';
  app = createApp(
    service,
    { session: 'legacy-fixture', reader: 'reader-fixture', assistant: 'writer-fixture' },
    port,
    {
      mode: 'password',
      publicOrigin: origin,
      allowLanHttp: true,
      passwordHash: await hashPassword(password),
    },
  );
  const context = await browser.newContext({ proxy: { server: `http://127.0.0.1:${port}` } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/?view=settings`);
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect through MCP' })).toBeVisible();
    await expect(page.getByText('LAN HTTP access', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Server endpoint')).toHaveValue(`${origin}/mcp`);
    const cookie = (await context.cookies()).find((value) => value.name === 'orbit_session');
    expect(cookie?.secure).toBe(false);
    expect(cookie?.httpOnly).toBe(true);
    await page.getByLabel('New note', { exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('LAN capture fixture');
    await page
      .getByLabel('Your knowledge', { exact: true })
      .fill('LanFixtureLearning captures a note through a private HTTP origin.');
    await page.getByRole('button', { name: 'Save knowledge', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Knowledge saved');
    await page.goto(`${origin}/?view=assistant`);
    await expect(page.getByRole('heading', { name: 'Ask Orbit', exact: true })).toBeVisible();
    await page.getByLabel('Message Orbit').fill('LanFixtureLearning');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: /\[K1\].*LAN capture fixture/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: /\[K1\].*LAN capture fixture/ })).toBeVisible();
    await page.getByLabel('Sign out', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await app.locals.assistant.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
