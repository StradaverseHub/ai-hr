import { sql } from 'drizzle-orm';
import { withTenant } from '@/db/client';
import { getSession } from '@/lib/session';
import { keycloakConfig,keycloakSelected } from './config';
import { currentIdentitySession } from './session';
import { ManualIdentityError } from './manual-model';

export async function requireManualIdentityAdmin() {
  const ctx=await getSession();
  if(!keycloakSelected()||!ctx.userId)throw new ManualIdentityError('forbidden');
  const identity=await currentIdentitySession();
  if(!identity?.emailVerified||identity.issuer!==keycloakConfig().issuer)throw new ManualIdentityError('forbidden');
  const allowed=await withTenant(ctx,async tx=>{
    const rows=await tx.execute(sql`select app.manual_identity_authorized(${identity.issuer}) allowed,
      exists(select 1 from app.principal_by_identity(${identity.issuer},${identity.subject}) p
        where p.app_user_id=${ctx.userId}::uuid and p.tenant_id=${ctx.tenantId}::uuid) bound`) as unknown as {allowed:boolean;bound:boolean}[];
    return rows[0]?.allowed&&rows[0]?.bound;
  });
  if(!allowed)throw new ManualIdentityError('forbidden');
  return ctx;
}
