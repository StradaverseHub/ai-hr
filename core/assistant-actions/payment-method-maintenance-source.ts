/** Human-reviewed employment routing. Bank values stay inside core/org's native readiness owner. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {PaymentMethodMaintenance as C,type PaymentMethodMaintenanceHuman as Human} from '../../lib/assistant-actions/payment-method-maintenance-contract';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {requirePackFor} from '../../localization/registry';
import {withAgentActionGuard} from './agent-action-guard';
import type {AssignedSubject} from './generic-assigned-review-store';
import {masterReportFieldsTx} from '../employee-master-access';
import {lockProfileValueWritesTx} from '../access-configuration-lock';
import {prepareEmploymentPaymentMethodTx,setEmploymentPaymentMethod} from '../org';
export class PaymentMethodMaintenanceUnavailable extends Error{constructor(){super('Please reopen payment method on the Personnel screen.');this.name='PaymentMethodMaintenanceUnavailable';}}
export const paymentMethodMaintenanceUnavailable=():never=>{throw new PaymentMethodMaintenanceUnavailable();};
const fail=paymentMethodMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=AssignedSubject&{employeeName:string;employeeCode:string|null;companyName:string;country:string;scopeDigest:string};
async function actor(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh))return fail();await tx.execute(sql`select app.access_workforce_write_lock()`);await lockProfileValueWritesTx(tx,fresh.tenantId);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_payment_method_scope(${id}::uuid) as scope`),s=row?.scope;if(!s||s.subjectPersonId===ctx.personId)return fail();
 const fields=await masterReportFieldsTx(tx,ctx,[s.companyId]);if(!fields.some(f=>f.owner==='payrollProfile'&&f.ownerField==='paymentMethod'&&f.sensitivity==='payroll'))return fail();
 if(requirePackFor(s.country).country!=='MY')return fail();return s;
}
export async function withPaymentMethodMaintenanceSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:AssignedSubject)=>Promise<T>):Promise<T>{const fresh=await actor(tx,ctx);return work(fresh,await subject(tx,fresh,id));}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.employmentId);if(human.subjectId!==s.subjectId)return fail();const native=await prepareEmploymentPaymentMethodTx(tx,ctx,human);if(native.personId!==s.subjectPersonId||native.companyId!==s.companyId||native.paymentMethod!==human.expectedMethod||native.paymentMethod===human.paymentMethod)return fail();
 const configuration=await tx.execute(sql`select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) as permissions from payroll_permission_grant p where p.tenant_id=${ctx.tenantId}::uuid`);
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,supported:true,before:native.paymentMethod,after:human.paymentMethod,readiness:native.readiness,effects:C.effects});
 return{review:item,reviewedDigest:hash([1,C.action,s,native,Array.from(configuration),canonicalEntitlementsForDigest(ctx.entitlements),item])};
}
export const preparePaymentMethodMaintenanceSourceTx=review;
export async function confirmPaymentMethodMaintenanceSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();const native=await setEmploymentPaymentMethod(ctx,{employmentId:human.employmentId,paymentMethod:human.paymentMethod},tx);if(!native.changed)return fail();
 const [proof]=await tx.execute(sql`select e.id from employment e join domain_event d on d.aggregate_id=e.id and d.tenant_id=e.tenant_id where e.id=${human.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid and e.xmin=pg_current_xact_id()::xid and coalesce(to_jsonb(e.payment_method),'null'::jsonb)= ${JSON.stringify(human.paymentMethod)}::jsonb and d.id=${native.eventId}::uuid and d.xmin=pg_current_xact_id()::xid and d.event_type='employment.payment-method.changed' and d.aggregate_type='employment' and d.subject_employment_id=e.id and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid and d.payload->'before'=${JSON.stringify(human.expectedMethod)}::jsonb and d.payload->'after'=${JSON.stringify(human.paymentMethod)}::jsonb`);
 if(!proof)return fail();return{eventId:native.eventId,receipt:await reconcilePaymentMethodMaintenanceSourceTx(tx,ctx,{subjectId:human.subjectId,employmentId:human.employmentId,eventId:native.eventId})};
}
export async function reconcilePaymentMethodMaintenanceSourceTx(tx:Tx,ctx:SessionContext,p:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,p.employmentId);if(s.subjectId!==p.subjectId)return fail();const [row]=await tx.execute<{before:unknown;after:unknown}>(sql`select d.payload->'before' as before,d.payload->'after' as after from domain_event d where d.id=${p.eventId}::uuid and d.tenant_id=${ctx.tenantId}::uuid and d.aggregate_id=${p.employmentId}::uuid and d.subject_employment_id=${p.employmentId}::uuid and d.aggregate_type='employment' and d.event_type='employment.payment-method.changed' and d.actor_type='user' and d.actor_id=${ctx.userId}::uuid`);if(!row)return fail();return C.Receipt.parse({kind:'maintained',...p,...row});
}
export async function readPaymentMethodMaintenanceChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await actor(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string;supported:boolean}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName",(c.country='MY' and e.terminated_on is null) as supported from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and app.is_admin_for(e.company_id) and app.access_workforce_employment(e.id,'workforce.maintain') and not app.is_self_person(e.person_id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const shown=Array.from(rows).slice(0,25);let truncated=rows.length>25,current:null|{paymentMethod:Human['paymentMethod']}=null;
 if(pick.employmentId){const s=await subject(tx,fresh,pick.employmentId),native=await prepareEmploymentPaymentMethodTx(tx,fresh,{employmentId:s.employmentId,paymentMethod:null});current={paymentMethod:native.paymentMethod};if(!shown.some(r=>r.employmentId===s.employmentId)){if(shown.length===25){shown.pop();truncated=true;}shown.push({employmentId:s.employmentId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,supported:true});}}
 return C.Choices.parse({kind:'choices',employees:shown,truncated,current});
}
