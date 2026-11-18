import type {Tx} from '../db/client';
/** Payroll eligibility is a payment fact, separate from continued employment.
 * These predicates never reactivate Personnel or widen database visibility. */
import {and,or,sql,lte,isNull,eq,inArray,type SQL} from 'drizzle-orm';
import {employment,compensation,payrollCycle} from '../db/schema';
import {employedByCompanyDuring} from './employment-company';
export type PayrollEligibilityRun={companyId:string;payPeriod:string;id?:string;batchId?:string;runType?:string;payrollCycleId?:string|null};
export const payrollEmploymentEnd=sql<string|null>`least(${employment.terminatedOn},${employment.resignationDate},${employment.lastWorkingDate})`;
export function payrollPeriodBounds(period:string){const[y,m]=period.split('-').map(Number);return{start:period+'-01',end:period+'-'+String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')};}
/** Only committed explicit positive cash transactions can admit a former employee.
 * Exact cycle, employer, source date and consumption custody are checked again at calculation. */
export function outstandingPaymentPredicate(run:PayrollEligibilityRun,enabled:boolean):SQL{
 if(!enabled)return sql`false`;
 const{start,end}=payrollPeriodBounds(run.payPeriod),id=run.id??run.batchId??null;
 const cycle=(run.runType??'regular')==='regular'
  ?sql`(t.intended_cycle_id is null or exists(select 1 from payroll_cycle pc where pc.id=t.intended_cycle_id and pc.company_id=${run.companyId}::uuid and pc.tenant_id=t.tenant_id and pc.run_type='regular'))`
  :run.payrollCycleId?sql`t.intended_cycle_id=${run.payrollCycleId}::uuid`:sql`false`;
 return sql`(${payrollEmploymentEnd}<${start}::date and ${employment.hiredOn}<=${end}::date and exists(
  select 1 from payroll_individual_txn t left join pay_component item on item.id=t.component_id and item.tenant_id=t.tenant_id
  where t.tenant_id=${employment.tenantId} and t.employment_id=${employment.id} and t.company_id=${run.companyId}::uuid and t.pay_period=${run.payPeriod}
   and (t.kind='overtime' or (t.kind='earning' and (t.component_id is null or (item.id is not null and item.archived_at is null and not item.is_non_payable))))
   and t.amount>0 and t.txn_date>=${employment.hiredOn} and t.txn_date<=${end}::date
   and (t.batch_id is null or t.batch_id=${id}::uuid) and (t.consumed_batch_id is null or t.consumed_batch_id=${id}::uuid)
   and ${cycle} and (${employment.companyId}=${run.companyId}::uuid or exists(select 1 from assignment a where a.employment_id=${employment.id} and a.tenant_id=t.tenant_id and a.company_id=t.company_id and a.superseded_at is null and a.valid_from<=t.txn_date and (a.valid_to is null or a.valid_to>t.txn_date)))
 ))`;
}
export function payrollEmploymentPredicate(run:PayrollEligibilityRun,enabled:boolean):SQL{
 const{start,end}=payrollPeriodBounds(run.payPeriod);
 return or(and(employedByCompanyDuring(run.companyId,start,end),lte(employment.hiredOn,end),or(isNull(payrollEmploymentEnd),sql`${payrollEmploymentEnd}>=${start}::date`)),outstandingPaymentPredicate(run,enabled))!;
}
/** A departed employee's reference pay record is the one at departure, never a later salary. */
export function payrollCompensationEffectiveOn(period:string):SQL{
 const{start,end}=payrollPeriodBounds(period),date=sql`case when ${payrollEmploymentEnd}<${start}::date then ${payrollEmploymentEnd} else ${end}::date end`;
 return and(isNull(compensation.supersededAt),sql`${compensation.validFrom}<=${date}`,sql`(${compensation.validTo} is null or ${compensation.validTo}>${date})`)!;
}

/** Match the existing multi-company owner: exact primary pick; first same-type secondary cycle. */
export async function payrollRunContextsTx(tx:Tx,companyIds:string[],payPeriod:string,payrollCycleId?:string):Promise<PayrollEligibilityRun[]>{
 if(!companyIds.length)return [];
 const rows=await tx.select().from(payrollCycle).where(and(inArray(payrollCycle.companyId,companyIds),isNull(payrollCycle.archivedAt))).orderBy(payrollCycle.sortOrder,payrollCycle.name);
 const primary=payrollCycleId?rows.find(row=>row.id===payrollCycleId):undefined;
 if(payrollCycleId&&!primary)return [];
 return companyIds.map(companyId=>{const cycle=primary?.companyId===companyId?primary:rows.find(row=>row.companyId===companyId&&row.runType===(primary?.runType??'regular'));return{companyId,payPeriod,runType:cycle?.runType??'regular',payrollCycleId:cycle?.id??null};});
}
