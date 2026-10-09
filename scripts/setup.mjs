import { spawnSync } from 'node:child_process';

// Override a global npm platform setting using the actual machine, without changing that setting.
// This script needs only Node/npm and works before the project dependencies have been installed.
if (!process.env.npm_execpath) {
  console.error('Run this installer with npm run setup.');
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [
    process.env.npm_execpath,
    'ci',
    '--include=optional',
    `--os=${process.platform}`,
    `--cpu=${process.arch}`,
    '--no-audit',
    '--no-fund',
  ],
  { stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
