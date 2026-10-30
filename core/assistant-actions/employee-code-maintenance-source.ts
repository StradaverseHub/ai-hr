/** SAME native positive employee-code command; employment grain, no HR role or model input. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {EmployeeCodeMaintenance as C,type EmployeeCodeMaintenanceHuman as Human} from '../../lib/assistant-actions/employee-code-maintenance-contract';
import {requireEmployeeCode} from '../../lib/employee-code';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {setWorkforceEmployeeCode} from '../workforce-code';
export class EmployeeCodeMaintenanceUnavailable extends Error{constructor(){super('Please reopen the employee ID review.');this.name='EmployeeCodeMaintenanceUnavailable';}}
export const employeeCodeMaintenanceUnavailable=():never=>{throw new EmployeeCodeMaintenanceUnavailable();};
const fail=employeeCodeMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;revision:string;generation:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await tx.execute(sql`select app.access_workforce_write_lock()`);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_employee_code_scope(${id}::uuid) as scope`);if(!row?.scope||row.scope.subjectPersonId===ctx.personId)return fail();return row.scope;}
export async function withEmployeeCodeMaintenanceSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await actor(tx,ctx);return work(fresh,await subject(tx,fresh,id));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId);if(human.subjectId!==human.employmentId||human.expectedCode!==s.employeeCode)return fail();const code=requireEmployeeCode(human.employeeCode);if(code===s.employeeCode)return fail();
 const [claim]=await tx.execute<{kind:string|null}>(sql`select app.employee_code_claim(${ctx.tenantId}::uuid,${code},${human.employmentId}::uuid,NULL) as kind`);if(claim?.kind)return fail();
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,before:s.employeeCode,after:code});return{review:item,reviewedDigest:hash([1,C.action,s,human,item])};
}
export const prepareEmployeeCodeMaintenanceSourceTx=review;
export async function confirmEmployeeCodeMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();const result=await setWorkforceEmployeeCode(ctx,{employmentId:human.employmentId,employeeCode:human.employeeCode,expectedCode:human.expectedCode},tx);if(!result.changed)return fail();
 const events=await tx.execute<{eventId:string}>(sql`select d.id as "eventId" from domain_event d where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employment' and d.aggregate_id=${human.employmentId}::uuid and d.subject_employment_id=${human.employmentId}::uuid and d.event_type='employment.employee-code.set' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=pg_current_xact_id()::xid and d.payload->'before'->'employeeCode'=${JSON.stringify(human.expectedCode)}::jsonb and d.payload->'after'->>'employeeCode'=${current.review.after}`);if(events.length!==1)return fail();const eventId=events[0].eventId;return{eventId,receipt:await reconcileEmployeeCodeMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId})};
}
export async function reconcileEmployeeCodeMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){if(reference.subjectId!==reference.employmentId)return fail();await subject(tx,ctx,reference.employmentId);const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_employee_code_receipt(${reference.employmentId}::uuid,${reference.eventId}::uuid) as receipt`);return C.Receipt.parse(row?.receipt);}
export async function readEmployeeCodeMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select x.value->>'employmentId' as "employmentId",x.value->>'name' as "employeeName",x.value->>'employeeCode' as "employeeCode",x.value->>'company' as "companyName" from app.access_workforce_list_rows() x(value) where app.assistant_employee_code_choice_scope((x.value->>'employmentId')::uuid) and (x.value->>'name' ilike ${pattern} or coalesce(x.value->>'employeeCode','') ilike ${pattern}) order by x.value->>'name',x.value->>'employmentId' limit 26`);
 const shown=Array.from(rows).slice(0,25);let truncated=rows.length>25;if(pick.employmentId){const s=await subject(tx,fresh,pick.employmentId);if(!shown.some(row=>row.employmentId===s.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:s.employmentId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName});}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated});
}
