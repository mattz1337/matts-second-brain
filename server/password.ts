import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
export interface PasswordHash {
  algorithm: 'scrypt-v1';
  salt: string;
  key: string;
}
export function parsePasswordHash(value: unknown): PasswordHash {
  const hash = value as Partial<PasswordHash> | null;
  if (
    !hash ||
    hash.algorithm !== 'scrypt-v1' ||
    !/^[\w-]{22}$/.test(hash.salt || '') ||
    !/^[\w-]{86}$/.test(hash.key || '')
  ) {
    throw new Error('Invalid owner password hash. Generate it with npm run auth:password.');
  }
  return hash as PasswordHash;
}
async function key(password: string, salt: string) {
  return await new Promise<Buffer>((resolve, reject) =>
    derive(
      password,
      Buffer.from(salt, 'base64url'),
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
}
export async function hashPassword(password: string): Promise<PasswordHash> {
  if (password.length < 12 || password.length > 512)
    throw new Error('Use an owner password between 12 and 512 characters.');
  const salt = randomBytes(16).toString('base64url');
  return { algorithm: 'scrypt-v1', salt, key: (await key(password, salt)).toString('base64url') };
}
export async function verifyPassword(password: string, hash: PasswordHash) {
  if (!password || password.length > 512) return false;
  return timingSafeEqual(await key(password, hash.salt), Buffer.from(hash.key, 'base64url'));
}
