import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') {
  // Linux shell tests with a fake Docker executable; no daemon/socket is mounted.
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      '--workdir',
      '/workspace',
      '--mount',
      `type=bind,source=${root},target=/workspace`,
      process.env.NAS_TEST_IMAGE || 'orbit:nas-spike',
      'scripts/nas-update-smoke.mjs',
    ],
    { stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
mkdirSync(path.join(root, '.data'), { recursive: true });
const directory = mkdtempSync(path.join(root, '.data/nas-update-check-'));
const oldId = 'a'.repeat(64),
  newId = 'b'.repeat(64),
  otherId = 'c'.repeat(64);
const oldImage = `sha256:${'1'.repeat(64)}`,
  targetImage = `sha256:${'2'.repeat(64)}`;
const digest = `ghcr.io/mattz1337/orbit@sha256:${'3'.repeat(64)}`;
const fakeDocker = `#!/usr/bin/env node
const fs = await import('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
let args = process.argv.slice(2);
if (process.argv[1].endsWith('docker-compose')) args.unshift('compose');
const event = args.join(' ');
state.events.push(event);
const save = () => fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
const output = value => { save(); console.log(value); };
const die = message => { save(); console.error(message); process.exit(1); };
if (args[0] === 'compose') {
  if (args[1] === 'version') { if (state.scenario === 'legacy') die('Plugin unavailable'); output('Docker Compose v2'); }
  else if (args.includes('ps')) output(state.created ? '${newId}' : '${oldId}');
  else if (args.includes('config')) output(process.env.ORBIT_IMAGE || state.previous);
  else if (args.includes('stop')) { state.oldRunning = false; output('Stopped original'); }
  else if (args.includes('up')) { state.created = true; output('Created replacement'); }
  else if (args.includes('start')) { state.newRunning = true; output('Started replacement'); }
  else die('Unexpected compose arguments: ' + event);
} else if (args[0] === 'ps') output(state.scenario === 'shared' ? '${oldId}\\n${otherId}' : '${oldId}');
else if (args[0] === 'pull') { if (state.scenario === 'pull') die('Registry unavailable'); output('Pulled'); }
else if (args[0] === 'start') { state.oldRunning = true; output(args.at(-1)); }
else if (args[0] === 'stop') { state.newRunning = false; output(args.at(-1)); }
else if (args[0] === 'image' && args[1] === 'tag') output('Tagged');
else if (args[0] === 'image' && args[1] === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  if (format.includes('Architecture')) output(state.scenario === 'architecture' ? 'linux/arm64' : 'linux/amd64');
  else if (format.includes('RepoDigests')) output('${digest}');
  else if (format === '{{.Id}}') output(state.scenario === 'same' ? '${oldImage}' : '${targetImage}');
  else die('Unexpected image format: ' + format);
} else if (args[0] === 'inspect') {
  const format = args[args.indexOf('--format') + 1], id = args.at(-1), isNew = id === '${newId}';
  if (format === '{{.State.Running}}') output(String(isNew ? state.newRunning : state.oldRunning));
  else if (format === '{{.State.ExitCode}}') output('0');
  else if (format === '{{.Image}}') output(isNew ? '${targetImage}' : '${oldImage}');
  else if (format === '{{.Config.Image}}') output(state.previous);
  else if (format.includes('.State.Health')) output(state.scenario === 'health' ? 'unhealthy' : state.scenario === 'timeout' ? 'starting' : 'healthy');
  else if (format.includes('.Type')) output('bind');
  else if (format.includes('owner-password.json')) output(state.secret);
  else if (format.includes('"/data"')) output(isNew && state.scenario === 'mount' ? state.data + '-different' : state.data);
  else die('Unexpected container format: ' + format);
} else die('Unexpected command: ' + event);
`;

for (const scenario of [
  'success',
  'legacy',
  'same',
  'pull',
  'architecture',
  'backup',
  'mount',
  'health',
  'timeout',
  'shared',
  'lock',
]) {
  const project = path.join(directory, `${scenario} with spaces`),
    bin = path.join(project, 'bin');
  const data = path.join(project, 'data'),
    secret = path.join(project, 'secrets/owner-password.json');
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(data, 'postgres'), { recursive: true });
  mkdirSync(path.join(data, 'attachments'), { recursive: true });
  mkdirSync(path.dirname(secret), { recursive: true });
  writeFileSync(path.join(data, 'postgres/PG_VERSION'), '17');
  writeFileSync(path.join(data, 'attachments/fixture'), 'synthetic attachment');
  writeFileSync(path.join(data, 'credentials.json'), '{"synthetic":true}');
  writeFileSync(secret, '{"synthetic_hash":true}');
  writeFileSync(
    path.join(project, '.env'),
    'APP_ORIGIN=https://brain.example.com\nORBIT_IMAGE=orbit:nas-spike\nAPP_UID=1026\n',
  );
  writeFileSync(
    path.join(project, 'compose.synology.yml'),
    readFileSync(path.join(root, 'compose.synology.yml')),
  );
  for (const command of ['docker', 'docker-compose'])
    writeFileSync(path.join(bin, command), fakeDocker, { mode: 0o755 });
  writeFileSync(
    path.join(bin, 'tar'),
    '#!/bin/sh\n[ "$MOCK_SCENARIO" != backup ] || exit 1\nexec /bin/tar "$@"\n',
    { mode: 0o755 },
  );
  if (scenario === 'lock') mkdirSync(path.join(project, '.orbit-update.lock'));
  const stateFile = path.join(project, 'state.json');
  writeFileSync(
    stateFile,
    JSON.stringify({
      scenario,
      data,
      secret,
      previous: 'orbit:nas-spike',
      oldRunning: true,
      newRunning: false,
      created: false,
      events: [],
    }),
  );
  const result = spawnSync('sh', [path.join(root, 'deploy/update-nas.sh'), '0.2.0', project], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_STATE: stateFile,
      MOCK_SCENARIO: scenario,
      HEALTH_TIMEOUT: '0',
    },
  });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const output = result.stdout + result.stderr;
  const success = ['success', 'legacy', 'same'].includes(scenario);
  assert.equal(result.status, success ? 0 : 1, `${scenario}: ${output}`);
  if (['success', 'legacy'].includes(scenario)) {
    assert.match(readFileSync(path.join(project, '.env'), 'utf8'), new RegExp(digest));
    assert.ok(state.newRunning);
    const backup = path.join(
      project,
      '.orbit-backups',
      readdirSync(path.join(project, '.orbit-backups'))[0],
    );
    const archived = execFileSync('/bin/tar', ['-tzf', path.join(backup, 'data.tar.gz')], {
      encoding: 'utf8',
    });
    assert.match(archived, /postgres\/PG_VERSION/);
    assert.match(archived, /attachments\/fixture/);
    assert.match(archived, /credentials\.json/);
    assert.equal(
      readFileSync(path.join(backup, 'project.env'), 'utf8'),
      'APP_ORIGIN=https://brain.example.com\nORBIT_IMAGE=orbit:nas-spike\nAPP_UID=1026\n',
    );
    assert.equal(
      readFileSync(path.join(backup, 'owner-password.json'), 'utf8'),
      '{"synthetic_hash":true}',
    );
    execFileSync('sha256sum', ['-c', 'data.tar.gz.sha256'], { cwd: backup });
    assert.ok(
      state.events.findIndex((event) => event.startsWith('pull ')) <
        state.events.findIndex((event) => event.includes(' stop -t')),
    );
    assert.ok(
      state.events.findIndex((event) => event.includes('up --no-start')) <
        state.events.findIndex((event) => event.includes(' start orbit')),
    );
  } else if (scenario === 'backup') {
    assert.ok(state.oldRunning, 'Backup failure must restart the original image');
    assert.ok(!state.created);
    assert.match(readFileSync(path.join(project, '.env'), 'utf8'), /orbit:nas-spike/);
  } else if (['mount', 'health', 'timeout'].includes(scenario)) {
    assert.ok(state.created && !state.newRunning);
    assert.ok(
      !state.events.some((event) => event === `start ${oldId}`),
      'Never automatically run the old image after migration could have begun',
    );
    if (scenario === 'mount')
      assert.ok(!state.events.some((event) => event.includes(' start orbit')));
    assert.match(output, /no automatic data\/image rollback/);
  } else {
    assert.ok(state.oldRunning && !state.created);
  }
  assert.equal(existsSync(path.join(project, '.orbit-update.lock')), scenario === 'lock');
  assert.equal(
    readFileSync(path.join(data, 'attachments/fixture'), 'utf8'),
    'synthetic attachment',
  );
  console.log(`PASS: NAS updater ${scenario}`);
}
console.log('PASS: 11 isolated updater scenarios; no live database or Docker socket accessed.');
