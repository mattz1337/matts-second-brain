import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { openDatabase, type DB } from '../server/db.js';
import { BrainService } from '../server/service.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/password.js';
import { loadAccess, BrowserSessions, type AccessOptions } from '../server/access.js';

const origin = 'http://192.168.178.124:4310';
const password = 'Synthetic LAN password 2026';
const keys = {
  session: 'legacy-cookie',
  assistant: 'fixture-contributor',
  reader: 'fixture-reader',
};
let directory: string, db: DB, service: BrainService, options: AccessOptions;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orbit-lan-access-'));
  if (!directory.startsWith(path.resolve(tmpdir()) + path.sep))
    throw Error('Unsafe test directory');
  db = await openDatabase(directory);
  service = new BrainService(db, undefined, path.join(directory, 'files'));
  const hashFile = path.join(directory, 'owner.json');
  await writeFile(hashFile, JSON.stringify(await hashPassword(password)));
  options = await loadAccess('0.0.0.0', {
    ACCESS_MODE: 'password',
    ALLOW_LAN_HTTP: 'true',
    APP_ORIGIN: origin,
    OWNER_PASSWORD_HASH_FILE: hashFile,
  });
});
afterAll(async () => {
  await db?.close();
});
const headers = { Host: '192.168.178.124:4310', Origin: origin };

describe('explicit password-protected LAN HTTP', () => {
  it('keeps HTTPS mandatory by default and restricts opt-in HTTP to private IPv4 literals', async () => {
    const base = {
      ACCESS_MODE: 'password',
      OWNER_PASSWORD_HASH_FILE: path.join(directory, 'owner.json'),
    };
    await expect(loadAccess('0.0.0.0', { ...base, APP_ORIGIN: origin })).rejects.toThrow('HTTPS');
    for (const address of [
      'http://example.com:4310',
      'http://8.8.8.8:4310',
      'http://127.0.0.1:4310',
      'http://169.254.169.254:4310',
      'http://192.168.178.124:4310/path',
    ]) {
      await expect(
        loadAccess('0.0.0.0', { ...base, ALLOW_LAN_HTTP: 'true', APP_ORIGIN: address }),
      ).rejects.toThrow('APP_ORIGIN');
    }
    for (const host of ['10.0.0.12', '172.16.1.12', '192.168.178.124']) {
      expect(
        (
          await loadAccess('0.0.0.0', {
            ...base,
            ALLOW_LAN_HTTP: 'true',
            APP_ORIGIN: `http://${host}:4310`,
          })
        ).allowLanHttp,
      ).toBe(true);
    }
    expect(() => new BrowserSessions({ ...options, allowLanHttp: false })).toThrow('HTTPS');
    await expect(
      loadAccess('0.0.0.0', {
        ACCESS_MODE: 'password',
        ALLOW_LAN_HTTP: 'true',
        APP_ORIGIN: origin,
      }),
    ).rejects.toThrow('OWNER_PASSWORD_HASH_FILE');
  });
  it('requires the owner password, supports HTTP cookies, and revokes the session on logout', async () => {
    const app = createApp(service, keys, 4310, options);
    expect((await request(app).get('/api/dashboard').set(headers)).status).toBe(401);
    expect(
      (await request(app).post('/api/session').set(headers).send({ password: 'incorrect' })).status,
    ).toBe(401);
    const login = await request(app).post('/api/session').set(headers).send({ password });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie'][0]);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/; Secure(?:;|$)/);
    const session = cookie.split(';')[0];
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', session)).status,
    ).toBe(200);
    const integrations = await request(app)
      .get('/api/integrations')
      .set(headers)
      .set('Cookie', session);
    expect(integrations.body.endpoint).toBe(`${origin}/mcp`);
    expect(integrations.body.access_mode).toBe('password');
    expect(
      (await request(app).delete('/api/session').set(headers).set('Cookie', session)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/dashboard').set(headers).set('Cookie', session)).status,
    ).toBe(401);
  });
  it('rejects hostile hosts, wrong ports, cross-origin login, and legacy owner cookies', async () => {
    const app = createApp(service, keys, 4310, options);
    for (const host of ['attacker.test', '192.168.178.124:443', '192.168.178.125:4310']) {
      expect((await request(app).get('/api/session').set('Host', host)).status).toBe(403);
    }
    expect(
      (
        await request(app)
          .post('/api/session')
          .set('Host', headers.Host)
          .set('Origin', 'http://attacker.test')
          .send({ password })
      ).status,
    ).toBe(403);
    expect(
      (await request(app).post('/api/session').set('Host', headers.Host).send({ password })).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/api/dashboard')
          .set(headers)
          .set('Cookie', `orbit_session=${keys.session}`)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get('/api/assistant/config')
          .set(headers)
          .set('Authorization', `Bearer ${keys.reader}`)
      ).status,
    ).toBe(403);
  });
  it('retains Secure cookies for HTTPS even when the LAN opt-in flag is set', async () => {
    const app = createApp(service, keys, 4310, {
      ...options,
      publicOrigin: 'https://orbit.example.test',
    });
    const login = await request(app)
      .post('/api/session')
      .set({ Host: 'orbit.example.test', Origin: 'https://orbit.example.test' })
      .send({ password });
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'][0])).toContain('; Secure');
  });
});
