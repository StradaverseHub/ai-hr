import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { withLifecycleTenant } from '../../../core/module-gate';
import { lockAccessConfigurationReadTx } from '../../../core/access-configuration-lock';
import { internalIssuer } from '../../../lib/internal-auth/config';
import { lifecycleRecipientProjection, type LifecycleRecipientBinding, type LifecycleRecipientUser } from '../../../lib/internal-auth/lifecycle-recipient-preview';
const id = z.guid();
/** Active tenant accounts, searched by name. Account email is never substituted with a PM field. */
export async function searchOnboardingRecipientUsers(ctx: SessionContext, caseId: string, query: string): Promise<LifecycleRecipientUser[]> {
  id.parse(caseId);
  const needle = z.string().max(100).parse(query).trim();
  if (needle.length < 2) return [];
  return withLifecycleTenant(ctx, async tx => {
    await lockAccessConfigurationReadTx(tx, ctx.tenantId);
    const rows = await tx.execute<LifecycleRecipientBinding>(sql`select * from app.lifecycle_recipient_accounts(${caseId}::uuid,${internalIssuer(ctx.tenantId)},null::uuid[],${needle})`);
    return lifecycleRecipientProjection(ctx.tenantId, rows);
  });
}
/** One batched read for the workflow preview. Only canonical account addresses leave the Auth adapter. */
export async function lifecycleRecipientAddressesTx(tx: Tx, ctx: SessionContext, caseId: string, userIds: readonly string[]): Promise<Record<string, string>> {
  id.parse(caseId);
  const ids = [...new Set(z.array(id).max(1024).parse(userIds))];
  if (!ids.length) return {};
  await lockAccessConfigurationReadTx(tx, ctx.tenantId);
  const rows = await tx.execute<LifecycleRecipientBinding>(sql`select * from app.lifecycle_recipient_accounts(${caseId}::uuid,${internalIssuer(ctx.tenantId)},array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid),null::text)`);
  return Object.fromEntries(lifecycleRecipientProjection(ctx.tenantId, rows).map(user => [user.id, user.email]));
}
