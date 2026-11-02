/** Exact maintenance purposes. Runtime chain resolution reads its own native reference sources. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
export type LeaveApprovalCompanyFunction='leaveApproval.assignments'|'leaveApproval.escalation';
export async function assertLeaveApprovalCompanyTx(tx:Tx,key:LeaveApprovalCompanyFunction,operation:'view'|'add'|'edit'|'delete',companyId:string){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.leave_approval_company_allowed(${key},${operation},${companyId}::uuid) as allowed`);
 if(row?.allowed!==true)throw new Error('Leave approval company action unavailable');
}
export function leaveApprovalCompanyAccess(ctx:SessionContext,key:LeaveApprovalCompanyFunction,companyId:string,operations:readonly ('view'|'add'|'edit'|'delete')[]){
 return withTenant(ctx,tx=>Promise.all(operations.map(async operation=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.leave_approval_company_allowed(${key},${operation},${companyId}::uuid) as allowed`);return row?.allowed===true;})));
}
