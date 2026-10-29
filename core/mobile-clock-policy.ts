/** Shared deployment policy owner. No vendor imports, network work or independent DB transaction. */
import type {SessionContext,Tx} from '../db/client';
import {MobileClockRolloutPolicy} from '../lib/mobile-clock-rollout-policy';
import {ownIntegrityEnrollmentCompanyTx} from './mobile-integrity-key';
export class ClockPolicyUnavailableError extends Error{
 constructor(){super('Clock policy unavailable');this.name='ClockPolicyUnavailableError';}
}
export class ClockIntegrityRequiredError extends Error{
 constructor(){super('Signed device clocking required');this.name='ClockIntegrityRequiredError';}
}
/** No cache/default rollout. Missing policy preserves established channels; malformed configured
 * policy never silently restores them. Call only after proving the own subject and company. */
export function mobileClockRolloutEntry(ctx:SessionContext,companyId:string){
 const raw=process.env.AIHR_MOBILE_CLOCK_POLICY;
 if(!raw)return null;
 if(Buffer.byteLength(raw,'utf8')>262144)throw new ClockPolicyUnavailableError();
 let value:unknown;try{value=JSON.parse(raw);}catch{throw new ClockPolicyUnavailableError();}
 const policy=MobileClockRolloutPolicy.safeParse(value);if(!policy.success)throw new ClockPolicyUnavailableError();
 return policy.data.entries.find(entry=>entry.tenantId===ctx.tenantId&&entry.companyId===companyId&&entry.actorIds.includes(ctx.userId!))??null;
}
/** Used only by the shared UNSIGNED self-service writer, before and after tentative work. The signed
 * seam is internal and must be entered through its proof owner and deployment commit guard. */
export async function assertLegacySelfServiceClockTx(tx:Tx,ctx:SessionContext,employmentId:string){
 if(!process.env.AIHR_MOBILE_CLOCK_POLICY)return;
 const companyId=await ownIntegrityEnrollmentCompanyTx(tx,ctx,employmentId);
 if(!companyId)throw new ClockPolicyUnavailableError();
 if(mobileClockRolloutEntry(ctx,companyId)?.legacySelfService==='require_signed')throw new ClockIntegrityRequiredError();
}
