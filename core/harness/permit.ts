/** ADR-0169 §5.1 and ADR-0170 §11.3 change 4, wiring — the only production way to enable the turn runner.
 *
 * A permit is an opaque, single-use object bound to one tenant and one login. Only the Noveri conversation switch
 * (core/teras-wiring/switch.ts) issues one, after reading in the caller's own transaction that the tenant's
 * `conversation` worker is switched on and not stopped (test/teras-wiring-boundary.test.ts pins the issuer). The
 * runner accepts a permit only for the same tenant and login and consumes it, so a permit cannot be replayed for
 * a second turn, carried to another tenant, or forged: a structural copy is not in the registry. */

type Binding={tenantId:string;userId:string;used:boolean};
const issued=new WeakMap<object,Binding>();
export type HarnessPermit=Readonly<{readonly __terasHarnessPermit?:never}>;

/** INTERNAL issuer: the conversation switch only. */
export function issueHarnessPermit(tenantId:string,userId:string):HarnessPermit{
 if(!tenantId||!userId)throw Error('A harness permit needs a tenant and a login.');
 const permit=Object.freeze({}) as HarnessPermit;issued.set(permit,{tenantId,userId,used:false});return permit;
}
/** True once, for the tenant and login it was issued to. */
export function consumeHarnessPermit(permit:unknown,tenantId:string,userId:string|undefined):boolean{
 if(!permit||typeof permit!=='object')return false;
 const binding=issued.get(permit);
 if(!binding||binding.used||binding.tenantId!==tenantId||binding.userId!==userId)return false;
 binding.used=true;return true;
}
