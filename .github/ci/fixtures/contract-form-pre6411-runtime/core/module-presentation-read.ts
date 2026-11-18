/** One authorized snapshot owner for pure module presentation reads.
 * Commands, AI/provider admission and settlement retain their current owners.
 * Consumers must use the supplied Tx explicitly and settle all work before return. */
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertReadCompositionPrincipalTx} from './read-composition-principal';
import {resolveEntitlementsTx} from './entitlements';
import {assertModuleGate} from './module-gate';

export async function withModulePresentationRead<T>(supplied:SessionContext,module:string,
 read:(tx:Tx,currentCtx:SessionContext)=>Promise<T>):Promise<T>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 return withTenant(ctx,async tx=>{
  // Existing principal owner refuses exempt/statutory/agent contexts first. Do
  // not strip markers and accidentally reach the module gate's legacy exemption.
  await assertReadCompositionPrincipalTx(tx,ctx);
  const currentCtx={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsError:undefined};
  assertModuleGate(currentCtx,module);
  return await read(tx,currentCtx);
 },{readOnlySnapshot:true});
}
