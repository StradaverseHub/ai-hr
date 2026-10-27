/** Finite native Claims source ownership. Canonical RLS/subject/field readers remain authoritative. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assertAiPrincipalTx} from './ai-principal';
import {assertModuleEnabled,resolveEntitlementsTx} from './entitlements';
export async function assertClaimsProviderSourceTx(tx:Tx,ctx:SessionContext):Promise<SessionContext>{
 await assertAiPrincipalTx(tx,ctx);
 await tx.execute(sql`select app.claims_provider_source_read_hold_v1()`);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 assertModuleEnabled(fresh,'claims');return fresh;
}
