import type {Credential} from '../lib/internal-auth/credential';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { isGroupAdmin } from '../lib/authz-model';
import { internalSelected,internalIssuer } from '../lib/internal-auth/config';
import { decryptRecord, encryptRecord } from '../lib/internal-auth/crypto';
import { DEFAULT_PASSWORD_POLICY, passwordPolicyKey, validatePasswordPolicy, type PasswordPolicyState } from '../lib/password-policy';

async function authorize(tx: Tx,tenantId:string) {
  await lockAccessConfigurationTx(tx,tenantId);
  const [proof] = await tx.execute(sql`select app.principal_snapshot_current() AND app.is_group_admin() as allowed`) as unknown as { allowed: boolean }[];
  if (!proof?.allowed) throw new Error('forbidden');
}
function assertAdmin(ctx: SessionContext) {
  if (!internalSelected()) throw new Error('unavailable');
  if (!ctx.userId || !isGroupAdmin(ctx)) throw new Error('forbidden');
}
async function read(tx: Tx, tenantId: string): Promise<PasswordPolicyState> {
  const key = passwordPolicyKey(tenantId);
  const [row] = await tx.execute(sql`select sealed from app.internal_auth_read(${key},false)`) as unknown as { sealed: string }[];
  if (!row) return { policy: DEFAULT_PASSWORD_POLICY, revision: 0 };
  const state = decryptRecord<PasswordPolicyState>(row.sealed, key);
  return { policy: validatePasswordPolicy(state.policy), revision: state.revision };
}
export async function readPasswordPolicy(ctx: SessionContext) {
  assertAdmin(ctx);
  return withTenant(ctx, async tx => { await authorize(tx,ctx.tenantId); return read(tx, ctx.tenantId); });
}
export async function savePasswordPolicy(ctx: SessionContext, value: unknown, expectedRevision: number) {
  assertAdmin(ctx);
  const policy = validatePasswordPolicy(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid');
  return withTenant(ctx, async tx => {
    await authorize(tx,ctx.tenantId);
    const key = passwordPolicyKey(ctx.tenantId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
    const previous = await read(tx, ctx.tenantId);
    if (previous.revision !== expectedRevision) throw new Error('conflict');
    const revision = expectedRevision + 1;
    const sealed = encryptRecord({ policy, revision }, key, null);
    await tx.execute(sql`select app.internal_auth_write(${key},NULL::uuid,${sealed},NULL::timestamptz)`);
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'password-policy', aggregateId: ctx.tenantId,
      eventType: 'password-policy.updated', actor: actorOf(ctx), payload: { ...policy, revision } });
    return { revision };
  });
}

/** Manual unlock is a current group-admin action bound to an exact internal identity. */
export async function unlockPasswordAccount(ctx:SessionContext,userId:string){
 assertAdmin(ctx);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))throw new Error('invalid');
 return withTenant(ctx,async tx=>{
  await authorize(tx,ctx.tenantId);
  const [identity]=await tx.execute(sql`select app.password_unlock_subject(${userId}::uuid,${internalIssuer(ctx.tenantId)}) as subject`) as unknown as {subject:string}[];
  if(!identity)throw new Error('invalid');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'internal-auth:'+identity.subject},0))`);
  await authorize(tx,ctx.tenantId);
  const key='credential:'+identity.subject;
  const [record]=await tx.execute(sql`select sealed from app.internal_auth_read(${key},true)`) as unknown as {sealed:string}[];
  const credential=record?decryptRecord<Credential>(record.sealed,key):null;
  if(!credential||credential.subject!==identity.subject||credential.tenantId!==ctx.tenantId||credential.issuer!==internalIssuer(ctx.tenantId))throw new Error('invalid');
  await tx.execute(sql`select app.internal_auth_delete(${'login-failures:'+identity.subject})`);
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'app-user',aggregateId:userId,eventType:'app-user.password-unlocked',actor:actorOf(ctx),payload:{}});
 });
}
