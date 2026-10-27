import { Router } from 'express';
import { z } from 'zod';
import { Assistant } from './assistant.js';
import { GraphifyIntegration } from './graphify.js';
import { scope } from './service.js';
import { AppError } from './errors.js';
import { pipeline } from 'node:stream/promises';

const id = z.string().uuid();
export function assistantRoutes(assistant: Assistant) {
  const router = Router();
  const graphify = new GraphifyIntegration(assistant.brain);
  router.use((req, _res, next) => {
    try {
      scope(req.actor, 'brain:admin');
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get('/config', async (req, res) => res.json(await assistant.config(req.actor)));
  router.put('/config', async (req, res) => {
    await assistant.configuration.update(req.body);
    res.json(await assistant.config(req.actor));
  });
  router.get('/conversations', async (req, res) =>
    res.json(await assistant.conversations(req.actor)),
  );
  router.post('/conversations', async (req, res) =>
    res.status(201).json(await assistant.create(req.actor)),
  );
  router.get('/conversations/:id', async (req, res) =>
    res.json(await assistant.messages(req.actor, id.parse(req.params.id))),
  );
  router.delete('/conversations/:id', async (req, res) =>
    res.json(await assistant.remove(req.actor, id.parse(req.params.id))),
  );
  router.post('/conversations/:id/cancel', (req, res) => {
    assistant.cancel(id.parse(req.params.id));
    res.json({ cancelled: true });
  });
  router.post('/conversations/:id/messages', async (req, res) => {
    const conversation = id.parse(req.params.id);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const emit = (type: string, data: unknown) => {
      if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, 15000);
    try {
      const answer = await assistant.send(
        req.actor,
        conversation,
        req.body,
        controller.signal,
        (value) => emit(value.type, value.data),
      );
      emit('result', answer);
    } catch (error) {
      emit('error', {
        message:
          error instanceof AppError || error instanceof z.ZodError
            ? error.message
            : 'The response could not complete. Try again.',
        code: error instanceof AppError ? error.code : 'assistant_error',
      });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });
  router.post('/actions/:id', async (req, res) => {
    const { decision } = z
      .object({ decision: z.enum(['apply', 'dismiss']) })
      .strict()
      .parse(req.body);
    res.json(await assistant.decide(req.actor, id.parse(req.params.id), decision));
  });
  router.get('/graphify/corpus', async (req, res) => {
    const stream = await graphify.export(req.actor);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="orbit-graphify-corpus.zip"',
    });
    await pipeline(stream, res);
  });
  router.get('/graphify/proposals', async (req, res) => res.json(await graphify.list(req.actor)));
  router.post('/graphify/import', async (req, res) =>
    res.json(await graphify.import(req.actor, req.body)),
  );
  router.post('/graphify/proposals/:id', async (req, res) => {
    const { decision } = z
      .object({ decision: z.enum(['accept', 'dismiss']) })
      .strict()
      .parse(req.body);
    res.json(await graphify.decide(req.actor, id.parse(req.params.id), decision));
  });
  return router;
}
