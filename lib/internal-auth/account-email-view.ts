import 'server-only';
import { sql } from 'drizzle-orm';
import { client, withTenant, type SessionContext } from '../../db/client';
import type { AccountEmailDeliveryView } from '../account-email-model';
import { EmailSettingsError, type IdentityEmailActor } from '../identity/email-model';
import { internalSelected } from './config';
import { readRecord } from './store';
import type { Credential } from './service';
import type { RecoveryContext } from './recovery';
/** View-only projection of immutable recovery context; never returns a credential or reset link. */
export async function withInternalRecoveryLabels(ctx: SessionContext, actor: IdentityEmailActor, items: AccountEmailDeliveryView[]) {
  if (!internalSelected()) return items;
  if (actor.userId !== ctx.userId || actor.tenantId !== ctx.tenantId) throw new EmailSettingsError('forbidden');
  const ids = items.filter(item => item.kind === 'recovery').map(item => item.id).slice(0, 50);
  if (!ids.length) return items;
  const roots = await withTenant(ctx, tx => tx.execute<{ id: string; source_id: string }>(sql`select * from app.internal_auth_recovery_roots(ARRAY[${sql.join(ids.map(id => sql`${id}::uuid`),sql`, `)}]::uuid[],${actor.issuer},${actor.subject})`));
  const byId = new Map(roots.map(row => [row.id, row.source_id]));
  const cached = new Map<string, Promise<{ account: { organization: string; username: string }; eligible: boolean } | null>>();
  async function projection(source: string) {
    const context = await readRecord<RecoveryContext>(client, `recovery-mail:${source}`);
    if (!context || typeof context.organization !== 'string' || typeof context.username !== 'string') return null;
    const c = await readRecord<Credential>(client, `credential:${context.subject}`);
    const active = c ? await client.unsafe('select tenant_id from app.principal_by_identity($1,$2)', [c.issuer, c.subject]) : [];
    return { account: { organization: context.organization, username: context.username }, eligible: Boolean(c?.enabled && c.emailVerified &&
      c.version === context.version && c.email === context.email && c.issuer === context.issuer && c.tenantId === context.tenantId && active[0]?.tenant_id === c.tenantId) };
  }
  return Promise.all(items.map(async item => {
    if (item.kind !== 'recovery') return item;
    const source = byId.get(item.id); if (!source) return { ...item, canRetry: false };
    if (!cached.has(source)) cached.set(source, projection(source));
    const value = await cached.get(source)!;
    return value ? { ...item, account: value.account, canRetry: item.canRetry && value.eligible } : { ...item, canRetry: false };
  }));
}
