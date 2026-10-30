/** Shared-person family register source. Same native owner/session as the HR form; no model call. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {FamilyMaintenance as C,type FamilyMaintenanceHuman as Human} from '../../lib/assistant-actions/family-maintenance-contract';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {assertWorkforcePersonTx} from '../workforce-access';
import {previewDependentCommandTx,dependentReviewRowsTx} from '../dependent-review';
import {lockProfileValueWritesTx} from '../access-configuration-lock';

import {addDependent,updateDependent,archiveDependent} from '../workforce-registers';
export class FamilyMaintenanceUnavailable extends Error{constructor(){super('Please reopen the employee Family review.');this.name='FamilyMaintenanceUnavailable';}}
export const familyMaintenanceUnavailable=():never=>{throw new FamilyMaintenanceUnavailable();};
const fail=familyMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;scopeDigest:string};
export async function assertFamilyMaintenanceActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();await tx.execute(sql`select app.access_workforce_write_lock()`);await lockProfileValueWritesTx(tx,fresh.tenantId);return fresh;}
/** Definer returns only a nomination and private scope fingerprint AFTER the same person's native
 * current authority and explicit denials across retained companies. Never require only the selected company. */
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [scope]=await tx.execute<{scope:{personId:string;companyId:string;scopeDigest:string}|null}>(sql`select app.assistant_family_maintenance_scope(${id}::uuid) as scope`);if(!scope?.scope)return fail();
 await assertWorkforcePersonTx(tx,ctx,scope.scope.personId,'maintain');
 const [row]=await tx.execute<{employeeName:string;employeeCode:string|null;companyName:string}>(sql`select p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${id}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.person_id=${scope.scope.personId}::uuid`);
 if(!row||scope.scope.personId===ctx.personId)return fail();return{...row,employmentId:id,subjectId:scope.scope.personId,subjectPersonId:scope.scope.personId,companyId:scope.scope.companyId,scopeDigest:scope.scope.scopeDigest};
}
export async function withFamilyMaintenanceIntervalTx<T>(tx:Tx,ctx:SessionContext,employmentId:string,work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{
 const fresh=await assertFamilyMaintenanceActorTx(tx,ctx);return work(fresh,await subject(tx,fresh,employmentId));
}
type Fields=Human['fields'];
async function records(tx:Tx,ctx:SessionContext,personId:string){return(await dependentReviewRowsTx(tx,personId)).filter(row=>!row.archived).map(({id,fields,revision})=>({id,fields,revision}));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId);if(s.subjectId!==human.subjectId)return fail();
 const native=await previewDependentCommandTx(tx,ctx,human);
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,operation:human.operation,dependentId:human.dependentId,before:native.before,after:native.after,relief:native.relief,sharedPerson:true});
 return{review:item,reviewedDigest:hash([1,C.action,s,native.sources,native.contextDigest,item])};
}
export async function prepareFamilyMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human){return review(tx,ctx,human);}
export async function confirmFamilyMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const row=human.operation==='add'?await addDependent(ctx,{personId:human.subjectId,...current.review.after!},tx):human.operation==='update'?await updateDependent(ctx,{id:human.dependentId!,...current.review.after!},tx):await archiveDependent(ctx,{id:human.dependentId!},tx);
 if(JSON.stringify(C.Relief.parse({...row.childReliefSync,values:current.review.relief.values}))!==JSON.stringify(current.review.relief))return fail();
 const type=human.operation==='add'?'dependent.added':human.operation==='update'?'dependent.updated':'dependent.archived';
 const events=await tx.execute<{eventId:string}>(sql`select d.id as "eventId" from domain_event d join employment e on e.id=d.subject_employment_id and e.tenant_id=d.tenant_id where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-dependent' and d.aggregate_id=${row.id}::uuid and e.person_id=${human.subjectId}::uuid and d.event_type=${type} and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=pg_current_xact_id()::xid`);
 if(events.length!==1)return fail();const eventId=events[0].eventId;return{eventId,receipt:await reconcileFamilyMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId})};
}
export async function reconcileFamilyMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.employmentId);if(s.subjectId!==reference.subjectId)return fail();
 const [row]=await tx.execute<{dependentId:string;eventType:string}>(sql`select q.id as "dependentId",d.event_type as "eventType" from domain_event d join employee_dependent q on q.id=d.aggregate_id and q.tenant_id=d.tenant_id join employment e on e.id=d.subject_employment_id and e.tenant_id=d.tenant_id and e.person_id=q.person_id where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and q.person_id=${reference.subjectId}::uuid and d.aggregate_type='employee-dependent' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.event_type in ('dependent.added','dependent.updated','dependent.archived')`);
 if(!row)return fail();return C.Receipt.parse({kind:'maintained',...reference,dependentId:row.dependentId,operation:row.eventType==='dependent.added'?'add':row.eventType==='dependent.updated'?'update':'archive',sharedPerson:true});
}
export async function readFamilyMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await assertFamilyMaintenanceActorTx(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;subjectId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",e.person_id as "subjectId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id) and app.access_workforce_person(e.person_id,'workforce.maintain') and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const nominated=pick.employmentId?await subject(tx,fresh,pick.employmentId):null,dependents=nominated?await records(tx,fresh,nominated.subjectId):[],shown=Array.from(employees).slice(0,25);let truncated=employees.length>25;
 if(nominated&&!shown.some(row=>row.employmentId===nominated.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:nominated.employmentId,subjectId:nominated.subjectId,employeeName:nominated.employeeName,employeeCode:nominated.employeeCode,companyName:nominated.companyName});}
 const options=await tx.execute<{value:string;label:string}>(sql`select value,label from profile_option where tenant_id=${fresh.tenantId}::uuid and category='dependentRelationship' and is_active order by sort_order,value limit 201`);if(options.length>200)return fail();return C.Choices.parse({kind:'choices',employees:shown,truncated,dependents,options:Array.from(options)});
}
