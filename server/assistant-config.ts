import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantConfigSchema, type AssistantConfig } from '../shared/assistant.js';
import { AppError } from './errors.js';

const storedSchema = assistantConfigSchema.extend({
  api_key: z.string().max(500).default(''),
  garmin_token: z.string().max(500).default(''),
});
export type StoredAssistantConfig = z.infer<typeof storedSchema>;
export class AssistantConfiguration {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private environment: NodeJS.ProcessEnv = process.env,
  ) {}
  async read(): Promise<StoredAssistantConfig> {
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(
        await readFile(path.join(this.directory, 'assistant-config.json'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AppError(
          500,
          'assistant_configuration',
          'Assistant configuration could not be read.',
        );
    }
    let fileToken = '';
    if (this.environment.GARMIN_CONNECTOR_TOKEN_FILE) {
      const secret = JSON.parse(
        await readFile(this.environment.GARMIN_CONNECTOR_TOKEN_FILE, 'utf8'),
      );
      fileToken = z.string().min(32).max(500).parse(secret.token);
    }
    return storedSchema.parse({
      provider: this.environment.ASSISTANT_PROVIDER || 'builtin',
      model: this.environment.ASSISTANT_MODEL || 'google/gemini-3.1-flash-lite',
      garmin_url: this.environment.GARMIN_CONNECTOR_URL || '',
      ...saved,
      api_key: this.environment.OPENROUTER_API_KEY || saved.api_key || '',
      garmin_token:
        this.environment.GARMIN_CONNECTOR_TOKEN || fileToken || saved.garmin_token || '',
    });
  }
  async update(raw: unknown) {
    const input = assistantConfigSchema
      .extend({
        api_key: z.string().trim().max(500).optional(),
        garmin_token: z.string().trim().max(500).optional(),
        clear_api_key: z.boolean().default(false),
        clear_garmin_token: z.boolean().default(false),
      })
      .strict()
      .parse(raw);
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const current = await this.read();
        const next = storedSchema.parse({
          ...input,
          api_key: input.clear_api_key ? '' : input.api_key || current.api_key,
          garmin_token: input.clear_garmin_token ? '' : input.garmin_token || current.garmin_token,
        });
        if (next.garmin_url) validateConnectorUrl(next.garmin_url);
        await mkdir(this.directory, { recursive: true });
        const file = path.join(this.directory, 'assistant-config.json'),
          temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, file);
        await chmod(file, 0o600);
      });
    this.queue = task;
    await task;
  }
}
export function validateConnectorUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname;
  const local =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === 'garmin-bridge';
  if (
    (!local && url.protocol !== 'https:') ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new AppError(
      400,
      'connector_url',
      'Use an HTTPS connector origin, or HTTP on localhost / garmin-bridge.',
    );
  return url.origin;
}
export function publicConfiguration(
  config: StoredAssistantConfig,
): AssistantConfig & { configured: boolean; garmin_configured: boolean } {
  const { api_key, garmin_token, ...values } = config;
  return {
    ...values,
    configured: config.provider === 'builtin' || Boolean(api_key),
    garmin_configured: Boolean(config.garmin_url && garmin_token),
  };
}
