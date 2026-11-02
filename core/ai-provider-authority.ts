/** One current-login/group-wide prerequisite for provider settings and candidate custody. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { assertAiPrincipalTx } from './ai-principal';
export async function currentAiProviderAdminTx(tx: Tx, ctx: SessionContext): Promise<boolean> {
  await assertAiPrincipalTx(tx, ctx);
  const [row] = await tx.execute<{ allowed: boolean }>(sql`select app.is_group_admin() and app.organisation_settings_function_allowed('aiConfig','view',NULL) as allowed`);
  return row?.allowed === true;
}
