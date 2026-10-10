import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, scrypt } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer, request as forward } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Uses synthetic data and its own volume; never mounts the desktop database.
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute('docker', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const image =
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) || 'orbit:nas-spike';
const suffix = randomBytes(6).toString('hex');
const container = `orbit-check-${suffix}`,
  volume = `${container}-data`;
await mkdir(path.resolve('.data'), { recursive: true });
const directory = await mkdtemp(path.resolve('.data/container-check-'));
const password = randomBytes(32).toString('hex'),
  salt = randomBytes(16);
const key = await promisify(scrypt)(password, salt, 64, {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const secret = path.join(directory, 'owner-password.json');
await writeFile(
  secret,
  JSON.stringify({
    algorithm: 'scrypt-v1',
    salt: salt.toString('base64url'),
    key: key.toString('base64url'),
  }),
  // Synthetic hash only: Linux runner UID can differ from the container UID.
  // The enclosing temporary directory remains private.
  { mode: 0o644 },
);
const origin = 'https://brain.container.test';
let base, cookie, reader;
let upstreamBase;
// Emulate DSM forwarding the public Host header. Node fetch derives Host from
// its URL, so a proxy is needed rather than a custom fetch Host header.
const proxy = createServer((req, res) => {
  const upstream = forward(
    `${upstreamBase}${req.url}`,
    {
      method: req.method,
      headers: { ...req.headers, host: 'brain.container.test' },
    },
    (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});
async function request(route, { body, token, unauthenticated = false, ...options } = {}) {
  return fetch(`${base}${route}`, {
    ...options,
    headers: {
      Host: 'brain.container.test',
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(!unauthenticated && cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await request('/api/health', { unauthenticated: true })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Container did not become ready.');
}
async function login() {
  const response = await request('/api/session', {
    method: 'POST',
    body: { password },
    unauthenticated: true,
  });
  assert.equal(response.status, 200);
  const value = response.headers.get('set-cookie');
  assert.match(value, /Secure/);
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Strict/);
  cookie = value.split(';')[0];
}
try {
  await docker('volume', 'create', volume);
  await docker(
    'run',
    '-d',
    '--name',
    container,
    '--init',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=128m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--cpus',
    '2',
    '--memory',
    '2g',
    '-p',
    '127.0.0.1::4310',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    '--mount',
    `type=bind,source=${secret},target=/run/secrets/owner-password.json,readonly`,
    '-e',
    `APP_ORIGIN=${origin}`,
    '-e',
    'OWNER_PASSWORD_HASH_FILE=/run/secrets/owner-password.json',
    '-e',
    'EMBEDDINGS=lexical',
    image,
  );
  const port = (await docker('port', container, '4310/tcp')).split(':').at(-1);
  upstreamBase = `http://127.0.0.1:${port}`;
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${proxy.address().port}`;
  await ready();
  console.log('Container ready through the reverse proxy.');
  assert.equal((await request('/', { unauthenticated: true })).status, 200);
  assert.equal((await request('/api/dashboard', { unauthenticated: true })).status, 401);
  assert.equal(
    (
      await request('/api/session', {
        method: 'POST',
        body: { password: 'incorrect password' },
        unauthenticated: true,
      })
    ).status,
    401,
  );
  await login();
  console.log('Password login verified.');
  const captured = await request('/api/knowledge', {
    method: 'POST',
    body: {
      title: 'Container persistence observation',
      statement: 'Synthetic data persists across a clean container restart.',
      idempotency_key: randomBytes(16).toString('hex'),
    },
  });
  assert.equal(captured.status, 201);
  const knowledge = await captured.json();
  const integrations = await (await request('/api/integrations')).json();
  assert.equal(integrations.endpoint, `${origin}/mcp`);
  reader = integrations.reader_token;
  assert.equal(typeof reader, 'string');
  const client = new Client({ name: 'container-check', version: '1' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Host: 'brain.container.test', Authorization: `Bearer ${reader}` },
        },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 14);
    assert.equal(
      (
        await client.callTool({
          name: 'search_knowledge',
          arguments: { query: 'Container persistence' },
        })
      ).isError,
      undefined,
    );
    const denied = await client.callTool({
      name: 'add_knowledge',
      arguments: {
        title: 'Denied',
        statement: 'Reader tokens cannot add knowledge.',
        idempotency_key: randomBytes(16).toString('hex'),
      },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
  }
  console.log('Scoped MCP verified.');
  const queued = await request('/api/imports', {
    method: 'POST',
    body: {
      title: 'Container import fixture',
      text: 'The imported document is retained with its original source. It provides evidence for durable indexing.',
      idempotency_key: randomBytes(16).toString('hex'),
    },
  });
  assert.equal(queued.status, 202);
  const job = await queued.json();
  let completed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await (await request(`/api/imports/${job.id}`)).json();
    if (status.status === 'completed') {
      completed = true;
      break;
    }
    assert.notEqual(status.status, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(completed, 'Background import completes');
  console.log('Background import completed.');
  const exported = await request('/api/export/bundle');
  assert.equal(exported.status, 200);
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  await writeFile(path.join(directory, 'synthetic-backup.zip'), bytes);
  await docker('stop', '--time', '150', container);
  assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', container), '0');
  const inspection = await docker(
    'run',
    '--rm',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    '--entrypoint',
    'node',
    image,
    'build/scripts/inspect-db.js',
    '/data/postgres',
    '--stopped',
  );
  assert.match(inspection, /Inspection copy:/);
  assert.match(inspection, /sources/);
  console.log('Clean shutdown and copied SQL inspection verified.');
  await docker('start', container);
  const restartedPort = (await docker('port', container, '4310/tcp')).split(':').at(-1);
  upstreamBase = `http://127.0.0.1:${restartedPort}`;
  await ready();
  assert.equal((await request('/api/dashboard')).status, 401);
  if (process.argv.includes('--with-model')) {
    const modelCheck = `
      import assert from 'node:assert/strict';
      import { openDatabase } from './build/server/db.js';
      import { Embeddings } from './build/server/embeddings.js';
      const db = await openDatabase();
      try {
        const model = new Embeddings(db, 'local', 'Xenova/multilingual-e5-small', '/models');
        await model.initialize();
        assert.equal(model.state, 'ready', model.error || 'Model not ready');
        const query = await model.embed('How can I deploy containers on a Synology NAS?', true);
        const related = await model.embed('Synology Container Manager runs Docker containers on a NAS.');
        const unrelated = await model.embed('A cake recipe uses eggs, flour, sugar and butter.');
        assert.equal(query.length, 384);
        const cosine = vector => vector.reduce((sum, value, index) => sum + value * query[index], 0);
        assert.ok(cosine(related) > cosine(unrelated));
        console.log('PASS: offline Linux CPU inference, 384-dimensional embeddings, semantic ranking, two inference threads.');
      } finally { await db.close(); }
    `;
    console.log(
      await docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=128m',
        '--cpus',
        '2',
        '--memory',
        '2g',
        '--mount',
        `type=bind,source=${path.resolve('.data/models')},target=/models,readonly`,
        '--entrypoint',
        'node',
        image,
        '--input-type=module',
        '-e',
        modelCheck,
      ),
    );
  }
  await login();
  assert.equal(
    (await (await request(`/api/knowledge/${knowledge.id}`)).json()).title,
    'Container persistence observation',
  );
  assert.equal((await (await request('/api/integrations')).json()).reader_token, reader);
  assert.equal(
    (await request('/api/dashboard', { token: reader, unauthenticated: true })).status,
    200,
  );
  await request('/api/session', { method: 'DELETE' });
  assert.equal((await request('/api/dashboard')).status, 401);
  console.log(
    'PASS: Linux image, non-root read-only runtime, login/logout, REST + scoped MCP, background import, backup, SQL inspection, clean shutdown, persistent data and tokens.',
  );
} catch (error) {
  console.error(
    await docker('logs', '--tail', '30', container).catch(() => 'No container logs available.'),
  );
  throw error;
} finally {
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(() => resolve()));
  await docker('stop', '--time', '150', container).catch(() => {});
  await docker('rm', container).catch(() => {});
  await docker('volume', 'rm', volume).catch(() => {});
}
