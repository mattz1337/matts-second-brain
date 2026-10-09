import { openDatabase } from '../server/db.js';
import { Embeddings } from '../server/embeddings.js';

const db = await openDatabase();
const embeddings = new Embeddings(db);
await embeddings.initialize();
const vector = await embeddings.embed('Semantic search connects related ideas.', true);
const status = await embeddings.status();
console.log(
  JSON.stringify({
    state: status.state,
    model: status.model,
    dimensions: vector?.length,
    error: status.error,
  }),
);
await db.close();
if (!vector) process.exitCode = 1;
