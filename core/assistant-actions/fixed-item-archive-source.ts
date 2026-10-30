/** Local human archive only, using Payroll's existing command and existing native company authority. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {FixedItemArchive as C,type FixedItemArchiveHuman as Human} from '../../lib/assistant-actions/fixed-item-archive-contract';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {masterReportFieldsTx} from '../employee-master-access';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {archiveEmploymentPayComponent,prepareFixedItemArchiveTx,lockFixedItemArchiveIntervalTx,FIXED_ARCHIVE_FIELDS_SQL} from '../../packs/payroll/service';
export class FixedItemArchiveUnavailable extends Error{constructor(){super('Please reopen this fixed item on the native Payroll screen.');this.name='FixedItemArchiveUnavailable';}}
export const fixedItemArchiveUnavailable=():never=>{throw new FixedItemArchiveUnavailable();};
const fail=fixedItemArchiveUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;scopeDigest:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();await lockAccessConfigurationTx(tx,fresh.tenantId);return fresh;}
async function visibility(tx:Tx,ctx:SessionContext,employmentId:string){
 const [scope]=await tx.execute<{companyId:string;personId:string}>(sql`select e.company_id as "companyId",e.person_id as "personId" from employment e where e.id=${employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid and app.can_admin_employment(e.id) and not app.is_self_person(e.person_id)`);if(!scope||scope.personId===ctx.personId)return fail();
 const fields=await masterReportFieldsTx(tx,ctx,[scope.companyId]);for(const field of ['componentName','amount','currency','validFrom','validTo','prorate','remarks'])if(!fields.some(f=>f.owner==='payItem'&&f.ownerField.toLowerCase()===field.toLowerCase()&&f.sensitivity==='payroll'))return fail();return scope;
}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_fixed_item_archive_scope(${id}::uuid) as scope`);const s=row?.scope;if(!s||s.subjectPersonId===ctx.personId)return fail();await visibility(tx,ctx,s.employmentId);
 await lockFixedItemArchiveIntervalTx(tx,ctx,{id,employmentId:s.employmentId});
 const [current]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_fixed_item_archive_scope(${id}::uuid) as scope`);if(JSON.stringify(current?.scope)!==JSON.stringify(s))return fail();return s;
}
export async function withFixedItemArchiveSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await actor(tx,ctx);return work(fresh,await subject(tx,fresh,id));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.subjectId);if(s.employmentId!==human.employmentId)return fail();
 const native=await prepareFixedItemArchiveTx(tx,ctx,{id:human.subjectId,employmentId:human.employmentId}),configuration=await tx.execute(sql`select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) as permissions from payroll_permission_grant p where p.tenant_id=${ctx.tenantId}::uuid`);
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,before:native.before,after:native.after,processedPeriods:[...new Set(native.payroll.filter(row=>row.status==='processed').map(row=>row.payPeriod))].sort()});
 return{review:item,reviewedDigest:hash([1,C.action,s,native,Array.from(configuration),canonicalEntitlementsForDigest(ctx.entitlements),item])};
}
export const prepareFixedItemArchiveSourceTx=review;
export async function confirmFixedItemArchiveSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();const native=await archiveEmploymentPayComponent(ctx,{id:human.subjectId,employmentId:human.employmentId},tx);
 const [proof]=await tx.execute<{fields:unknown}>(sql`select ${FIXED_ARCHIVE_FIELDS_SQL} as fields from employment_pay_component q join pay_component c on c.id=q.component_id and c.tenant_id=q.tenant_id join domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id where q.id=${human.subjectId}::uuid and q.employment_id=${human.employmentId}::uuid and q.tenant_id=${ctx.tenantId}::uuid and q.xmin=pg_current_xact_id()::xid and q.superseded_at is not null and d.id=${native.eventId}::uuid and d.xmin=pg_current_xact_id()::xid and d.aggregate_type='employment-pay-component' and d.event_type='employment-pay-component.archived' and d.subject_employment_id=q.employment_id and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.payload->>'archiveRowHash'=encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex')`);
 if(!proof||JSON.stringify(C.Fields.parse(proof.fields))!==JSON.stringify(current.review.after))return fail();return{eventId:native.eventId,receipt:await reconcileFixedItemArchiveSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:native.eventId})};
}
export async function reconcileFixedItemArchiveSourceTx(tx:Tx,ctx:SessionContext,p:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,p.subjectId);if(s.employmentId!==p.employmentId)return fail();const [event]=await tx.execute(sql`select d.id from domain_event d join employment_pay_component q on q.id=d.aggregate_id and q.tenant_id=d.tenant_id where q.id=${p.subjectId}::uuid and q.employment_id=${p.employmentId}::uuid and q.tenant_id=${ctx.tenantId}::uuid and q.superseded_at is not null and d.id=${p.eventId}::uuid and d.subject_employment_id=q.employment_id and d.aggregate_type='employment-pay-component' and d.event_type='employment-pay-component.archived' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid`);if(!event)return fail();return C.Receipt.parse({kind:'archived',...p});
}
export async function readFixedItemArchiveChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and app.can_admin_employment(e.id) and not app.is_self_person(e.person_id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const shown=Array.from(rows).slice(0,25);let truncated=rows.length>25,items:unknown[]=[];
 if(pick.employmentId){await visibility(tx,fresh,pick.employmentId);items=Array.from(await tx.execute(sql`select q.id,${FIXED_ARCHIVE_FIELDS_SQL} as fields from employment_pay_component q join pay_component c on c.id=q.component_id and c.tenant_id=q.tenant_id where q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${pick.employmentId}::uuid and q.superseded_at is null order by q.valid_from,q.id limit 101`));if(items.length>100)return fail();if(!shown.some(row=>row.employmentId===pick.employmentId)){
 const [selected]=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.id=${pick.employmentId}::uuid and e.tenant_id=${fresh.tenantId}::uuid and app.can_admin_employment(e.id) and not app.is_self_person(e.person_id)`);if(!selected)return fail();if(shown.length===25){shown.pop();truncated=true;}shown.push(selected);}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,items});
}
