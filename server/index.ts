import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { Embeddings } from './embeddings.js';
import { BrainService } from './service.js';
import { credentials } from './auth.js';
import { createApp } from './app.js';
import { seedDemo } from './seed.js';

await mkdir(config.dataDir, { recursive: true });
const db = await openDatabase(config.dataDir);
const embeddings = new Embeddings(db);
const service = new BrainService(db, embeddings);
await service.recoverJobs();
if (config.seedDemo) await seedDemo(service);
await service.classification.ensureBackfill();
const app = createApp(service, await credentials(config.dataDir), config.port);
const server = app.listen(config.port, '127.0.0.1', () =>
  console.log(`Commonplace: http://127.0.0.1:${config.port} · MCP: /mcp · private local profile`),
);
void embeddings.initialize();
const worker = setInterval(() => {
  void service.processNextJob();
  void embeddings.indexPending();
  void service.classification.processPending();
}, 1000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(worker);
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
