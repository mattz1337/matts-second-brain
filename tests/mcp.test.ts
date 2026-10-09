import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../server/db.js';
import { BrainService, owner } from '../server/service.js';
import { createApp } from '../server/app.js';
const toolData = (result: unknown) =>
  (result as { structuredContent?: Record<string, unknown> }).structuredContent || {};

describe('official MCP client interoperability', () => {
  it('discovers tools and performs protected read/write flows over Streamable HTTP and stdio', async () => {
    const db = await openDatabase();
    const service = new BrainService(db);
    const keys = {
      session: 'test-session',
      assistant: 'test-assistant-token',
      reader: 'test-reader-token',
    };
    const listener = createApp(service, keys).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const port = (listener.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}`;
    const remote = new Client({ name: 'http-test', version: '1.0.0' });
    const local = new Client({ name: 'stdio-test', version: '1.0.0' });
    const readOnly = new Client({ name: 'reader-test', version: '1.0.0' });
    try {
      await remote.connect(
        new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${keys.assistant}` } },
        }),
      );
      expect((await remote.listTools()).tools).toHaveLength(14);
      const add = await remote.callTool({
        name: 'add_knowledge',
        arguments: {
          title: 'Protocol fixture',
          statement: 'MCP knowledge must preserve its evidence and review state.',
          kind: 'personal_observation',
          idempotency_key: randomUUID(),
        },
      });
      expect(add.isError).not.toBe(true);
      expect(toolData(add).lifecycle).toBe('candidate');
      const id = String(toolData(add).id);
      const denied = await remote.callTool({
        name: 'review_knowledge',
        arguments: {
          id,
          expected_version: 1,
          decision: 'verify',
          rationale: 'An unauthorized model cannot verify.',
        },
      });
      expect(denied.isError).toBe(true);
      const detail = await remote.callTool({ name: 'get_knowledge', arguments: { id } });
      expect(toolData(detail).id).toBe(id);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      await local.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('server/stdio.ts')],
          env: { ...env, BRAIN_API_URL: endpoint, BRAIN_MCP_TOKEN: keys.assistant },
          stderr: 'pipe',
        }),
      );
      expect((await local.listTools()).tools).toHaveLength(14);
      const localRead = await local.callTool({ name: 'get_knowledge', arguments: { id } });
      expect(toolData(localRead).statement).toContain('preserve');
      await readOnly.connect(
        new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${keys.reader}` } },
        }),
      );
      const forbidden = await readOnly.callTool({
        name: 'add_knowledge',
        arguments: {
          title: 'Forbidden',
          statement: 'The read-only client must not write.',
          idempotency_key: randomUUID(),
        },
      });
      expect(forbidden.isError).toBe(true);
      const graph = await remote.callTool({
        name: 'query_graph',
        arguments: { include_candidates: true },
      });
      expect((toolData(graph).nodes as unknown[]).length).toBeGreaterThan(0);
      expect((await service.allKnowledge(owner)).length).toBe(1);
    } finally {
      await Promise.allSettled([remote.close(), local.close(), readOnly.close()]);
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await db.close();
    }
  });
});
