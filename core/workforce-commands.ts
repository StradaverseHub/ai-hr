/** HR Workforce entry points compose the capability owner with existing canonical writers.
 * Independent approval/posting services keep importing their existing owner, never a manufactured HR role.
 */
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertWorkforceEmploymentTx,assertWorkforcePersonTx} from './workforce-access';
import * as org from './org';
import {setPersonComplianceFields as writeComplianceFields} from './profile';
import {employment} from '../db/schema';
import {eq} from 'drizzle-orm';
const captureCommandContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
async function maintain<T>(ctx:SessionContext,employmentId:string,write:(tx:Tx)=>Promise<T>,outerTx?:Tx){
 const run=async(tx:Tx)=>{await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');return write(tx);};
 return outerTx?run(outerTx):withTenant(ctx,run);
}
export function hireEmployee(ctx:SessionContext,p:Parameters<typeof org.hireEmployee>[1],outerTx?:Tx){
 // The canonical hire owner now admits every caller before its first Criteria/data lock.
 return org.hireEmployee(ctx,p,outerTx);
}
export async function setEmploymentInfo(ctx:SessionContext,p:Parameters<typeof org.setEmploymentInfo>[1],outerTx?:Tx){ctx=captureCommandContext(ctx);p=structuredClone(p);return maintain(ctx,p.employmentId,tx=>org.setEmploymentInfo(ctx,p,tx),outerTx);}
export function setEmploymentGrade(ctx:SessionContext,p:Parameters<typeof org.setEmploymentGrade>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentGrade(ctx,p,tx),outerTx);}
export async function setEmploymentAssignment(ctx:SessionContext,p:Parameters<typeof org.setEmploymentAssignment>[1],outerTx?:Tx){ctx=captureCommandContext(ctx);p=structuredClone(p);return maintain(ctx,p.employmentId,tx=>org.setEmploymentAssignment(ctx,p,tx),outerTx);}
export function setEmploymentBlacklist(ctx:SessionContext,p:Parameters<typeof org.setEmploymentBlacklist>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentBlacklist(ctx,p,tx),outerTx);}
export async function transferEmployee(ctx:SessionContext,p:Parameters<typeof org.transferEmployee>[1],outerTx?:Tx){ctx=captureCommandContext(ctx);p=structuredClone(p);return maintain(ctx,p.employmentId,tx=>org.transferEmployee(ctx,p,tx),outerTx);}
export async function setReportingLine(ctx:SessionContext,p:Parameters<typeof org.setReportingLine>[1],outerTx?:Tx){
 ctx=captureCommandContext(ctx);p=structuredClone(p);
 // Delegation is its own relationship owner; structural reporting is a Workforce mutation.
 if(p.lineType==='delegate')return org.setReportingLine(ctx,p,outerTx);
 return maintain(ctx,p.subordinateEmploymentId,tx=>org.setReportingLine(ctx,p,tx),outerTx);
}

/** Direct HR compliance edits are distinct from an approved ESS proposal. Check both the selected
 * employment and the shared person before reusing the canonical validation/event writer. */
export function setPersonComplianceFields(ctx:SessionContext,p:Parameters<typeof writeComplianceFields>[1],outerTx?:Tx){
 return maintain(ctx,p.employmentId,async tx=>{
  const [subject]=await tx.select({personId:employment.personId}).from(employment).where(eq(employment.id,p.employmentId)).limit(1);
  if(!subject)throw new Error('Employment not found (or not visible).');
  await assertWorkforcePersonTx(tx,ctx,subject.personId,'maintain');
  return writeComplianceFields(ctx,p,tx);
 },outerTx);
}
