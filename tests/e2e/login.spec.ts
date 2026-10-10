import { test, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { openDatabase } from '../../server/db.js';
import { BrainService } from '../../server/service.js';
import { createApp } from '../../server/app.js';
import { hashPassword } from '../../server/password.js';

test.use({ ignoreHTTPSErrors: true });
test('NAS HTTPS login, reload, logout and expired sessions protect the browser workspace', async ({
  page,
}) => {
  const directory = await mkdtemp(path.resolve('.data/e2e-https-'));
  const key = path.join(directory, 'key.pem'),
    cert = path.join(directory, 'cert.pem');
  const gitOpenSSL = 'C:/Program Files/Git/usr/bin/openssl.exe';
  const openssl = existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl';
  execFileSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore', timeout: 10000 },
  );
  const db = await openDatabase();
  const service = new BrainService(db);
  let app: Express;
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (req, res) => app(req, res),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const password = 'NAS browser fixture password';
  let now = Date.now();
  app = createApp(
    service,
    { session: 'legacy-fixture', reader: 'reader-fixture', assistant: 'assistant-fixture' },
    4310,
    {
      mode: 'password',
      publicOrigin: origin,
      passwordHash: await hashPassword(password),
      now: () => now,
    },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/?view=settings`);
    await expect(page).toHaveTitle("Orbit — Matt's second brain");
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await page.screenshot({
      path: path.resolve('.data/screenshots/nas-login.png'),
      fullPage: true,
    });
    await page.getByLabel('Password', { exact: true }).fill('wrong password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Incorrect password');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connect through MCP' })).toBeVisible();
    await expect(page.getByText('Protected access', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Server endpoint')).toHaveValue(`${origin}/mcp`);
    await page.getByLabel('New note', { exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('NAS authenticated observation');
    await page
      .getByLabel('Your knowledge', { exact: true })
      .fill('Only the signed-in owner can capture this note.');
    await page.getByRole('button', { name: 'Save knowledge', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Knowledge saved');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Connect through MCP' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByLabel('Sign out', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await page.screenshot({
      path: path.resolve('.data/screenshots/nas-login-mobile.png'),
      fullPage: true,
    });
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByLabel('Sign out', { exact: true })).toBeVisible();
    now += 9 * 60 * 60 * 1000;
    await page.getByLabel('Toggle navigation').click();
    await page.getByRole('button', { name: 'Knowledge library', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
