import {and,eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {payrollBatch,payrollInput} from '../../db/schema';
import {resolvePayrollPermission,PayrollPermissionDeniedError} from '../../core/payroll';
/** Historical payout references, never an assertion that a manually edited bonus still matches an award. */
export async function rewardPayrollProvenance(ctx:SessionContext,batchId:string){
 return withTenant(ctx,async tx=>{
  const [batch]=await tx.select({companyId:payrollBatch.companyId}).from(payrollBatch).where(eq(payrollBatch.id,batchId));
  if(!batch||!await resolvePayrollPermission(tx,ctx,'report.read.compensation',batch.companyId))throw new PayrollPermissionDeniedError('report.read.compensation');
  return tx.select({employmentId:payrollInput.employmentId,sources:payrollInput.rewardProvenance}).from(payrollInput).where(and(eq(payrollInput.batchId,batchId)));
 });
}
