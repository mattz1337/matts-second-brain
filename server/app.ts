import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { incomingDirectory, NSX_LIMIT, removeStoredFile } from './nsx.js';
import { backupStream, restoreBundle } from './backup.js';
import { pipeline } from 'node:stream/promises';
import { z, ZodError } from 'zod';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrainService, scope } from './service.js';
import { identify, localGuard, type Credentials } from './auth.js';
import { createMcpServer, invokeTool, toolDefinitions } from './mcp.js';
import { AppError } from './errors.js';
import { BrowserSessions, type AccessOptions } from './access.js';

const id = z.string().uuid();
export function createApp(
  service: BrainService,
  keys: Credentials,
  port = 4310,
  access: AccessOptions = { mode: 'local' },
) {
  const app = express();
  const sessions = new BrowserSessions(access);
  app.disable('x-powered-by');
  app.set('trust proxy', access.trustProxy?.length ? access.trustProxy : false);
  app.use(localGuard(port, access));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', profile: 'local-spike' }));
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: access.mode === 'password',
  };
  app.get('/api/session', (req, res) => {
    const token = String(req.cookies?.orbit_session || '');
    res.json({
      mode: access.mode,
      authenticated: access.mode === 'password' ? sessions.valid(token) : token === keys.session,
    });
  });
  app.post('/api/session', async (req, res) => {
    if (!req.get('origin'))
      throw new AppError(403, 'origin_required', 'Browser login requires a same-origin request.');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const token =
      access.mode === 'password'
        ? await sessions.login(password, req.ip || req.socket.remoteAddress || 'unknown')
        : keys.session;
    // A new login replaces the existing browser session.
    sessions.logout(String(req.cookies?.orbit_session || ''));
    res.cookie('orbit_session', token, {
      ...cookieOptions,
      maxAge: access.mode === 'password' ? sessions.ttl : 86400000,
    });
    res.json({ authenticated: true, mode: access.mode });
  });
  app.delete('/api/session', (req, res) => {
    if (!req.get('origin'))
      throw new AppError(403, 'origin_required', 'Logout requires a same-origin request.');
    sessions.logout(String(req.cookies?.orbit_session || ''));
    res.clearCookie('orbit_session', cookieOptions);
    res.json({ authenticated: false });
  });
  app.use('/api', identify(keys, false, sessions));
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/dashboard', async (req, res) => res.json(await service.dashboard(req.actor)));
  app.get('/api/knowledge', async (req, res) =>
    res.json(
      await service.search(req.actor, {
        ...req.query,
        include_candidates: req.query.include_candidates === 'true',
        include_stale: req.query.include_stale !== 'false',
        limit: Number(req.query.limit || 50),
        offset: Number(req.query.offset || 0),
      }),
    ),
  );
  app.post('/api/knowledge', async (req, res) =>
    res.status(201).json(await service.addKnowledge(req.actor, req.body)),
  );
  app.get('/api/knowledge/:id', async (req, res) =>
    res.json(await service.getKnowledge(req.actor, id.parse(req.params.id))),
  );
  app.patch('/api/knowledge/:id', async (req, res) =>
    res.json(await service.update(req.actor, id.parse(req.params.id), req.body)),
  );
  app.post('/api/knowledge/:id/review', async (req, res) =>
    res.json(await service.review(req.actor, id.parse(req.params.id), req.body)),
  );
  app.post('/api/knowledge/:id/archive', async (req, res) => {
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        restore: z.boolean().default(false),
      })
      .parse(req.body);
    res.json(
      await service.archive(
        req.actor,
        id.parse(req.params.id),
        input.expected_version,
        input.restore,
      ),
    );
  });
  app.post('/api/knowledge/:id/evidence', async (req, res) =>
    res.json(await service.attachEvidence(req.actor, id.parse(req.params.id), req.body)),
  );
  app.delete('/api/knowledge/:id', async (req, res) =>
    res.json(
      await service.forget(
        req.actor,
        id.parse(req.params.id),
        z.number().int().positive().parse(req.body.expected_version),
      ),
    ),
  );
  app.post('/api/search', async (req, res) => res.json(await service.search(req.actor, req.body)));
  app.post('/api/answer', async (req, res) => res.json(await service.answer(req.actor, req.body)));
  app.post('/api/graph', async (req, res) => res.json(await service.graph(req.actor, req.body)));
  app.get('/api/categories', async (req, res) => {
    scope(req.actor, 'brain:read');
    res.json(await service.classification.list(req.query.include_candidates === 'true'));
  });
  app.get('/api/categories/status', async (req, res) => {
    scope(req.actor, 'brain:read');
    res.json(await service.classification.status());
  });
  app.post('/api/categories/rescan', async (req, res) => {
    scope(req.actor, 'brain:write');
    res.status(202).json(await service.classification.queue());
  });
  app.get('/api/categories/items/:id', async (req, res) => {
    scope(req.actor, 'brain:read');
    res.json(await service.classification.detail(id.parse(req.params.id)));
  });
  app.post('/api/categories/items/:id/decisions', async (req, res) => {
    res.json(await service.classification.decide(req.actor, id.parse(req.params.id), req.body));
  });
  app.get('/api/review', async (req, res) => res.json(await service.reviewQueue(req.actor)));
  app.post('/api/review/batch', async (req, res) =>
    res.json(await service.batchReview(req.actor, req.body)),
  );
  app.get('/api/sources', async (req, res) => res.json(await service.sources(req.actor)));
  app.post('/api/sources/search', async (req, res) =>
    res.json(await service.browseSources(req.actor, req.body)),
  );
  app.get('/api/sources/:id', async (req, res) =>
    res.json(await service.sourceDetail(req.actor, id.parse(req.params.id))),
  );
  app.post('/api/sources/:id/retract', async (req, res) =>
    res.json(await service.retractSource(req.actor, id.parse(req.params.id))),
  );
  app.delete('/api/sources/:id', async (req, res) =>
    res.json(await service.forgetSource(req.actor, id.parse(req.params.id))),
  );
  app.post('/api/imports', async (req, res) =>
    res.status(202).json(await service.importSource(req.actor, req.body)),
  );
  app.get('/api/imports', async (req, res) => res.json(await service.jobs(req.actor)));
  app.get('/api/imports/:id', async (req, res) =>
    res.json(await service.getJob(req.actor, id.parse(req.params.id))),
  );
  app.post('/api/imports/:id/retry', async (req, res) =>
    res.json(await service.retryJob(req.actor, id.parse(req.params.id))),
  );
  const uploadStorage = multer.diskStorage({
    destination: (_req, _file, callback) => {
      const directory = incomingDirectory(service.storageRoot);
      mkdir(directory, { recursive: true }).then(
        () => callback(null, directory),
        (error) => callback(error, directory),
      );
    },
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  });
  const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: NSX_LIMIT, files: 1 },
    fileFilter: (_req, file, callback) =>
      /\.(md|markdown|txt|html?|pdf|nsx)$/i.test(file.originalname)
        ? callback(null, true)
        : callback(
            new AppError(
              400,
              'unsupported_format',
              'Choose Markdown, text, HTML, PDF, or a Note Station NSX archive.',
            ),
          ),
  });
  app.post(
    '/api/uploads',
    (req, _res, next) => {
      scope(req.actor, 'brain:write');
      next();
    },
    upload.single('file'),
    async (req, res) => {
      if (!req.file) throw new AppError(400, 'file_required', 'Choose a supported file.');
      res
        .status(201)
        .json(
          await service.uploadDisk(
            req.actor,
            req.file.filename,
            req.file.originalname,
            req.file.mimetype,
          ),
        );
    },
  );
  app.get('/api/uploads/:id/preview', async (req, res) =>
    res.json(await service.previewNsx(req.actor, id.parse(req.params.id))),
  );
  app.delete('/api/uploads/:id', async (req, res) =>
    res.json(await service.discardUpload(req.actor, id.parse(req.params.id))),
  );
  app.get('/api/attachments/:id', async (req, res) => {
    const attachment = await service.attachment(req.actor, id.parse(req.params.id));
    res.set(
      'Content-Type',
      [
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp',
        'application/pdf',
        'text/plain',
      ].includes(attachment.mime)
        ? attachment.mime
        : 'application/octet-stream',
    );
    res.set(
      'Content-Disposition',
      `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, '%27')}`,
    );
    res.sendFile(attachment.file, { dotfiles: 'allow' });
  });
  app.get('/api/sources/:id/revisions/:revisionId/original', async (req, res) => {
    const original = await service.originalNote(
      req.actor,
      id.parse(req.params.id),
      id.parse(req.params.revisionId),
    );
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', 'attachment; filename="notestation-note.json"');
    res.send(original);
  });
  app.get('/api/export/bundle', async (req, res) => {
    const stream = await backupStream(service, req.actor);
    res.set('Content-Type', 'application/zip');
    res.set(
      'Content-Disposition',
      `attachment; filename="orbit-${new Date().toISOString().slice(0, 10)}.zip"`,
    );
    await pipeline(stream, res);
  });
  const backupUpload = multer({
    storage: uploadStorage,
    limits: { fileSize: NSX_LIMIT, files: 1 },
    fileFilter: (_req, file, callback) =>
      /\.zip$/i.test(file.originalname)
        ? callback(null, true)
        : callback(new AppError(400, 'invalid_backup', 'Choose an Orbit ZIP backup.')),
  });
  app.post(
    '/api/restore/bundle',
    (req, _res, next) => {
      scope(req.actor, 'brain:admin');
      next();
    },
    backupUpload.single('file'),
    async (req, res) => {
      if (!req.file) throw new AppError(400, 'file_required', 'Choose a ZIP backup.');
      try {
        res.json(await restoreBundle(service, req.actor, req.file.path));
      } finally {
        await removeStoredFile(req.file.path);
      }
    },
  );
  app.post('/api/links', async (req, res) => {
    const input = z
      .object({
        from: id,
        to: id,
        type: z.enum(['related_to', 'supersedes']),
        expected_version: z.number().int().positive().optional(),
      })
      .parse(req.body);
    res.json(
      await service.link(req.actor, input.from, input.to, input.type, input.expected_version),
    );
  });
  app.post('/api/entities/merge', async (req, res) => {
    const input = z.object({ from: id, to: id }).parse(req.body);
    res.json(await service.mergeEntities(req.actor, input.from, input.to));
  });
  app.get('/api/entities', async (req, res) => res.json(await service.entities(req.actor)));
  app.get('/api/entities/merges', async (req, res) =>
    res.json(await service.entityMerges(req.actor)),
  );
  app.post('/api/entities/merges/:id/undo', async (req, res) =>
    res.json(await service.undoEntityMerge(req.actor, id.parse(req.params.id))),
  );
  app.get('/api/export', async (req, res) => {
    res.set(
      'Content-Disposition',
      `attachment; filename="orbit-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.json(await service.exportData(req.actor));
  });
  app.post('/api/restore', async (req, res) =>
    res.json(await service.restoreData(req.actor, req.body)),
  );
  app.get('/api/models', async (req, res) => {
    scope(req.actor, 'brain:read');
    res.json(
      (await service.embeddings?.status()) || {
        mode: 'lexical',
        state: 'disabled',
        model: 'none',
        indexed: 0,
        pending: 0,
        error: null,
      },
    );
  });
  app.post('/api/models/retry', async (req, res) => {
    scope(req.actor, 'brain:admin');
    void service.embeddings?.initialize();
    res.json({ status: 'loading' });
  });
  app.get('/api/integrations', (req, res) => {
    scope(req.actor, 'brain:admin');
    res.json({
      endpoint: `${access.publicOrigin || `http://127.0.0.1:${port}`}/mcp`,
      assistant_token: keys.assistant,
      reader_token: keys.reader,
      tools: Object.entries(toolDefinitions).map(([name, d]) => ({
        name,
        description: d.description,
        scope: d.scope,
      })),
      profile:
        access.mode === 'password'
          ? 'Password-protected single-owner server. MCP uses scoped bearer tokens; OAuth is not configured.'
          : 'Local-only. No remote OAuth deployment is configured.',
    });
  });
  app.post('/api/tools/:name', async (req, res) =>
    res.json(await invokeTool(service, req.actor, String(req.params.name), req.body)),
  );
  app.post('/mcp', identify(keys, true), async (req, res) => {
    const server = createMcpServer((name, args) => invokeTool(service, req.actor, name, args));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', identify(keys, true), (_req, res) =>
    res.status(405).json({ error: 'Use POST for stateless Streamable HTTP.' }),
  );
  const dist = path.resolve('dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*path}', (req, res) => {
      if (req.path.startsWith('/api/'))
        res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found.' } });
      else res.sendFile(path.join(dist, 'index.html'));
    });
  }
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof ZodError || error instanceof multer.MulterError
            ? 400
            : (error as { status?: number })?.status || 500;
      const message =
        error instanceof AppError
          ? error.message
          : error instanceof ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : error instanceof multer.MulterError
              ? error.message
              : status < 500 && error instanceof Error
                ? error.message
                : 'Operation failed. See the local server log.';
      if (status >= 500)
        console.error(error instanceof Error ? error.message : 'Unexpected server error');
      res.status(status).json({
        error: { code: error instanceof AppError ? error.code : 'invalid_request', message },
      });
    },
  );
  return app;
}
