/** Additional source prerequisite only. Native assignment/field/file owners still decide visibility. */
import type {SessionContext,Tx} from '../../../db/client';
import {assertAiPrincipalTx} from '../../../core/ai-principal';
import {assertModuleEnabled,resolveEntitlementsTx} from '../../../core/entitlements';
export async function assertPerformanceProviderSourceTx(tx:Tx,ctx:SessionContext):Promise<void>{
 await assertAiPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 assertModuleEnabled(fresh,'performance');
}
