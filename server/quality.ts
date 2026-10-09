import type { Freshness, Knowledge } from '../shared/contracts.js';

export function temporalQuality(
  item: Pick<
    Knowledge,
    'valid_from' | 'valid_to' | 'verified_at' | 'review_interval_days' | 'grace_days'
  >,
  at = new Date(),
) {
  const time = at.getTime();
  let freshness: Freshness = 'unknown';
  const due =
    item.verified_at && item.review_interval_days !== null
      ? new Date(
          new Date(item.verified_at).getTime() + item.review_interval_days * 86400000,
        ).toISOString()
      : null;
  if (item.valid_to && new Date(item.valid_to).getTime() <= time) freshness = 'expired';
  else if (item.valid_from && new Date(item.valid_from).getTime() > time)
    freshness = 'not_yet_valid';
  else if (!item.verified_at || new Date(item.verified_at).getTime() > time) freshness = 'unknown';
  else if (!due || new Date(due).getTime() > time) freshness = 'current';
  else if (time <= new Date(due).getTime() + item.grace_days * 86400000) freshness = 'review_due';
  else freshness = 'stale';
  return { freshness, review_due_at: due };
}
export function intervalsOverlap(
  a: Pick<Knowledge, 'valid_from' | 'valid_to'>,
  b: Pick<Knowledge, 'valid_from' | 'valid_to'>,
) {
  return (
    (a.valid_from ? Date.parse(a.valid_from) : -Infinity) <
      (b.valid_to ? Date.parse(b.valid_to) : Infinity) &&
    (b.valid_from ? Date.parse(b.valid_from) : -Infinity) <
      (a.valid_to ? Date.parse(a.valid_to) : Infinity)
  );
}
