/** Operator-owned, one-pass maintenance only. Not an agent, app route or provider executor. */
import type {Tx} from '../db/client';
import {createMaintenanceDb,type MaintenanceDatabase} from '../db/maintenance-client';
import { sql } from 'drizzle-orm';
import { retireExpiredAiCustodyTx } from '../core/ai-retention-maintenance';

export async function runAiRetentionTick(owner: MaintenanceDatabase) {
  return owner.db.transaction(async tx => {
    // The maintenance owner first proves physical database ownership and bounds statements. Never
    // run this aggregate with an app principal or bypass the same expired-only RLS policies.
    const result = await retireExpiredAiCustodyTx(tx as unknown as Tx);
    const [queue] = await tx.execute<{ remaining: boolean; oldest_age_seconds: number | null }>(sql`with oldest as (
      (select expires_at from app.assistant_own_leave_review
        where state='awaiting_confirmation' and expires_at<=now() order by expires_at limit 1)
      union all
      (select expires_at from public.ai_agent_feedback
        where expires_at<=now() order by expires_at limit 1)
    ) select exists(select 1 from oldest) as remaining,
      extract(epoch from now()-min(expires_at))::float8 as oldest_age_seconds from oldest`);
    if (!queue || typeof queue.remaining !== 'boolean' ||
      (queue.oldest_age_seconds !== null && (!Number.isFinite(queue.oldest_age_seconds) || queue.oldest_age_seconds < 0)) ||
      queue.remaining !== (queue.oldest_age_seconds !== null)) throw new Error('AI retention maintenance could not be confirmed.');
    return Object.freeze({ ...result, backlog: queue.remaining, oldestExpiredAgeSeconds: queue.oldest_age_seconds });
  }, { isolationLevel: 'read committed' });
}
async function main() {
  // No DATABASE_URL fallback or synthetic tenant/admin session. Provisioning owns this credential.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('AI retention maintenance could not be confirmed.');
  const owner = createMaintenanceDb(url);
  try { console.log(JSON.stringify(await runAiRetentionTick(owner))); }
  finally { await owner.close(); }
}
if (process.argv[1]?.endsWith('ai-retention-runner.ts')) {
  main().catch(() => { console.error('AI retention maintenance could not be confirmed.'); process.exitCode = 1; });
}
