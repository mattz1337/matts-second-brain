import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { Embeddings } from './embeddings.js';
import { BrainService } from './service.js';
import { credentials } from './auth.js';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';
import { loadAccess } from './access.js';

// Validate access and load the mounted password hash before opening persistent data.
const access = await loadAccess(config.host);
await mkdir(config.dataDir, { recursive: true });
const db = await openDatabase(config.dataDir);
const embeddings = new Embeddings(db);
const service = new BrainService(db, embeddings);
await service.recoverJobs();
if (config.seedDemo) await seedDemo(service);
await service.classification.ensureBackfill();
const app = createApp(service, await credentials(config.dataDir), config.port, access);
const server = app.listen(config.port, config.host, () =>
  console.log(
    `Orbit: ${access.publicOrigin || `http://${config.host}:${config.port}`} · MCP: /mcp · ${access.mode} access`,
  ),
);
let closing = false;
const active = new Set<Promise<unknown>>();
function track(task: Promise<unknown>) {
  active.add(task);
  void task
    .catch((error) =>
      console.error(
        'Background task failed:',
        error instanceof Error ? error.message : 'Unknown error',
      ),
    )
    .finally(() => active.delete(task));
}
track(embeddings.initialize());
const worker = setInterval(() => {
  if (closing) return;
  track(service.processNextJob());
  track(embeddings.indexPending());
  track(service.classification.processPending());
}, 1000);
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(worker);
  const deadline = setTimeout(() => {
    console.error('Shutdown timed out; unfinished jobs will recover on restart.');
    process.exit(1);
  }, 120000);
  deadline.unref();
  try {
    const drained = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeIdleConnections();
    await Promise.all([drained, Promise.allSettled([...active])]);
    await db.close();
    clearTimeout(deadline);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
