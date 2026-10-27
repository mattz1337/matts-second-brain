import type { QueryDB } from './db.js';
/** Redact cached model outputs when their backing records are removed/retracted. */
export async function redactAssistantSources(db: QueryDB, ids: string[]) {
  await db.query(
    `UPDATE assistant_messages SET content='This answer used a source that has since been removed or retracted. Ask again using the current knowledge.',payload=jsonb_build_object('scope',payload->'scope','cloud',payload->'cloud','notices',jsonb_build_array('Backing source unavailable; cached answer and snapshots were removed.'))
    WHERE role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(payload->'citations','[]'::jsonb)) c WHERE c->>'id'=ANY($1::text[]))`,
    [ids],
  );
  await db.query(
    `DELETE FROM assistant_actions WHERE run_id IN(SELECT run_id FROM assistant_messages WHERE payload->'notices' ? 'Backing source unavailable; cached answer and snapshots were removed.') AND status='proposed'`,
  );
  await db.query(
    `UPDATE assistant_origins SET payload=jsonb_build_object('stale',true,'citations','[]'::jsonb) WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(payload->'citations','[]'::jsonb)) c WHERE c->>'id'=ANY($1::text[]))`,
    [ids],
  );
}
