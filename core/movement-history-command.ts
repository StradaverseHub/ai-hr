/**
 * Board 154511c4 — New Event's "Record history": HR names a configured event type, its effective date and what
 * the employee had BEFORE that date; the After side is what is on record on the date. The same writer as the
 * Movement import (core/movement-history.ts) checks and writes it, in one tenant transaction under the same
 * locks the company leg of an Entity Transfer takes.
 */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {domainEvent} from '../db/schema';
import {isCalendarDate} from '../lib/calendar-date';
import {isMovementHistoryDateField} from '../lib/movement-form-contract';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {lockPayrollInputsTx} from './payroll-inputs-lock';
import {WorkforceAccessError,assertWorkforceEmploymentTx} from './workforce-access';
import {resolveMovementEventTypeTx} from './movement-type';
import {
 HISTORY_FIELDS,MovementHistoryError,closedPayrollInSpanTx,historyVersionsTx,latestHistoryMovementRevisionTx,
 recordHistoryMovementTx,reverseHistoryMovementTx,type HistoryDateFacts,type HistoryField,type HistoryMovementFacts,type HistoryValues,
 type RecordHistoryInput,
} from './movement-history';

type HistoryEntry={employmentId:string;typeCode:string;effectiveDate:string;before:Record<string,string|null>;remarks?:string|null;dates?:HistoryDateFacts};

async function applyHistoryEntryTx(tx:Tx,ctx:SessionContext,p:HistoryEntry,correction?:RecordHistoryInput['correction'],expectedAfter?:HistoryValues){
 const fields=Object.keys(p.before);
 if((!fields.length&&!Object.keys(p.dates??{}).length)||!fields.every(field=>(HISTORY_FIELDS as readonly string[]).includes(field)))throw new MovementHistoryError('movement_history_fields');
 if(Object.entries(p.before).some(([field,value])=>field!=='employmentType'&&value!==null&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)))throw new MovementHistoryError('movement_history_fields');
 if(Object.keys(p.dates??{}).some(field=>!isMovementHistoryDateField(field)))throw new MovementHistoryError('movement_history_fields');
 if(!isCalendarDate(p.effectiveDate))throw new MovementHistoryError('movement_history_future');
 const type=await resolveMovementEventTypeTx(tx,ctx.tenantId,p.typeCode);
 if(!type||!type.active&&!correction||correction&&type.behaviourKind!=='entityTransfer')throw new MovementHistoryError('movement_history_fields');
 const versions=await historyVersionsTx(tx,p.employmentId);
 const on=versions.find(v=>v.validFrom<=p.effectiveDate&&(v.validTo===null||v.validTo>p.effectiveDate));
 if(!on)throw new MovementHistoryError('movement_history_no_period');
 const after=Object.fromEntries(fields.map(field=>[field,on[field as HistoryField]??null])) as HistoryValues;
 for(const [field,expected] of Object.entries(expectedAfter??{})){
  if(after[field as HistoryField]!==expected)throw new MovementHistoryError('movement_history_after_mismatch:'+field);
 }
 return recordHistoryMovementTx(tx,ctx,{...p,kind:type.behaviourKind,typeCode:type.code,after,before:p.before as HistoryValues,correction});
}

export async function recordHistoryMovement(ctx:SessionContext,p:HistoryEntry){
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_configuration_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  return applyHistoryEntryTx(tx,ctx,p);
 });
}

type HistoryRevision = HistoryMovementFacts & {type:string;kind:string;spanFrom:string};
async function activeEntityHistoryTx(tx:Tx,ctx:SessionContext,employmentId:string,movementId:string){
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(movementId))return null;
 const [reversal]=await tx.select({id:domainEvent.id}).from(domainEvent).where(and(
  eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,employmentId),
  eq(domainEvent.eventType,'employment.movement.reversed'),sql`${domainEvent.payload}->>'movementId'=${movementId}`,
 )).limit(1);
 if(reversal)return null;
 const active=await latestHistoryMovementRevisionTx(tx,employmentId,movementId);
 if(!active)return null;
 const facts=active.payload as HistoryRevision;
 const type=await resolveMovementEventTypeTx(tx,ctx.tenantId,facts.type);
 return facts.kind==='entityTransfer'&&type?.behaviourKind==='entityTransfer' ? {...active,facts} : null;
}

export async function historyMovementEditValues(ctx:SessionContext,employmentId:string,movementId:string){
 return withTenant(ctx,async tx=>{
  await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') as allowed`);
  if(!authority?.allowed)return null;
  const active=await activeEntityHistoryTx(tx,ctx,employmentId,movementId);
  if(!active)return null;
  try { await assertHistoryEditCompaniesTx(tx,employmentId,active.facts); }
  catch(error){if(error instanceof WorkforceAccessError)return null;throw error;}
  const {type,effectiveDate,before,remarks,dates}=active.facts;
  return {typeCode:type,effectiveDate,before,remarks,dates,revisionId:active.id};
 });
}

async function assertHistoryEditCompaniesTx(tx:Tx,employmentId:string,facts:HistoryRevision){
 const versions=await historyVersionsTx(tx,employmentId);
 const companies=new Set(versions.filter(v=>v.validFrom<=facts.effectiveDate&&(v.validTo===null||v.validTo>facts.spanFrom)).map(v=>v.companyId));
 companies.add(facts.before.companyId??null);
 companies.add(facts.after.companyId??null);
 const ids=[...companies].filter((companyId):companyId is string=>!!companyId);
 const [scope]=await tx.execute<{allowed:boolean}>(sql`
  select not exists(select 1 from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) company(id)
    where not app.access_workforce_company(company.id::uuid,'workforce.maintain')) as allowed
 `);
 if(!scope?.allowed)throw new WorkforceAccessError();
 return ids;
}

type EntityHistoryEdit=Omit<HistoryEntry,'typeCode'>&{
 movementId:string;revisionId:string;reason:string;expectedAfter?:HistoryValues;
};
export function editEntityHistoryMovement(ctx:SessionContext,p:EntityHistoryEdit){
 return withTenant(ctx,tx=>editEntityHistoryMovementTx(tx,ctx,p));
}

export async function editEntityHistoryMovementTx(tx:Tx,ctx:SessionContext,p:EntityHistoryEdit){
 const reason=p.reason.trim();
 if(!reason||reason.length>200)throw new Error('A reason is required to edit historical movement.');
 if(!ctx.roles?.some(role=>role==='hr_admin'||role==='super_admin'))throw new Error('Only an admin can edit a movement.');
 await tx.execute(sql`select app.access_configuration_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'maintain');
 const active=await activeEntityHistoryTx(tx,ctx,p.employmentId,p.movementId);
 if(!active||p.revisionId!==active.id)throw new MovementHistoryError('movement_history_overtaken');
 const companies=await assertHistoryEditCompaniesTx(tx,p.employmentId,active.facts);
 await lockPayrollInputsTx(tx,{employmentIds:[p.employmentId],companyIds:p.before.companyId?[...companies,p.before.companyId]:companies});
 const {type,effectiveDate,before,after,remarks,dates}=active.facts;
 if(isCalendarDate(p.effectiveDate)&&p.effectiveDate<effectiveDate&&before.companyId!==undefined&&before.companyId!==after.companyId){
  const paid=await closedPayrollInSpanTx(tx,p.employmentId,p.effectiveDate,effectiveDate);
  if(paid.length)throw new MovementHistoryError('movement_history_payroll_company:'+paid.map(row=>row.period).join(', '));
 }
 await reverseHistoryMovementTx(tx,ctx,{id:active.id,payload:active.payload,subjectEmploymentId:p.employmentId});
 return applyHistoryEntryTx(tx,ctx,{...p,typeCode:type},{
  movementId:p.movementId,reason,previous:{effectiveDate,before,after,remarks,dates},
 },p.expectedAfter);
}
