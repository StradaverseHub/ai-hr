/**
 * 524303d9 — "Everything — new employees" Import History and Revert (ADR-0152 kind `employee_full`,
 * ADR-0153 employment void).
 *
 * Each created employment is one applied item of the import attempt, written in the SAME transaction as the
 * hire. Revert VOIDS those employments, never deletes them: person, employment, the hire's rows and every
 * domain event stay for audit. It is all or nothing across the attempt and eligible only while no employment
 * has anything attached since the import (payroll, leave, attendance, claims, documents, movements, login…).
 * Eligibility is derived from the foreign keys to employment and person by `app.employment_void_blockers`
 * (migration 0676), so a table added later blocks a revert by default.
 *
 * On void the Employee ID and identity number are released (moved to the void columns) and the voided person
 * leaves every duplicate-email read, so the corrected file can be imported again.
 */
import {inArray,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {employment} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import type {ImportPlanBase} from '../lib/import-history';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {ImportHistoryError,type ImportAttemptItemRow,type ImportRevertHandler} from './import-history';

export type EmployeeFullImportPlan=ImportPlanBase&{kind:'employee_full';companyId:string;rows:{rowNum:number;fullName:string;employeeCode:string;company:string;ok:boolean;errors:string[]}[]};
/** The item's `after`: what the import created. No identity number, salary or bank detail is recorded. */
export type EmployeeFullItemState={employeeCode:string;fullName:string;rowNum:number};

/** Plain-language reason for one blocking reference, by the table that holds it. */
export function employmentVoidBlockerReason(source:string,count:number){
 const table=source.split('.')[0].replace(/^app\./,'');
 const n=` (${source}: ${count})`;
 if(source==='employment.lifecycle')return'has a resignation, termination or blacklist recorded';
 if(source==='employment.person_id')return'the same person has another employment';
 if(source==='reporting_line.manager_employment_id')return`is the direct superior of employees outside this import${n}`;
 if(source==='assignment.employment_id'||source==='compensation.employment_id')return`has movements or salary changes after hire${n}`;
 if(/^(app_user|app_invitation|app_manual_identity_enrollment)$/.test(table))return`has a login account or invitation${n}`;
 if(/^(payroll_|payslip|back_pay_line|ea_override|employee_cp38|employee_loan|loan_repayment|employment_pay_component|leave_encashment_snapshot|employee_tp3|tp1_relief|overtime_source_settlement)/.test(table))return`has payroll inputs or results${n}`;
 if(/^(leave_|replacement_leave|toil_accrual)/.test(table))return`has leave applications or leave balance entries${n}`;
 if(/^(employee_document|review_document|letter_record|person_photo)$/.test(table)||/_attachment$/.test(table))return`has documents${n}`;
 if(/^(attendance|clocking_|roster_assignment|employee_device|replacement_holiday)/.test(table))return`has attendance, clocking or roster records${n}`;
 if(/^(claim_|travel_request)/.test(table))return`has claims${n}`;
 if(/^(resignation_|lc_|hr_orchestration_case|employment_review|profile_change_request)/.test(table))return`has movements, reviews or change requests after hire${n}`;
 return`has other records attached since the import${n}`;
}

type Blocker={employment_id:string;source:string;row_count:string|number};
/** Every blocking reference per employment, read as the definer so RLS cannot hide one. */
export async function employmentVoidBlockersTx(tx:Tx,employmentIds:readonly string[]){
 const out=new Map<string,string[]>();
 if(!employmentIds.length)return out;
 const array=sql`ARRAY[${sql.join(employmentIds.map(id=>sql`${id}`),sql`, `)}]::uuid[]`;
 const rows=await tx.execute<Blocker>(sql`select employment_id,source,row_count from app.employment_void_blockers(${array}) order by employment_id,source`);
 for(const r of rows){const list=out.get(r.employment_id)??[];list.push(employmentVoidBlockerReason(r.source,Number(r.row_count)));out.set(r.employment_id,list);}
 return out;
}

/** Voids the employments of an attempt (the caller has checked eligibility under the writer locks). */
export async function voidImportedEmploymentsTx(tx:Tx,ctx:SessionContext,p:{attemptId:string;reason:string;employmentIds:readonly string[]}){
 if(!ctx.userId)throw new ImportHistoryError('Sign in again before reverting.');
 const ids=[...new Set(p.employmentIds)].sort();
 // `app.employment_void` (migration 0676) re-checks the actor, maintain access, the attempt's applied items and
 // every blocker, then voids the person (IC moved to voided_ic_number), the statutory IC and the employment.
 const array=sql`ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::uuid[]`;
 const rows=await tx.execute<{employment_id:string;employee_code:string|null}>(sql`select employment_id,employee_code from app.employment_void(${array},${p.attemptId}::uuid,${p.reason})`);
 if(rows.length!==ids.length)throw new ImportHistoryError('An employee in this import is no longer available.');
 for(const row of rows)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:row.employment_id,eventType:'employment.voided',actor:actorOf(ctx),subjectEmploymentId:row.employment_id,
  payload:{importAttemptId:p.attemptId,reason:p.reason,employeeCode:row.employee_code}});
 return{employments:rows.length};
}

const itemState=(value:unknown)=>(value??{}) as Partial<EmployeeFullItemState>;
/** Same writer locks as the import transaction, always before the attempt row lock. */
async function lockEmployeeImportWritersTx(tx:Tx,ctx:SessionContext){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}

export const employeeFullRevertHandler:ImportRevertHandler={
 kind:'employee_full',
 lock:(tx,ctx)=>lockEmployeeImportWritersTx(tx,ctx),
 async inspect(tx,ctx,items,options){
  const out:{itemId:string;blockers:string[];restore:unknown}[]=[],available:string[]=[],status=new Map<string,string>();
  for(const i of items){
   const id=i.employmentId;
   const[access]=id?await tx.execute<{ok:boolean}>(sql`select app.access_workforce_employment(${id}::uuid,'workforce.maintain') as ok`):[];
   if(id&&access?.ok){available.push(id);status.set(i.id,'ok');}else status.set(i.id,'gone');
  }
  if(options.lock&&available.length)await tx.select({id:employment.id}).from(employment).where(inArray(employment.id,available)).orderBy(employment.id).for('update');
  const blockers=await employmentVoidBlockersTx(tx,available);
  const fingerprint:Record<string,unknown>={};
  for(const i of items){
   const after=itemState(i.after),list:string[]=[];
   if(status.get(i.id)!=='ok')list.push('This employee is no longer available to you (already voided, or you cannot maintain their company).');
   else list.push(...(blockers.get(i.employmentId!)??[]));
   fingerprint[i.id]=list;
   out.push({itemId:i.id,blockers:list,restore:{void:true,employeeCode:after.employeeCode??'',fullName:after.fullName??''}});
  }
  return{items:out,fingerprint};
 },
 async apply(tx,ctx,items,context){
  const reason=context?.reason;if(!reason)throw new ImportHistoryError('Enter a reason for the revert (3 to 1,000 characters).');
  const attemptId=items[0]?.attemptId;if(!attemptId)throw new ImportHistoryError('This import saved no changes, so there is nothing to revert.');
  const result=await voidImportedEmploymentsTx(tx,ctx,{attemptId,reason,employmentIds:items.map((i:ImportAttemptItemRow)=>i.employmentId!).filter(Boolean)});
  return{voided:result.employments};
 },
};
