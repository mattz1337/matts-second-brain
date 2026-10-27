import { z } from 'zod';
import { AppError } from './errors.js';
import { validateConnectorUrl, type StoredAssistantConfig } from './assistant-config.js';
import type { GarminResult } from '../shared/assistant.js';

export const garminPlanSchema = z
  .object({
    source: z.enum(['activities', 'health', 'graph']),
    sport: z.string().regex(/^[a-z0-9_]{1,60}$/),
    start: z.string().date(),
    end: z.string().date(),
    metric: z.enum([
      'sessions',
      'hours',
      'distance_km',
      'heart_rate',
      'resting_hr',
      'steps',
      'sleep',
      'sleep_score',
      'hrv',
      'stress',
      'body_battery',
      'training_load',
      'training_readiness',
    ]),
    group_by: z.enum(['week', 'month']),
  })
  .strict()
  .superRefine((v, ctx) => {
    const activity = ['sessions', 'hours', 'distance_km'].includes(v.metric);
    if (
      (v.source === 'health') === activity ||
      v.start > v.end ||
      Date.parse(v.end) - Date.parse(v.start) > 3660 * 86400000
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Choose compatible metrics and a date range of at most ten years.',
      });
  });
const month = z.object({
  month: z.string().max(7),
  sessions: z.number().finite(),
  hours: z.number().finite(),
  distance_km: z.number().finite(),
  days_covered: z.number().int(),
  partial: z.boolean(),
  rank: z.number().nullable(),
});
const factsSchema = z.object({
  sessions: z.number().finite().optional(),
  hours: z.number().finite().optional(),
  distance_km: z.number().finite().optional(),
  average_per_week: z.number().finite().optional(),
  average_per_week_since_first: z.number().finite().optional(),
  likely_duplicates_excluded: z.number().int().optional(),
  first_session: z.string().nullable().optional(),
  sport: z.string().max(60).optional(),
  start: z.string().date().optional(),
  end: z.string().date().optional(),
  metric: z.string().max(50).optional(),
  mean_daily_value: z.number().finite().nullable().optional(),
  unit: z.string().max(50).optional(),
  days_with_data: z.number().int().optional(),
  monthly_comparison: z
    .object({
      basis: z.string().max(50),
      comparison_start: z.string().date(),
      comparison_end: z.string().date(),
      months: z.array(month).max(130),
      top_complete_months: z.array(z.string().max(7)).max(130),
      selected_month: month.nullable(),
      note: z.string().max(1200),
    })
    .optional(),
});
const resultSchema = z.object({
  facts: factsSchema,
  chart: z
    .object({
      title: z.string().max(300),
      unit: z.string().max(50),
      note: z.string().max(1000).optional(),
      points: z.array(z.object({ date: z.string().max(40), value: z.number().finite() })).max(3700),
    })
    .optional(),
  sources: z.array(z.object({ label: z.string().max(500), detail: z.string().max(1000) })).max(8),
  last_sync: z.string().nullable(),
  plan: garminPlanSchema,
  calculation_version: z.string().max(100),
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  captured_at: z.string().max(50),
});
export class GarminConnector {
  constructor(private request: typeof fetch = fetch) {}
  async query(
    config: StoredAssistantConfig,
    input: unknown,
    signal: AbortSignal,
  ): Promise<GarminResult> {
    const plan = garminPlanSchema.parse(input);
    return this.read(config, '/v1/query', { plan }, signal);
  }
  async question(
    config: StoredAssistantConfig,
    question: string,
    signal: AbortSignal,
  ): Promise<GarminResult> {
    return this.read(config, '/v1/question', { question }, signal);
  }
  private async read(
    config: StoredAssistantConfig,
    route: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<GarminResult> {
    if (!config.garmin_url || !config.garmin_token)
      throw new AppError(503, 'garmin_disabled', 'Connect Garmin in assistant settings first.');
    const response = await this.request(`${validateConnectorUrl(config.garmin_url)}${route}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.garmin_token}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new AppError(
        502,
        'garmin_unavailable',
        `Garmin is unavailable (HTTP ${response.status}). No values were inferred.`,
      );
    const text = await response.text();
    if (Buffer.byteLength(text) > 500000)
      throw new AppError(
        502,
        'garmin_limit',
        'Garmin returned too much data. Narrow the date range.',
      );
    return resultSchema.parse(JSON.parse(text));
  }
}
