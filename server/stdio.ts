import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createMcpServer } from './mcp.js';

const endpoint = process.env.BRAIN_API_URL || `http://127.0.0.1:${config.port}`;
const local = new URL(endpoint);
if (!['localhost', '127.0.0.1'].includes(local.hostname) || local.protocol !== 'http:')
  throw new Error('The stdio bridge requires the local spike API.');
const token =
  process.env.BRAIN_MCP_TOKEN ||
  (
    JSON.parse(await readFile(path.join(config.dataDir, 'credentials.json'), 'utf8')) as {
      assistant: string;
    }
  ).assistant;
const server = createMcpServer(async (name, args) => {
  const response = await fetch(`${endpoint}/api/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await response.json()) as { error?: { message: string } };
  if (!response.ok)
    throw new Error(result.error?.message || 'The local API is unavailable. Start the app first.');
  return result;
});
await server.connect(new StdioServerTransport());
