/** Shared-person bank destination: country registry/native partial owner, local human values only. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {BankMaintenance as C,type BankMaintenanceHuman as Human} from '../../lib/assistant-actions/bank-maintenance-contract';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {assertWorkforcePersonTx} from '../workforce-access';
import {lockProfileValueWritesTx} from '../access-configuration-lock';
import {masterReportFieldsTx} from '../employee-master-access';
import {assertModuleEnabled} from '../entitlements';
import {requirePackFor} from '../../localization/registry';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
export class BankMaintenanceUnavailable extends Error{constructor(){super('Please reopen Bank Information on the native Personnel screen.');this.name='BankMaintenanceUnavailable';}}
export const bankMaintenanceUnavailable=():never=>{throw new BankMaintenanceUnavailable();};
const fail=bankMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuidArray=(ids:readonly string[])=>sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;scopeDigest:string;country:string;companyIds:string[];statutoryId:string};
export async function assertBankMaintenanceActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();assertModuleEnabled(fresh,'payroll');assertModuleEnabled(fresh,'country-my');await tx.execute(sql`select app.access_workforce_write_lock()`);await lockProfileValueWritesTx(tx,fresh.tenantId);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [nomination]=await tx.execute<{scope:{personId:string;companyId:string;country:string;companyIds:string[];scopeDigest:string}|null}>(sql`select app.assistant_bank_maintenance_scope(${id}::uuid) as scope`);const scope=nomination?.scope;if(!scope)return fail();
 await assertWorkforcePersonTx(tx,ctx,scope.personId,'maintain');
 // Retained employments serialize under Access; hold actual company tuples against country/config edits.
 const companies=await tx.execute(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and id=any(${uuidArray(scope.companyIds)}) order by id for share nowait`);if(companies.length!==scope.companyIds.length)return fail();
 const [lockedScope]=await tx.execute<{scope:unknown}>(sql`select app.assistant_bank_maintenance_scope(${id}::uuid) as scope`);if(JSON.stringify(lockedScope?.scope)!==JSON.stringify(scope))return fail();
 // Every retained company must admit each sensitive category BEFORE the country owner's private snapshot.
 const fields=await masterReportFieldsTx(tx,ctx,scope.companyIds);for(const sensitivity of ['identity','bank','statutory','payroll'] as const)if(!fields.some(field=>field.sensitivity===sensitivity))return fail();
 const pack=requirePackFor(scope.country);if(pack.country!=='MY'||!pack.statutory.reviewedBank||!pack.statutory.reviewed)return fail();assertModuleEnabled(ctx,'country-my');
 const [row]=await tx.execute<{employeeName:string;employeeCode:string|null;companyName:string}>(sql`select p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${id}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.person_id=${scope.personId}::uuid`);
 if(!row||scope.personId===ctx.personId)return fail();const locked=await pack.statutory.reviewed.lockSubject(tx,ctx,scope.personId);
 return{...row,...scope,employmentId:id,subjectId:scope.personId,subjectPersonId:scope.personId,statutoryId:locked.statutoryId};
}
export async function withBankMaintenanceIntervalTx<T>(tx:Tx,ctx:SessionContext,employmentId:string,work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await assertBankMaintenanceActorTx(tx,ctx);return work(fresh,await subject(tx,fresh,employmentId));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId);if(s.subjectId!==human.subjectId)return fail();const pack=requirePackFor(s.country),owner=pack.statutory.reviewedBank;if(!owner)return fail();
 const native=await owner(tx,ctx,{personId:s.subjectId,...human.fields});
 const configuration=await tx.execute<{kind:string;rows:unknown}>(sql`select 'payroll' as kind,coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) as rows from company_payroll_config c where c.tenant_id=${ctx.tenantId}::uuid and c.company_id=any(${uuidArray(s.companyIds)}) union all select 'permissions',coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) from payroll_permission_grant c where c.tenant_id=${ctx.tenantId}::uuid`);
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,supported:true,country:s.country,before:native.before,after:native.after,sharedPerson:true});
 return{review:item,reviewedDigest:hash([1,C.action,s,native.reviewedDigest,Array.from(configuration).sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0),pack.client.bankNames,canonicalEntitlementsForDigest(ctx.entitlements),item])};
}
export const prepareBankMaintenanceSourceTx=review;
export async function confirmBankMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();const s=await subject(tx,ctx,human.employmentId),pack=requirePackFor(s.country);
 const row=await pack.statutory.setBank(ctx,{personId:s.subjectId,...current.review.after},tx);
 const events=await tx.execute<{eventId:string}>(sql`select d.id as "eventId" from domain_event d join employment e on e.id=d.subject_employment_id and e.tenant_id=d.tenant_id where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-statutory' and d.aggregate_id=${row.id}::uuid and e.person_id=${human.subjectId}::uuid and d.event_type='employee.bank.updated' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=pg_current_xact_id()::xid`);
 if(events.length!==1)return fail();const eventId=events[0].eventId;return{eventId,receipt:await reconcileBankMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId})};
}
export async function reconcileBankMaintenanceSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.employmentId);if(s.subjectId!==reference.subjectId)return fail();
 const [row]=await tx.execute<{statutoryId:string}>(sql`select d.aggregate_id as "statutoryId" from domain_event d join employment e on e.id=d.subject_employment_id and e.tenant_id=d.tenant_id and e.person_id=${reference.subjectId}::uuid where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.payload->>'personId'=${reference.subjectId} and d.aggregate_type='employee-statutory' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.event_type='employee.bank.updated'`);
 if(!row||row.statutoryId!==s.statutoryId)return fail();return C.Receipt.parse({kind:'maintained',...reference,statutoryId:row.statutoryId,sharedPerson:true});
}
export async function readBankMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await assertBankMaintenanceActorTx(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const employees=await tx.execute<{employmentId:string;subjectId:string;employeeName:string;employeeCode:string|null;companyName:string;country:string}>(sql`select e.id as "employmentId",e.person_id as "subjectId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName",c.country from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and not app.is_self_person(e.person_id) and app.access_workforce_person(e.person_id,'workforce.maintain') and app.can_admin_payroll_employment(e.id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 let current:null|ReturnType<typeof C.Fields.parse>=null,banks:string[]=[];const shown=Array.from(employees).slice(0,25).map(({country,...row})=>({...row,supported:country==='MY'}));let truncated=employees.length>25;
 if(pick.employmentId){const s=await subject(tx,fresh,pick.employmentId),pack=requirePackFor(s.country),profile=await pack.statutory.get(fresh,s.subjectId,tx);if(!profile)return fail();current=C.Fields.parse(Object.fromEntries(Object.keys(C.Fields.shape).map(key=>[key,profile[key as keyof typeof profile]])));banks=[...pack.client.bankNames];if(!shown.some(row=>row.employmentId===s.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,supported:true});}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,current,banks});
}
