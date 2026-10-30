/** Native HR qualification commands; no model call, raw provider input or parallel record owner. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {QualificationMaintenance as C,type QualificationMaintenanceHuman as Human} from '../../lib/assistant-actions/qualification-maintenance-contract';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {assertWorkforceEmploymentTx} from '../workforce-access';
import {lockProfileValueWritesTx} from '../access-configuration-lock';
import {validateQualificationInputTx} from '../qualifications';
import {addQualification,updateQualification,archiveQualification} from '../workforce-registers';
export class QualificationMaintenanceUnavailable extends Error{constructor(){super('Please reopen the employee qualification review.');this.name='QualificationMaintenanceUnavailable';}}
export const qualificationMaintenanceUnavailable=():never=>{throw new QualificationMaintenanceUnavailable();};
const fail=qualificationMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 await assertWorkforceEmploymentTx(tx,ctx,id,'maintain');
 const [row]=await tx.execute<Subject>(sql`select e.id as "subjectId",e.id as "employmentId",e.company_id as "companyId",e.person_id as "subjectPersonId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${id}::uuid and e.tenant_id=${ctx.tenantId}::uuid`);
 if(!row||row.subjectPersonId===ctx.personId)return fail();return row;
}
export async function withQualificationMaintenanceSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,ctx),s=await subject(tx,fresh,id);await lockProfileValueWritesTx(tx,fresh.tenantId);return work(fresh,s);
}
type Fields=Human['fields'];
async function records(tx:Tx,ctx:SessionContext,id:string){const rows=await tx.execute<{id:string;fields:Fields;revision:string}>(sql`select q.id,jsonb_build_object('qualification',q.qualification,'description',q.description,'fromYm',q.from_ym,'toYm',q.to_ym,'institute',q.institute,'major',q.major,'graduationDate',q.graduation_date,'result',q.result,'isHighest',q.is_highest) as fields,q.xmin::text as revision from employee_qualification q where q.tenant_id=${ctx.tenantId}::uuid and q.employment_id=${id}::uuid and q.archived_at is null order by q.id limit 101`);if(rows.length>100)return fail();return Array.from(rows).map(r=>({id:r.id,fields:C.Fields.parse(r.fields),revision:r.revision}));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId),rows=await records(tx,ctx,s.employmentId),existing=human.qualificationId?rows.find(r=>r.id===human.qualificationId):null;
 if(human.operation!=='add'&&!existing)return fail();
 const after=human.operation==='archive'?null:C.Fields.parse({...human.fields,...await validateQualificationInputTx(tx,human.fields!,existing?.fields)});
 const clearsHighestId=after?.isHighest?rows.find(r=>r.fields.isHighest&&r.id!==human.qualificationId)?.id??null:null;
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,operation:human.operation,qualificationId:human.qualificationId,before:existing?.fields??null,after,clearsHighestId,clearsHighest:clearsHighestId?{id:clearsHighestId,fields:rows.find(r=>r.id===clearsHighestId)!.fields}:null});
 return{review:item,reviewedDigest:hash([1,C.action,s,rows,item])};
}
export async function prepareQualificationMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human){return review(tx,ctx,human);}
export async function confirmQualificationMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const row=human.operation==='add'?await addQualification(ctx,{employmentId:human.employmentId,...current.review.after!},tx):human.operation==='update'?await updateQualification(ctx,{id:human.qualificationId!,...current.review.after!},tx):await archiveQualification(ctx,{id:human.qualificationId!},tx);
 const type=human.operation==='add'?'qualification.added':human.operation==='update'?'qualification.updated':'qualification.archived';
 const events=await tx.execute<{eventId:string}>(sql`select d.id as "eventId" from domain_event d where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-qualification' and d.aggregate_id=${row.id}::uuid and d.subject_employment_id=${human.employmentId}::uuid and d.event_type=${type} and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=pg_current_xact_id()::xid`);
 if(events.length!==1)return fail();const eventId=events[0].eventId;
 return{eventId,receipt:await reconcileQualificationMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId})};
}
export async function reconcileQualificationMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 if(reference.subjectId!==reference.employmentId)return fail();await subject(tx,ctx,reference.employmentId);
 const [row]=await tx.execute<{qualificationId:string;eventType:string}>(sql`select q.id as "qualificationId",d.event_type as "eventType" from domain_event d join employee_qualification q on q.id=d.aggregate_id and q.tenant_id=d.tenant_id and q.employment_id=d.subject_employment_id where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-qualification' and d.subject_employment_id=${reference.employmentId}::uuid and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.event_type in ('qualification.added','qualification.updated','qualification.archived')`);
 if(!row)return fail();return C.Receipt.parse({kind:'maintained',...reference,qualificationId:row.qualificationId,operation:row.eventType==='qualification.added'?'add':row.eventType==='qualification.updated'?'update':'archive'});
}
export async function readQualificationMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''});await tx.execute(sql`select app.access_workforce_write_lock()`);await lockProfileValueWritesTx(tx,fresh.tenantId);
 const pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id) and app.access_workforce_employment(e.id,'workforce.maintain') and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const qualifications=pick.employmentId?(await subject(tx,fresh,pick.employmentId),await records(tx,fresh,pick.employmentId)):[];
 const options=await tx.execute<{value:string;label:string}>(sql`select value,label from profile_option where tenant_id=${fresh.tenantId}::uuid and category='qualificationLevel' and is_active order by sort_order,value limit 201`);if(options.length>200)return fail();
 return C.Choices.parse({kind:'choices',employees:Array.from(employees).slice(0,25),truncated:employees.length>25,qualifications,options:Array.from(options)});
}
