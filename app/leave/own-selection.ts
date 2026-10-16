/** Explicit own-entry validation. This narrows navigation; request/cancel owners remain authoritative. */
import type {SessionContext} from '@/db/client';
import {allowedCompanies} from '@/core/read';
import {ownLiveEmployment} from '@/core/own-employment-selection';
import {OwnEmploymentSelectionError} from '@/lib/own-employment-selection';
import {getScopeIds} from '@/lib/scope';
export async function selectedOwnLeaveSubject(ctx:SessionContext,selected:string){
 const subject=await ownLiveEmployment(ctx,selected);
 const scopeIds=await getScopeIds((await allowedCompanies(ctx)).map(row=>row.id));
 if(!scopeIds.includes(subject.companyProof.companyId!))throw new OwnEmploymentSelectionError();
 return subject;
}
export async function validateOwnLeaveReturn(ctx:SessionContext,form:FormData){
 const selected=new URLSearchParams(String(form.get('leaveContext')??'')).get('employmentId');
 if(selected)await selectedOwnLeaveSubject(ctx,selected);
}
