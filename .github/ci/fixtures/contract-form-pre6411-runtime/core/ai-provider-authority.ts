/** One current-login/group-wide prerequisite for provider settings and candidate custody. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../db/client';
import { assertAiPresentationPrincipalTx, assertAiPrincipalTx } from './ai-principal';
export async function currentAiProviderAdminTx(tx: Tx, ctx: SessionContext): Promise<boolean> {
  await assertAiPrincipalTx(tx, ctx);
  return isCurrentGroupAdminTx(tx);
}

/** Provider configuration display uses the caller's database-enforced snapshot. */
export async function currentAiProviderPresentationAdminTx(tx: Tx, ctx: SessionContext): Promise<boolean> {
  await assertAiPresentationPrincipalTx(tx, ctx);
  return isCurrentGroupAdminTx(tx);
}

async function isCurrentGroupAdminTx(tx: Tx): Promise<boolean> {
  const [row] = await tx.execute<{ allowed: boolean }>(sql`select app.is_group_admin() as allowed`);
  return row?.allowed === true;
}
