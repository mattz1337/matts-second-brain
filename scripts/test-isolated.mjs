import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const directory = await mkdtemp(path.join(tmpdir(), 'orbit-test-suite-'));
if (!directory.startsWith(path.resolve(tmpdir()) + path.sep)) throw Error('Unsafe test directory');
if (!process.env.npm_execpath) throw Error('Run through npm run test:isolated.');
console.log(`Isolated test storage: ${directory}`);
const child = spawn(
  process.execPath,
  [process.env.npm_execpath, 'test', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, DATA_DIR: directory, EMBEDDINGS: 'lexical', SEED_DEMO: 'false' },
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
