import { z } from 'zod';

export const assistantScope = z.enum(['knowledge', 'garmin', 'both']);
export const assistantConfigSchema = z.object({
  provider: z.enum(['builtin', 'openrouter']).default('builtin'),
  model: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_.:/-]{3,160}$/)
    .default('google/gemini-3.1-flash-lite'),
  daily_budget: z.number().min(0.01).max(20).default(0.25),
  daily_calls: z.number().int().min(6).max(1000).default(60),
  garmin_url: z.string().trim().max(500).default(''),
});
export type AssistantConfig = z.infer<typeof assistantConfigSchema>;
export type PublicAssistantConfig = AssistantConfig & {
  configured: boolean;
  garmin_configured: boolean;
  today_cost: number;
  today_calls: number;
};
export const assistantMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  request_id: z.string().uuid(),
  scope: assistantScope.default('knowledge'),
  cloud: z.boolean().default(false),
  general: z.boolean().default(false),
});
export type AssistantInput = z.infer<typeof assistantMessageSchema>;
export type AssistantCitation = {
  ref: string;
  kind: 'knowledge' | 'source' | 'garmin';
  id: string;
  title: string;
  excerpt?: string;
  revision?: string;
  quality?: string;
  snapshot?: GarminResult;
};
export type GarminPlan = {
  source: 'activities' | 'health' | 'graph';
  sport: string;
  start: string;
  end: string;
  metric: string;
  group_by: 'week' | 'month';
};
export type GarminResult = {
  facts: Record<string, unknown>;
  chart?: { title: string; unit: string; points: { date: string; value: number }[]; note?: string };
  sources: { label: string; detail: string }[];
  last_sync: string | null;
  plan: GarminPlan;
  calculation_version: string;
  snapshot_hash: string;
  captured_at: string;
};
export type AssistantAction = {
  id: string;
  kind: 'note' | 'edit' | 'import';
  title: string;
  arguments: Record<string, unknown>;
  status: 'proposed' | 'applied' | 'dismissed';
  result?: { id: string; kind: 'knowledge' | 'import' };
};
export type AssistantPayload = {
  scope: 'knowledge' | 'garmin' | 'both';
  cloud: boolean;
  general?: boolean;
  citations?: AssistantCitation[];
  actions?: AssistantAction[];
  tools?: { name: string; status: string }[];
  notices?: string[];
  usage?: { calls: number; cost: number; estimated: boolean; model?: string };
};
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  payload: AssistantPayload;
  created_at: string;
};
export type Conversation = { id: string; title: string; created_at: string; updated_at: string };
export type AssistantEvent = { type: 'status' | 'token' | 'result' | 'error'; data: unknown };
