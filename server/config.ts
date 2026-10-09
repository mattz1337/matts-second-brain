import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 4310),
  dataDir: path.resolve(process.env.DATA_DIR || '.data'),
  seedDemo: process.env.SEED_DEMO !== 'false',
  embeddings: process.env.EMBEDDINGS || 'local',
  model: process.env.EMBEDDING_MODEL || 'Xenova/multilingual-e5-small',
  semanticMinScore: Number(process.env.SEMANTIC_MIN_SCORE || 0.8),
  extraction: process.env.EXTRACTION || 'extractive',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
};
