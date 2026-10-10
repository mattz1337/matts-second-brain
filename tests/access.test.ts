import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService } from '../server/service.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/password.js';
import { loadAccess, type AccessOptions } from '../server/access.js';

const origin = 'https://brain.example.test';
const password = 'Owner fixture password 2026';
const keys = {
  session: 'legacy-cookie',
  assistant: 'assistant-fixture-token',
  reader: 'reader-fixture-token',
};
let db: DB, service: BrainService, options: AccessOptions;
beforeAll(async () => {
  db = await openDatabase();
  service = new BrainService(db);
  options = { mode: 'password', publicOrigin: origin, passwordHash: await hashPassword(password) };
});
afterAll(async () => {
  await db.close();
});
const headers = { Host: 'brain.example.test', Origin: origin };
const cookie = (response: request.Response) =>
  String(response.headers['set-cookie'][0]).split(';')[0];

describe('password-protected NAS access', () => {
  it('requires login, issues secure cookies, rotates and revokes sessions, and advertises the HTTPS MCP URL', async () => {
    const app = createApp(service, keys, 4310, options);
    expect((await request(app).get('/api/session').set(headers)).body).toEqual({
      mode: 'password',
      authenticated: false,
    });
    expect((await request(app).post('/api/session').set(headers).send({})).status).toBe(401);
    expect((await request(app).get('/api/dashboard').set(headers)).status).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/dashboard')
          .set(headers)
          .set('Cookie', `orbit_session=${keys.session}`)
      ).status,
    ).toBe(401);
    const first = await request(app).post('/api/session').set(headers).send({ password });
    expect(first.status).toBe(200);
    expect(first.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(first.headers['set-cookie'][0]).toMatch(/Secure/);
    expect(first.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', cookie(first))).status,
    ).toBe(200);
    const integrations = await request(app)
      .get('/api/integrations')
      .set(headers)
      .set('Cookie', cookie(first));
    expect(integrations.body.endpoint).toBe(`${origin}/mcp`);
    const second = await request(app)
      .post('/api/session')
      .set(headers)
      .set('Cookie', cookie(first))
      .send({ password });
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', cookie(first))).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .delete('/api/session')
          .set({ Host: headers.Host })
          .set('Cookie', cookie(second))
      ).status,
    ).toBe(403);
    expect(
      (await request(app).delete('/api/session').set(headers).set('Cookie', cookie(second))).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', cookie(second))).status,
    ).toBe(401);
  });
  it('expires server-side sessions and throttles failed logins without trusting spoofed client IPs', async () => {
    let now = Date.now();
    const app = createApp(service, keys, 4310, { ...options, sessionTtlMs: 1000, now: () => now });
    const login = await request(app).post('/api/session').set(headers).send({ password });
    now += 1001;
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', cookie(login))).status,
    ).toBe(401);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request(app)
            .post('/api/session')
            .set(headers)
            .set('X-Forwarded-For', `10.0.0.${i}`)
            .send({ password: 'incorrect password' })
        ).status,
      ).toBe(401);
    expect((await request(app).post('/api/session').set(headers).send({ password })).status).toBe(
      429,
    );
    now += 15 * 60 * 1000;
    expect((await request(app).post('/api/session').set(headers).send({ password })).status).toBe(
      200,
    );
  });
  it('rejects hostile hosts and origins while preserving bearer scope restrictions', async () => {
    const app = createApp(service, keys, 4310, options);
    expect(
      (
        await request(app)
          .get('/api/session')
          .set('Host', 'attacker.test')
          .set('X-Forwarded-Host', headers.Host)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/api/session')
          .set('Host', headers.Host)
          .set('Origin', 'https://attacker.test')
          .send({ password })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/session').set('Host', headers.Host).send({ password })).status,
    ).toBe(403);
    expect((await request(app).get('/api/health').set('Host', '127.0.0.1:4310')).status).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/dashboard')
          .set('Host', headers.Host)
          .set('Authorization', `Bearer ${keys.reader}`)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/integrations')
          .set('Host', headers.Host)
          .set('Authorization', `Bearer ${keys.assistant}`)
      ).status,
    ).toBe(403);
    const denied = await request(app)
      .post('/api/tools/add_knowledge')
      .set('Host', headers.Host)
      .set('Authorization', `Bearer ${keys.reader}`)
      .send({
        title: 'Denied',
        statement: 'Readers cannot write.',
        idempotency_key: crypto.randomUUID(),
      });
    expect(denied.status).toBe(403);
  });
  it('rejects unsafe server configuration and loads a mounted hash without plaintext credentials', async () => {
    await expect(loadAccess('0.0.0.0', {})).rejects.toThrow('ACCESS_MODE=password');
    await expect(
      loadAccess('0.0.0.0', { ACCESS_MODE: 'password', APP_ORIGIN: 'http://brain.example.test' }),
    ).rejects.toThrow('HTTPS');
    await expect(
      loadAccess('0.0.0.0', { ACCESS_MODE: 'password', APP_ORIGIN: origin }),
    ).rejects.toThrow('OWNER_PASSWORD_HASH_FILE');
    const directory = await mkdtemp(path.resolve('.data/auth-test-'));
    const hashFile = path.join(directory, 'hash.json');
    await writeFile(hashFile, JSON.stringify(options.passwordHash));
    const configured = await loadAccess('0.0.0.0', {
      ACCESS_MODE: 'password',
      APP_ORIGIN: origin,
      OWNER_PASSWORD_HASH_FILE: hashFile,
      TRUST_PROXY: '172.17.0.1',
    });
    expect(configured.publicOrigin).toBe(origin);
    expect(configured.trustProxy).toEqual(['172.17.0.1']);
  });
});
