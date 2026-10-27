import { AppError } from './errors.js';
import type { StoredAssistantConfig } from './assistant-config.js';

export type ModelTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};
export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ModelReply = { content: string; calls: ToolCall[]; cost: number | null };
export const MODEL_ROUNDS = 6,
  MODEL_OUTPUT = 1400,
  MODEL_BYTES = 48000;
// Conservative byte-based reservation; actual cost replaces it when reported.
export const CALL_RESERVATION = (MODEL_BYTES * 0.3 + MODEL_OUTPUT * 2) / 1e6;

export class AssistantModel {
  constructor(private request: typeof fetch = fetch) {}
  async complete(
    config: StoredAssistantConfig,
    messages: ModelMessage[],
    tools: ModelTool[],
    signal: AbortSignal,
    token: (text: string) => void,
  ): Promise<ModelReply> {
    if (Buffer.byteLength(JSON.stringify({ messages, tools })) > MODEL_BYTES)
      throw new AppError(
        400,
        'context_limit',
        'This conversation is too large. Start a new conversation or narrow the question.',
      );
    const response = await this.request('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        stream: true,
        max_tokens: MODEL_OUTPUT,
        reasoning: { effort: 'none' },
        provider: {
          zdr: true,
          data_collection: 'deny',
          require_parameters: true,
          max_price: { prompt: 0.3, completion: 2.0 },
        },
      }),
    });
    if (!response.ok || !response.body)
      throw new AppError(
        502,
        'model_unavailable',
        `The model request failed (HTTP ${response.status}). Check the key, balance, model and eligible providers. Privacy filters were retained.`,
      );
    const parts = new Map<number, ToolCall>();
    let content = '',
      cost: number | null = null,
      buffered = '',
      done = false,
      size = 0;
    const decoder = new TextDecoder();
    const event = (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error('Provider streaming error');
      if (
        typeof chunk.usage?.cost === 'number' &&
        Number.isFinite(chunk.usage.cost) &&
        chunk.usage.cost >= 0
      )
        cost = chunk.usage.cost;
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === 'string') {
        content += delta.content;
        token(delta.content);
      }
      for (const value of delta?.tool_calls || []) {
        if (!Number.isInteger(value.index) || value.index < 0 || value.index >= 6)
          throw new Error('Too many tool calls');
        const call = parts.get(value.index) || {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (value.id) call.id = value.id;
        if (value.function?.name) call.function.name += value.function.name;
        if (value.function?.arguments) call.function.arguments += value.function.arguments;
        if (
          call.function.arguments.length > 14000 ||
          call.function.name.length > 100 ||
          call.id.length > 200
        )
          throw new Error('Tool call exceeded limits');
        parts.set(value.index, call);
      }
    };
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        const bytes = part.value;
        size += bytes.length;
        if (size > 200000) throw new Error('Response exceeded limits');
        buffered += decoder.decode(bytes, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffered))) {
          const frame = buffered.slice(0, boundary.index);
          buffered = buffered.slice(boundary.index + boundary[0].length);
          event(frame);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) event(buffered);
      if (!done) throw new Error('Incomplete stream');
      const calls = [...parts.values()];
      if (
        calls.some((c) => !c.id || !c.function.name) ||
        new Set(calls.map((c) => c.id)).size !== calls.length
      )
        throw new Error('Invalid tool identifiers');
      return { content, calls, cost };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AppError(
        502,
        'model_stream',
        'The model response was interrupted or invalid. No incomplete tool call was executed.',
      );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
