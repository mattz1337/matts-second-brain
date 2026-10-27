import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Explicit local setup only. No Garmin files/databases are modified and no
// private data or model requests are sent to an inference provider.
const execute = promisify(execFile);
const run = async (...args) =>
  (await execute('docker', args, { timeout: 60000, maxBuffer: 2e6 })).stdout.trim();
const root = process.cwd();
const source = process.argv[2] || 'garmin-graphify-chat-1';
const description = JSON.parse(await run('inspect', source))[0];
if (!description?.State?.Running) throw Error('Start the existing Garmin chat container first.');
const directory = path.join(root, '.data');
await mkdir(directory, { recursive: true });
const secretPath = path.join(directory, 'garmin-bridge.json');
let secret;
try {
  secret = JSON.parse(await readFile(secretPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secret = { token: randomBytes(32).toString('hex') };
  await writeFile(secretPath, JSON.stringify(secret), { mode: 0o600 });
}
// Windows bind mounts and the non-root bridge must both be able to read the
// token. The parent .data directory is private; NAS uses its own Unix ownership.
await chmod(secretPath, 0o600);
const network = Object.keys(description.NetworkSettings.Networks)[0];
if (!network) throw Error('The Garmin chat container has no data network.');
const name = 'orbit-garmin-bridge';
const existing = await run('ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}');
if (existing) {
  const prior = JSON.parse(await run('inspect', name))[0];
  if (prior.Config.Labels?.['orbit.role'] !== 'garmin-readonly-bridge')
    throw Error('A different container already uses the bridge name.');
  await run('rm', '-f', name);
}
await run(
  'run',
  '-d',
  '--name',
  name,
  '--label',
  'orbit.role=garmin-readonly-bridge',
  '--restart',
  'unless-stopped',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--memory',
  '384m',
  '--network',
  network,
  '-p',
  '127.0.0.1:4312:8082',
  '--volumes-from',
  `${source}:ro`,
  '--tmpfs',
  '/bridge-state:rw,nosuid,nodev,uid=65534,gid=65534,size=128m',
  '--mount',
  `type=bind,source=${path.join(root, 'connectors/garmin_bridge.py')},target=/orbit-bridge.py,readonly`,
  '--mount',
  `type=bind,source=${secretPath},target=/run/secrets/garmin-bridge.json,readonly`,
  '-e',
  'BRIDGE_STATE=/bridge-state',
  '--entrypoint',
  'python',
  description.Image,
  '/orbit-bridge.py',
);
let ready = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try {
    if ((await fetch('http://127.0.0.1:4312/healthz', { signal: AbortSignal.timeout(1000) })).ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!ready) throw Error('Bridge did not start. Inspect its local Docker logs.');
const configPath = path.join(directory, 'assistant-config.json');
let config = {};
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Reuse only the model configuration, never Garmin login/database credentials.
const environment = Object.fromEntries(
  (description.Config.Env || []).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);
config = {
  provider: 'builtin',
  model: 'google/gemini-3.1-flash-lite',
  daily_budget: 0.25,
  daily_calls: 60,
  ...config,
  garmin_url: 'http://127.0.0.1:4312',
  garmin_token: secret.token,
};
if (!config.api_key && environment.OPENROUTER_API_KEY) {
  config.api_key = environment.OPENROUTER_API_KEY;
  config.provider = 'openrouter';
  config.model = environment.CHAT_MODEL || config.model;
}
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await chmod(configPath, 0o600);
console.log(
  JSON.stringify({
    bridge: 'http://127.0.0.1:4312',
    readOnly: true,
    modelConfigured: Boolean(config.api_key),
    model: config.model,
    cloudRequestsSent: 0,
  }),
);
