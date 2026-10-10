import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import type { Actor } from '../shared/contracts.js';
import { owner } from './service.js';
import { AppError } from './errors.js';
import { BrowserSessions, type AccessOptions } from './access.js';

export interface Credentials {
  session: string;
  assistant: string;
  reader: string;
}
const equals = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function credentials(dataDir: string): Promise<Credentials> {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'credentials.json');
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const result = {
      session: randomBytes(32).toString('hex'),
      assistant: randomBytes(32).toString('hex'),
      reader: randomBytes(32).toString('hex'),
    };
    await writeFile(file, JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  }
}
declare global {
  namespace Express {
    interface Request {
      actor: Actor;
    }
  }
}
export function localGuard(port: number, access: AccessOptions = { mode: 'local' }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const host = req.hostname;
      const publicUrl = access.publicOrigin ? new URL(access.publicOrigin) : null;
      const allowed = publicUrl
        ? new Set([
            publicUrl.host,
            `${publicUrl.hostname}:443`,
            `127.0.0.1:${port}`,
            `localhost:${port}`,
          ]).has((req.get('host') || '').toLowerCase())
        : ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
      if (!allowed) throw new AppError(403, 'invalid_host', 'This host is not allowed.');
      const origin = req.get('origin');
      if (
        origin &&
        !new Set(
          publicUrl
            ? [publicUrl.origin]
            : [
                `http://127.0.0.1:${port}`,
                `http://localhost:${port}`,
                'http://127.0.0.1:5173',
                'http://localhost:5173',
              ],
        ).has(origin)
      )
        throw new AppError(403, 'invalid_origin', 'This origin is not allowed.');
      next();
    } catch (error) {
      next(error);
    }
  };
}
export function identify(keys: Credentials, requireBearer = false, sessions?: BrowserSessions) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const bearer = req.get('authorization')?.replace(/^Bearer /, '') || '';
    if (equals(bearer, keys.assistant))
      req.actor = { id: 'assistant', owner: false, scopes: ['brain:read', 'brain:write'] };
    else if (equals(bearer, keys.reader))
      req.actor = { id: 'reader', owner: false, scopes: ['brain:read'] };
    else if (
      !requireBearer &&
      (sessions?.options.mode === 'password'
        ? sessions.valid(String(req.cookies?.orbit_session || ''))
        : equals(String(req.cookies?.orbit_session || ''), keys.session))
    ) {
      if (!['GET', 'HEAD'].includes(req.method) && !req.get('origin')) {
        next(new AppError(403, 'origin_required', 'Browser writes require a same-origin request.'));
        return;
      }
      req.actor = owner;
    } else {
      next(
        new AppError(
          401,
          'unauthorized',
          'Connect using a valid local session or MCP access token.',
        ),
      );
      return;
    }
    next();
  };
}
