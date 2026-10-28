import { sql } from 'drizzle-orm';
import type { Tx } from './client';
import { SYSTEM_TENANT_ID } from './seed-guard';

export const AI_CUSTODY_RESET_REFUSAL =
  'REFUSING TO SEED: existing AI application data requires separately established offline maintenance.';

/** No environment or demo-reseed override: a retained application tenant is not a disposable fixture.
 * The system audit tenant is the exact reserved identity from the existing seed guard. */
export function aiCustodyResetRefusal(custodyExists: boolean, tenantIds: readonly string[]): string | null {
  return custodyExists && tenantIds.some(id => id !== SYSTEM_TENANT_ID) ? AI_CUSTODY_RESET_REFUSAL : null;
}

/** Read-only preflight, before the destructive script's first mutation. This is a refusal boundary,
 * not an online maintenance/quiescence proof; the script never acquires or manipulates services. */
export async function assertAiCustodyResetAllowed(db: Pick<Tx, 'execute'>): Promise<void> {
  const [state] = await db.execute<{ custody: boolean; application_tenant: boolean }>(sql`select
    (to_regclass('app.assistant_own_leave_review') is not null
      or to_regclass('app.assistant_own_leave_review_content') is not null) as custody,
    exists(select 1 from public.tenant where id <> ${SYSTEM_TENANT_ID}::uuid) as application_tenant`);
  if (!state || (state.custody && state.application_tenant)) throw new Error(AI_CUSTODY_RESET_REFUSAL);
}
