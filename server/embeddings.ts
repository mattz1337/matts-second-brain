import path from 'node:path';
import type { DB } from './db.js';
import { rows, one } from './db.js';
import { config } from './config.js';
import type { ModelStatus } from '../shared/contracts.js';

export class Embeddings {
  state = 'idle';
  error: string | null = null;
  private extractor:
    | ((text: string, options: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>)
    | null = null;
  private initializing: Promise<void> | null = null;
  private processing = false;
  private inferenceQueue: Promise<unknown> = Promise.resolve();
  readonly modelId: string;
  constructor(
    private db: DB,
    private mode = config.embeddings,
    private model = config.model,
    private cacheDir = path.join(config.dataDir, 'models'),
  ) {
    this.modelId = `${model}:q8:384:v1`;
  }
  async initialize() {
    if (this.mode !== 'local') {
      this.state = 'disabled';
      return;
    }
    if (this.extractor) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.state = 'loading';
      this.error = null;
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = this.cacheDir;
        env.allowLocalModels = false;
        const pipe = await pipeline('feature-extraction', this.model, {
          dtype: 'q8',
          device: 'cpu',
          session_options: { intraOpNumThreads: config.embeddingThreads, interOpNumThreads: 1 },
        });
        this.extractor = pipe as unknown as NonNullable<typeof this.extractor>;
        this.state = 'ready';
      } catch (error) {
        this.state = 'error';
        this.error = error instanceof Error ? error.message : 'Embedding model could not load';
      }
    })();
    await this.initializing;
    this.initializing = null;
  }
  async embed(text: string, query = false): Promise<number[] | null> {
    const inference = this.inferenceQueue.then(() => this.performEmbedding(text, query));
    this.inferenceQueue = inference.catch(() => undefined);
    return inference;
  }
  private async performEmbedding(text: string, query = false): Promise<number[] | null> {
    if (!this.extractor) return null;
    const prefix = this.model.includes('e5') ? (query ? 'query: ' : 'passage: ') : '';
    const result = await this.extractor(prefix + text, {
      pooling: 'mean',
      normalize: true,
      truncation: true,
    });
    const vector = Array.from(result.data);
    if (vector.length !== 384 || vector.some((x) => !Number.isFinite(x)))
      throw new Error('The spike requires a 384-dimensional embedding model.');
    return vector;
  }
  async indexPending(limit = 10) {
    if (this.processing || this.state !== 'ready') return;
    this.processing = true;
    try {
      const docs = await rows<{ id: string; title: string; text: string; input_hash: string }>(
        this.db,
        'SELECT id,title,text,input_hash FROM search_documents WHERE embedding IS NULL OR model_id IS DISTINCT FROM $1 LIMIT $2',
        [this.modelId, limit],
      );
      for (const doc of docs) {
        const vector = await this.embed(`${doc.title}\n${doc.text}`);
        if (vector)
          await this.db.query(
            'UPDATE search_documents SET embedding=$1::vector,model_id=$2 WHERE id=$3 AND input_hash=$4',
            [JSON.stringify(vector), this.modelId, doc.id, doc.input_hash],
          );
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Indexing failed';
    } finally {
      this.processing = false;
    }
  }
  async status(): Promise<ModelStatus> {
    const counts = await one<{ indexed: number; pending: number }>(
      this.db,
      'SELECT count(*) FILTER(WHERE embedding IS NOT NULL AND model_id=$1)::int AS indexed,count(*) FILTER(WHERE embedding IS NULL OR model_id IS DISTINCT FROM $1)::int AS pending FROM search_documents',
      [this.modelId],
    );
    return {
      mode: this.mode,
      model: this.model,
      state: this.state,
      error: this.error,
      indexed: counts?.indexed || 0,
      pending: counts?.pending || 0,
    };
  }
}
