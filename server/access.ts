import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parsePasswordHash, verifyPassword, type PasswordHash } from './password.js';
import { AppError } from './errors.js';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export interface AccessOptions {
  mode: 'local' | 'password';
  publicOrigin?: string;
  allowLanHttp?: boolean;
  passwordHash?: PasswordHash;
  trustProxy?: string[];
  sessionTtlMs?: number;
  now?: () => number;
}
export function validatePublicOrigin(value: string, allowLanHttp = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Password access requires an APP_ORIGIN URL.');
  }
  const privateHttp =
    allowLanHttp &&
    url.protocol === 'http:' &&
    isIP(url.hostname) === 4 &&
    ipaddr.parse(url.hostname).range() === 'private';
  if (
    (url.protocol !== 'https:' && !privateHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'APP_ORIGIN must be HTTPS, or a private IPv4 HTTP origin with ALLOW_LAN_HTTP=true, without a path, query, or credentials.',
    );
  }
  return url;
}
export async function loadAccess(host: string, env = process.env): Promise<AccessOptions> {
  const mode = env.ACCESS_MODE || 'local';
  if (mode !== 'local' && mode !== 'password')
    throw new Error('ACCESS_MODE must be local or password.');
  if (mode === 'local') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host))
      throw new Error('Network listening requires ACCESS_MODE=password.');
    if (env.APP_ORIGIN) throw new Error('APP_ORIGIN requires ACCESS_MODE=password.');
    return { mode };
  }
  const allowLanHttp = env.ALLOW_LAN_HTTP === 'true';
  const url = validatePublicOrigin(env.APP_ORIGIN || '', allowLanHttp);
  if (!env.OWNER_PASSWORD_HASH_FILE)
    throw new Error('OWNER_PASSWORD_HASH_FILE is required for password access.');
  const passwordHash = parsePasswordHash(
    JSON.parse(await readFile(env.OWNER_PASSWORD_HASH_FILE, 'utf8')),
  );
  return {
    mode,
    publicOrigin: url.origin,
    allowLanHttp,
    passwordHash,
    trustProxy:
      env.TRUST_PROXY?.split(',')
        .map((x) => x.trim())
        .filter(Boolean) || [],
  };
}

export class BrowserSessions {
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  private inflight = 0;
  private now: () => number;
  readonly ttl: number;
  constructor(public options: AccessOptions) {
    if (options.mode === 'password' && (!options.passwordHash || !options.publicOrigin))
      throw new Error('Password access needs a password hash and public origin.');
    if (options.mode === 'password')
      validatePublicOrigin(options.publicOrigin!, options.allowLanHttp);
    this.now = options.now || Date.now;
    this.ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  }
  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
  valid(token: string) {
    const digest = this.digest(token);
    const expiry = this.sessions.get(digest);
    if (!expiry) return false;
    if (expiry <= this.now()) {
      this.sessions.delete(digest);
      return false;
    }
    return true;
  }
  logout(token: string) {
    this.sessions.delete(this.digest(token));
  }
  async login(password: string, ip: string): Promise<string> {
    const now = this.now();
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const attempt = this.attempts.get(ip) || { count: 0, until: now + 15 * 60 * 1000 };
    if (attempt.count >= 5 || this.inflight >= 4)
      throw new AppError(429, 'login_limited', 'Too many login attempts. Try again in 15 minutes.');
    if (this.attempts.size >= 1024 && !this.attempts.has(ip))
      throw new AppError(429, 'login_limited', 'Login is temporarily busy. Try again later.');
    attempt.count++;
    this.attempts.set(ip, attempt);
    this.inflight++;
    let matched: boolean;
    try {
      matched = await verifyPassword(password, this.options.passwordHash!);
    } finally {
      this.inflight--;
    }
    if (!matched) throw new AppError(401, 'invalid_password', 'Incorrect password.');
    this.attempts.delete(ip);
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(this.digest(token), this.now() + this.ttl);
    return token;
  }
}
