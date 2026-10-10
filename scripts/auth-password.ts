import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashPassword } from '../server/password.js';

function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Run this command in an interactive terminal. Passwords are not accepted through command-line arguments.',
    );
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.off('data', read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const read = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && value.length < 512) value += character;
      }
    };
    process.stdin.on('data', read);
  });
}
try {
  const output = path.resolve(process.argv[2] || '.secrets/owner-password.json');
  const password = await hidden('Owner password (at least 12 characters; input is hidden): ');
  const confirm = await hidden('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords do not match.');
  const hashed = await hashPassword(password);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(hashed, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Password hash written to ${output}. Keep this file private.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not generate password hash.');
  process.exitCode = 1;
}
