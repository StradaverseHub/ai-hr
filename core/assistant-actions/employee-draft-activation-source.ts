/** Existing human-saved Draft activation. Unsupported captured shapes remain native handoffs. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {EmployeeDraftActivation as C,type EmployeeDraftActivationHuman as Human} from '../../lib/assistant-actions/employee-draft-activation-contract';
import {withAgentActionGuard} from './agent-action-guard';
import {saveAndCompleteEmployeeDraft,employeeIdRuleFor,previewSavedEmployeeDraftActivationTx} from '../employee-draft';
import {missingForCreation,missingToCreate,type EmployeeDraftData} from '../../lib/employee-draft-schema';
import {assertWorkforceCompanyTx} from '../workforce-access';
import {lockLeaveDependencyConfigurationTx} from '../leave-dependency-lock';
import {lockLabelCriteriaTx,labelUsableByCompany} from '../system-labels';
import {listLeaveTypes} from '../read';
import {requirePackFor} from '../../localization/registry';
import {onboardingDraftActivationContextTx} from '../../packs/lifecycle/service';
export class EmployeeDraftActivationUnavailable extends Error{constructor(){super('Please reopen the draft on the native Personnel screen.');this.name='EmployeeDraftActivationUnavailable';}}
export const employeeDraftActivationUnavailable=():never=>{throw new EmployeeDraftActivationUnavailable();};
const fail=employeeDraftActivationUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Commercial module/company arrays are sets; private digest ordering is not authority. */
export function employeeDraftActivationEntitlements(snapshot:SessionContext['entitlements']){
 if(!snapshot)return snapshot;
 return {...snapshot,enabledModules:[...new Set(snapshot.enabledModules)].sort(),scopedModules:Object.fromEntries(Object.entries(snapshot.scopedModules).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([code,companies])=>[code,[...new Set(companies)].sort()])),settings:Object.fromEntries(Object.entries(snapshot.settings).sort(([a],[b])=>a<b?-1:a>b?1:0))};
}
const allowed={profile:['fullName','primaryEmail','employeeCode','employeeIdMode','phone'],employment:['companyId','departmentId','employmentType','hiredOn'],payroll:['basicSalary','monthlyAllowance','payMode','paymentTerm','rateAmount','remarks']} as const;
/** A closed supported subset. No nonempty captured field may be silently ignored by this review. */
export function supportedEmployeeDraftActivationData(value:unknown):value is EmployeeDraftData{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const data=value as Record<string,unknown>;
 for(const [section,contents]of Object.entries(data)){
  if(section==='family'){if(!Array.isArray(contents)||contents.length)return false;continue;}
  if(section==='statutory'){if(!contents||typeof contents!=='object'||Array.isArray(contents)||Object.values(contents).some(v=>v!==null&&v!==''))return false;continue;}
  if(!Object.hasOwn(allowed,section)||!contents||typeof contents!=='object'||Array.isArray(contents))return false;
  const known=allowed[section as keyof typeof allowed] as readonly string[];
  if(Object.entries(contents).some(([key,v])=>typeof v!=='string'||v.length>2000||!known.includes(key)))return false;
 }
 return true;
}
export type DraftSelection={draftId:string;companyId:string};
export async function employeeDraftActivationActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();return fresh;}
export async function withEmployeeDraftActivationIntervalTx<T>(tx:Tx,ctx:SessionContext,selection:DraftSelection,work:(fresh:SessionContext,source:DraftSelection)=>Promise<T>){
 const fresh=await employeeDraftActivationActorTx(tx,ctx);await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,fresh.tenantId);await assertWorkforceCompanyTx(tx,fresh,selection.companyId,'maintain');await lockLabelCriteriaTx(tx,fresh.tenantId);return work(fresh,selection);
}
type Draft={id:string;data:unknown;currentStep:number;companyId:string;reservedEmployeeCode:string|null;revision:string};
async function source(tx:Tx,ctx:SessionContext,p:Human){
 await assertWorkforceCompanyTx(tx,ctx,p.companyId,'maintain');
 const [draft]=await tx.execute<Draft>(sql`select d.id,d.data,d.current_step as "currentStep",d.company_id as "companyId",d.reserved_employee_code as "reservedEmployeeCode",d.xmin::text as revision from employee_draft d where d.id=${p.draftId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.company_id=${p.companyId}::uuid for update`);
 if(!draft||!draft.reservedEmployeeCode||!supportedEmployeeDraftActivationData(draft.data))return fail();const data=draft.data;
 if(data.employment?.companyId!==p.companyId||data.profile?.employeeCode!==draft.reservedEmployeeCode||missingForCreation(data).length||missingToCreate(data).length)return fail();
 const [company]=await tx.execute<{name:string;country:string;currency:string;snapshot:unknown}>(sql`select c.legal_name as name,c.country,c.currency,to_jsonb(c) as snapshot from company c where c.id=${p.companyId}::uuid and c.tenant_id=${ctx.tenantId}::uuid and c.archived_at is null and app.is_admin_for(c.id) for share`);if(!company)return fail();
 // This reviewed subset has been traced through the currently registered MY activation owner only.
 const pack=requirePackFor(company.country);if(pack.country!=='MY')return fail();
 const departmentId=data.employment?.departmentId;if(!departmentId)return fail();
 const [department]=await tx.execute<{name:string;snapshot:unknown}>(sql`select d.name,to_jsonb(d) as snapshot from department d where d.id=${departmentId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.archived_at is null for share`);if(!department||!await labelUsableByCompany(tx,ctx.tenantId,'department',departmentId,p.companyId))return fail();
 const lifecycle=await onboardingDraftActivationContextTx(ctx,tx);if(lifecycle.willSynchronize)return fail();
 const rule=await employeeIdRuleFor(ctx,p.companyId,tx),types=(await listLeaveTypes(ctx,{},tx)).filter(t=>['ANNUAL','SICK','HOSPITALIZATION'].includes(t.code));if(types.length>30)return fail();
 const configuration=await tx.execute<{kind:string;rows:unknown}>(sql`select 'payroll' as kind,coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) as rows from company_payroll_config c where c.tenant_id=${ctx.tenantId}::uuid and c.company_id=${p.companyId}::uuid union all select 'criteria',coalesce(jsonb_agg(to_jsonb(c) order by c.label_kind),'[]'::jsonb) from system_label_criteria_epoch c where c.tenant_id=${ctx.tenantId}::uuid union all select 'templates',coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) from entitlement_template c where c.tenant_id=${ctx.tenantId}::uuid union all select 'eligibility',coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) from entitlement_eligibility_rule c where c.tenant_id=${ctx.tenantId}::uuid`);
 const fields=Object.entries(data).flatMap(([section,contents])=>Object.hasOwn(allowed,section)?Object.entries(contents as Record<string,string>).map(([key,value])=>({section,key,value})):[]);
 const native=await previewSavedEmployeeDraftActivationTx(tx,ctx,{id:p.draftId,data,currentStep:draft.currentStep}),pay=native.compensation;
 const review=C.Item.parse({draftId:p.draftId,companyId:p.companyId,companyName:company.name,country:company.country,currency:pay.currency,departmentName:department.name,reservedEmployeeCode:draft.reservedEmployeeCode,fields,standingLeaveTypes:types.map(t=>({id:t.id,code:t.code,name:t.name})),openingLeaveGrants:native.openingLeaveGrants,initialBasicSalary:pay.basicSalary,initialMonthlyAllowance:pay.monthlyAllowance,payMode:pay.payMode,paymentTerm:pay.paymentTerm,rateAmount:pay.rateAmount??'',remarks:pay.remarks??''});
 return{draft,data,review,reviewedDigest:hash([1,C.action,draft,company.snapshot,department.snapshot,rule,types,Array.from(configuration).sort((a,b)=>a.kind<b.kind?-1:a.kind>b.kind?1:0),lifecycle,native,employeeDraftActivationEntitlements(ctx.entitlements)])};
}
export async function prepareEmployeeDraftActivationSourceTx(tx:Tx,ctx:SessionContext,human:Human){const native=await source(tx,ctx,human);return{content:human,review:native.review,reviewedDigest:native.reviewedDigest};}
export async function confirmEmployeeDraftActivationSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await source(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const done=await saveAndCompleteEmployeeDraft(ctx,{id:human.draftId,data:current.data,currentStep:current.draft.currentStep},tx);
 const rows=await tx.execute<{eventId:string}>(sql`select d.id as "eventId" from domain_event d where d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-draft' and d.aggregate_id=${human.draftId}::uuid and d.event_type='employee-draft.completed' and d.subject_employment_id=${done.employmentId}::uuid and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.xmin=pg_current_xact_id()::xid`);if(rows.length!==1)return fail();
 return reconcileEmployeeDraftActivationSourceTx(tx,ctx,{draftId:human.draftId,companyId:human.companyId,eventId:rows[0].eventId});
}
export async function reconcileEmployeeDraftActivationSourceTx(tx:Tx,ctx:SessionContext,reference:{draftId:string;companyId:string;eventId:string}){
 await assertWorkforceCompanyTx(tx,ctx,reference.companyId,'maintain');
 const [row]=await tx.execute<{employmentId:string;personId:string;employeeCode:string}>(sql`select e.id as "employmentId",e.person_id as "personId",d.payload->>'reservedEmployeeCode' as "employeeCode" from domain_event d join employment e on e.id=d.subject_employment_id and e.tenant_id=d.tenant_id where d.id=${reference.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_type='employee-draft' and d.aggregate_id=${reference.draftId}::uuid and d.event_type='employee-draft.completed' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and e.company_id=${reference.companyId}::uuid and d.payload->>'employmentId'=e.id::text and d.payload->>'companyId'=e.company_id::text`);if(!row)return fail();
 return C.Receipt.parse({kind:'activated',draftId:reference.draftId,companyId:reference.companyId,eventId:reference.eventId,employmentId:row.employmentId,personId:row.personId,employeeCode:row.employeeCode,semantics:'employment_created_not_payroll_processed_or_access_granted'});
}
export async function readEmployeeDraftActivationChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await employeeDraftActivationActorTx(tx,ctx),pick=C.Selection.parse(selection??{});await tx.execute(sql`select app.access_workforce_write_lock()`);const lifecycle=await onboardingDraftActivationContextTx(fresh,tx);
 const rows=await tx.execute<{draftId:string;companyId:string;label:string;employeeCode:string|null;data:unknown;country:string}>(sql`select d.id as "draftId",d.company_id as "companyId",d.label,d.reserved_employee_code as "employeeCode",d.data,c.country from employee_draft d join company c on c.id=d.company_id and c.tenant_id=d.tenant_id where d.tenant_id=${fresh.tenantId}::uuid and app.is_admin_for(c.id) and app.access_workforce_company(c.id,'workforce.maintain') and (${pick.companyId??null}::uuid is null or c.id=${pick.companyId??null}::uuid) order by d.updated_at desc,d.id desc limit 26`);
 return C.Choices.parse({kind:'choices',drafts:Array.from(rows).slice(0,25).map(r=>({draftId:r.draftId,companyId:r.companyId,label:r.label,employeeCode:r.employeeCode??'',supported:!lifecycle.willSynchronize&&r.country==='MY'&&!!r.employeeCode&&supportedEmployeeDraftActivationData(r.data)&&!missingForCreation(r.data as EmployeeDraftData).length&&!missingToCreate(r.data as EmployeeDraftData).length,unsupportedReason:lifecycle.willSynchronize?'configured_onboarding':r.country==='MY'&&!!r.employeeCode&&supportedEmployeeDraftActivationData(r.data)&&!missingForCreation(r.data as EmployeeDraftData).length&&!missingToCreate(r.data as EmployeeDraftData).length?null:'captured_shape',route:'/admin/personnel/new'})),truncated:rows.length>25});
}
