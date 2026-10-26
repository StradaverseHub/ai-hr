/** Operator-owned, one-pass maintenance only. Not an agent, app route or provider executor. */
import { createDb, type Tx } from '../db/client';
import { retireExpiredAiCustodyTx } from '../core/ai-retention-maintenance';

export async function runAiRetentionTick(owner: ReturnType<typeof createDb>) {
  return owner.db.transaction(tx => retireExpiredAiCustodyTx(tx as unknown as Tx), { isolationLevel: 'read committed' });
}
async function main() {
  // No DATABASE_URL fallback or synthetic tenant/admin session. Provisioning owns this credential.
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('AI retention maintenance could not be confirmed.');
  const owner = createDb(url, { max: 1 });
  try { console.log(JSON.stringify(await runAiRetentionTick(owner))); }
  finally { await owner.client.end({ timeout: 5 }); }
}
if (process.argv[1]?.endsWith('ai-retention-runner.ts')) {
  main().catch(() => { console.error('AI retention maintenance could not be confirmed.'); process.exitCode = 1; });
}
