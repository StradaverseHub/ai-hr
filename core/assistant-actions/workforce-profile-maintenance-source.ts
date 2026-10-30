/** Native positive Workforce profile command; purpose DTOs only, no HR-role assumption or model call. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {WorkforceProfileMaintenance as C,type WorkforceProfileMaintenanceHuman as Human} from '../../lib/assistant-actions/workforce-profile-maintenance-contract';
import {workforceMaintenanceFields} from '../../lib/workforce-maintenance-fields';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {lockProfileValueWritesTx} from '../access-configuration-lock';
import {workforceEditorTx,previewWorkforceProfileSectionTx,maintainWorkforceRecord} from '../workforce-maintenance';
export class WorkforceProfileMaintenanceUnavailable extends Error{constructor(){super('Please reopen the employee profile review.');this.name='WorkforceProfileMaintenanceUnavailable';}}
export const workforceProfileMaintenanceUnavailable=():never=>{throw new WorkforceProfileMaintenanceUnavailable();};
const fail=workforceProfileMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;scopeDigest:string};
export async function assertWorkforceProfileMaintenanceActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await lockProfileValueWritesTx(tx,fresh.tenantId);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Omit<Subject,'employmentId'|'subjectId'|'subjectPersonId'>&{personId:string}|null}>(sql`select app.assistant_workforce_profile_scope(${id}::uuid) as scope`);if(!row?.scope||row.scope.personId===ctx.personId)return fail();const {personId,...metadata}=row.scope;return{...metadata,employmentId:id,subjectId:personId,subjectPersonId:personId};
}
export async function withWorkforceProfileMaintenanceIntervalTx<T>(tx:Tx,ctx:SessionContext,employmentId:string,work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await assertWorkforceProfileMaintenanceActorTx(tx,ctx);return work(fresh,await subject(tx,fresh,employmentId));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId);if(human.employmentId!==human.subjectId)return fail();
 const native=await previewWorkforceProfileSectionTx(tx,ctx,human),item=C.Item.parse({employmentId:s.employmentId,subjectId:s.employmentId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,section:human.section,before:native.before,after:native.after,sharedPerson:true});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native])};
}
export const prepareWorkforceProfileMaintenanceSourceTx=review;
export async function confirmWorkforceProfileMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const done=await maintainWorkforceRecord(ctx,{employmentId:human.employmentId,kind:'person',rowId:null,operation:'update',patch:human.values,expectedVersion:human.expectedVersion},tx);if(!done.changed)return fail();
 const [row]=await tx.execute<{eventId:string|null}>(sql`select app.assistant_workforce_profile_current_event(${human.employmentId}::uuid) as "eventId"`);if(!row?.eventId)return fail();return{eventId:row.eventId,receipt:await reconcileWorkforceProfileMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:row.eventId})};
}
export async function reconcileWorkforceProfileMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.employmentId);if(reference.employmentId!==reference.subjectId)return fail();
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_workforce_profile_receipt(${reference.employmentId}::uuid,${reference.eventId}::uuid) as receipt`);return C.Receipt.parse(row?.receipt);
}
export async function readWorkforceProfileMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await assertWorkforceProfileMaintenanceActorTx(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;subjectId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select x.value->>'employmentId' as "employmentId",x.value->>'employmentId' as "subjectId",x.value->>'name' as "employeeName",x.value->>'employeeCode' as "employeeCode",x.value->>'company' as "companyName" from app.access_workforce_list_rows() x(value) cross join lateral (select app.assistant_workforce_profile_choice_scope((x.value->>'employmentId')::uuid) as scope) s where s.scope is not null and (x.value->>'name' ilike ${pattern} or coalesce(x.value->>'employeeCode','') ilike ${pattern}) order by x.value->>'name',x.value->>'employmentId' limit 26`);
 const shown=Array.from(employees).slice(0,25);let truncated=employees.length>25;let selected:unknown=null,options:{category:string;value:string;label:string}[]=[];
 if(pick.employmentId){const nominated=await subject(tx,fresh,pick.employmentId),workspace=await workforceEditorTx(tx,pick.employmentId);if(!workspace||!workspace.sharedMaintain)return fail();const section=pick.section??'personal',values=Object.fromEntries(workforceMaintenanceFields('person',section).map(({key})=>[key,workspace.profile[key as keyof typeof workspace.profile]]));selected={employmentId:nominated.employmentId,subjectId:nominated.employmentId,section,expectedVersion:workspace.profileVersion,values};options=workspace.options;
  if(!shown.some(row=>row.employmentId===nominated.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:nominated.employmentId,subjectId:nominated.employmentId,employeeName:nominated.employeeName,employeeCode:nominated.employeeCode,companyName:nominated.companyName});}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,selected,options});
}
