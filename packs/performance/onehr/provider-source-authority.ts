/** Additional source prerequisite only. Native assignment/field/file owners still decide visibility. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../../db/client';
import {assertAiPrincipalTx} from '../../../core/ai-principal';
import {assertModuleEnabled,resolveEntitlementsTx} from '../../../core/entitlements';
export async function assertPerformanceProviderSourceTx(tx:Tx,ctx:SessionContext):Promise<void>{
 await assertAiPrincipalTx(tx,ctx);
 // Finite native writer custody. TRY refusal requires caller-Tx rollback; no provider latency here.
 await tx.execute(sql`select app.performance_provider_source_read_hold_v1()`);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 assertModuleEnabled(fresh,'performance');
}
