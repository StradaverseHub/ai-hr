/** HR Workforce entry points compose the capability owner with existing canonical writers.
 * Independent approval/posting services keep importing their existing owner, never a manufactured HR role.
 */
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assertWorkforceCompanyTx,assertWorkforceEmploymentTx,assertWorkforcePersonTx} from './workforce-access';
import * as org from './org';
async function maintain<T>(ctx:SessionContext,employmentId:string,write:(tx:Tx)=>Promise<T>,outerTx?:Tx){
 const run=async(tx:Tx)=>{await assertWorkforceEmploymentTx(tx,ctx,employmentId,'maintain');return write(tx);};
 return outerTx?run(outerTx):withTenant(ctx,run);
}
export function hireEmployee(ctx:SessionContext,p:Parameters<typeof org.hireEmployee>[1],outerTx?:Tx){
 const run=async(tx:Tx)=>{
  await assertWorkforceCompanyTx(tx,ctx,p.companyId,'maintain');
  if(p.person.id)await assertWorkforcePersonTx(tx,ctx,p.person.id,'maintain');
  return org.hireEmployee(ctx,p,tx);
 };
 return outerTx?run(outerTx):withTenant(ctx,run);
}
export function setEmploymentInfo(ctx:SessionContext,p:Parameters<typeof org.setEmploymentInfo>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentInfo(ctx,p,tx),outerTx);}
export function setEmploymentGrade(ctx:SessionContext,p:Parameters<typeof org.setEmploymentGrade>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentGrade(ctx,p,tx),outerTx);}
export function setEmploymentAssignment(ctx:SessionContext,p:Parameters<typeof org.setEmploymentAssignment>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentAssignment(ctx,p,tx),outerTx);}
export function setEmploymentBlacklist(ctx:SessionContext,p:Parameters<typeof org.setEmploymentBlacklist>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.setEmploymentBlacklist(ctx,p,tx),outerTx);}
export function transferEmployee(ctx:SessionContext,p:Parameters<typeof org.transferEmployee>[1],outerTx?:Tx){return maintain(ctx,p.employmentId,tx=>org.transferEmployee(ctx,p,tx),outerTx);}
export function setReportingLine(ctx:SessionContext,p:Parameters<typeof org.setReportingLine>[1],outerTx?:Tx){
 // Delegation is its own relationship owner; structural reporting is a Workforce mutation.
 if(p.lineType==='delegate')return org.setReportingLine(ctx,p,outerTx);
 return maintain(ctx,p.subordinateEmploymentId,tx=>org.setReportingLine(ctx,p,tx),outerTx);
}
