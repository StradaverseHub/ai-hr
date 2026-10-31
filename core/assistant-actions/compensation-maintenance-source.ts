/** Personnel salary review: native-owned preview, exact human inputs and no provider call. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {CompensationMaintenance as C,type CompensationMaintenanceHuman as Human} from '../../lib/assistant-actions/compensation-maintenance-contract';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {withReviewedCompensationIntervalTx,reviewedCompensationHistoryTx,previewReviewedCompensationCommandTx,executeReviewedCompensationCommandTx,type ReviewedCompensationCommand} from '../comp';
export class CompensationMaintenanceUnavailable extends Error{constructor(){super('Please reopen the employee salary review.');this.name='CompensationMaintenanceUnavailable';}}
export const compensationMaintenanceUnavailable=():never=>{throw new CompensationMaintenanceUnavailable();};
const fail=compensationMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<Subject>(sql`select e.id as "subjectId",e.id as "employmentId",e.company_id as "companyId",e.person_id as "subjectPersonId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${id}::uuid and e.tenant_id=${ctx.tenantId}::uuid and (app.can_admin_employment(e.id) or app.can_admin_perfcomp_employment(e.id))`);
 if(!row||row.subjectPersonId===ctx.personId)return fail();return row;
}
export async function withCompensationMaintenanceSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,ctx);return withReviewedCompensationIntervalTx(tx,fresh,id,async()=>work(fresh,await subject(tx,fresh,id)));
}
const command=(human:Human):ReviewedCompensationCommand=>{
 if(human.operation==='supersede')return{operation:'supersede',input:{employmentId:human.employmentId,compensationId:human.compensationId!}};
 const f=human.fields!,values={employmentId:human.employmentId,basicSalary:Number(f.basicSalary),currency:f.currency,payMode:f.payMode,paymentTerm:f.paymentTerm,rateAmount:f.rateAmount===null?null:Number(f.rateAmount),remarks:f.remarks};
 return human.operation==='set'?{operation:'set',input:{...values,remarks:f.remarks??undefined,effectiveFrom:f.effectiveFrom}}:{operation:'edit',input:{...values,compensationId:human.compensationId!,validFrom:f.effectiveFrom}};
};
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId),native=await previewReviewedCompensationCommandTx(tx,ctx,command(human));
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,operation:human.operation,compensationId:human.compensationId,changes:native.changes,recalculationPeriods:native.recalculationPeriods});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native])};
}
export const prepareCompensationMaintenanceSourceTx=review;
export async function confirmCompensationMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const done=await executeReviewedCompensationCommandTx(tx,ctx,command(human));return{eventId:done.eventId,receipt:await reconcileCompensationMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:done.eventId})};
}
export async function reconcileCompensationMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 if(reference.subjectId!==reference.employmentId)return fail();await subject(tx,ctx,reference.employmentId);
 const [row]=await tx.execute<{compensationId:string;eventType:string}>(sql`select c.id as "compensationId",d.event_type as "eventType" from public.domain_event d join public.compensation c on c.id=d.aggregate_id and c.tenant_id=d.tenant_id and c.employment_id=d.subject_employment_id where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='compensation' and d.subject_employment_id=${reference.employmentId}::uuid and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.event_type in ('compensation.set','compensation.updated','compensation.superseded')`);
 if(!row)return fail();return C.Receipt.parse({kind:'maintained',...reference,compensationId:row.compensationId,operation:row.eventType==='compensation.set'?'set':row.eventType==='compensation.updated'?'edit':'supersede'});
}
export async function readCompensationMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''});await tx.execute(sql`select app.access_workforce_write_lock()`);
 const pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from public.employment e join public.person p on p.id=e.person_id and p.tenant_id=e.tenant_id join public.company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id) and (app.can_admin_employment(e.id) or app.can_admin_perfcomp_employment(e.id)) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 let nominated:Subject|null=null,history:Awaited<ReturnType<typeof reviewedCompensationHistoryTx>>=[];
 if(pick.employmentId)await withReviewedCompensationIntervalTx(tx,fresh,pick.employmentId,async()=>{nominated=await subject(tx,fresh,pick.employmentId!);history=await reviewedCompensationHistoryTx(tx,fresh,pick.employmentId!);});
 const shown=Array.from(employees).slice(0,25);let truncated=employees.length>25;
 const selected=nominated as Subject|null;if(selected&&!shown.some(row=>row.employmentId===selected.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:selected.employmentId,employeeName:selected.employeeName,employeeCode:selected.employeeCode,companyName:selected.companyName});}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,history:history.filter(row=>!row.fields.superseded)});
}
