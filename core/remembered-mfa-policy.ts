import { lockAccessConfigurationTx } from './access-configuration-lock';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin } from '../lib/authz-model';
import { internalSelected } from '../lib/internal-auth/config';
import { decryptRecord, encryptRecord } from '../lib/internal-auth/crypto';
import { DEFAULT_REMEMBERED_MFA_POLICY, rememberedMfaPolicyKey, validateRememberedMfaPolicy, validateRememberedMfaState, type RememberedMfaPolicyState } from '../lib/remembered-mfa-policy';

async function authorize(tx: Tx, tenantId: string) {
  await lockAccessConfigurationTx(tx, tenantId);
  const [proof] = await tx.execute(sql`select app.principal_snapshot_current() AND app.is_group_admin() as allowed`) as unknown as { allowed: boolean }[];
  if (!proof?.allowed) throw new Error('forbidden');
}
function assertAdmin(ctx: SessionContext) {
  if (!internalSelected()) throw new Error('unavailable');
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new Error('forbidden');
}
async function read(tx: Tx, tenantId: string): Promise<RememberedMfaPolicyState> {
  const key = rememberedMfaPolicyKey(tenantId);
  const [row] = await tx.execute(sql`select sealed from app.internal_auth_read(${key},false)`) as unknown as { sealed: string }[];
  if (!row) return { policy: DEFAULT_REMEMBERED_MFA_POLICY, revision: 0 };
  const state = decryptRecord<RememberedMfaPolicyState>(row.sealed, key);
  return validateRememberedMfaState(state);
}
export async function readRememberedMfaPolicyEditor(ctx: SessionContext) {
  assertAdmin(ctx);
  return withTenant(ctx, async tx => { await authorize(tx, ctx.tenantId); return read(tx, ctx.tenantId); });
}
export async function saveRememberedMfaPolicy(ctx: SessionContext, value: unknown, expectedRevision: number) {
  assertAdmin(ctx);
  const policy = validateRememberedMfaPolicy(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid');
  return withTenant(ctx, async tx => {
    await authorize(tx, ctx.tenantId);
    const key = rememberedMfaPolicyKey(ctx.tenantId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
    const previous = await read(tx, ctx.tenantId);
    if (previous.revision !== expectedRevision) throw new Error('conflict');
    const revision = expectedRevision + 1;
    const sealed = encryptRecord({ policy, revision }, key, null);
    await tx.execute(sql`select app.internal_auth_write(${key},NULL::uuid,${sealed},NULL::timestamptz)`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'remembered-mfa-policy', aggregateId: ctx.tenantId,
      eventType: 'remembered-mfa-policy.updated', actor: actorOf(ctx), payload: { ...policy, revision, source: 'security-center-password' } });
    return { revision };
  });
}
