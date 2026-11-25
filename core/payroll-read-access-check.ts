/** ADR 0181 payroll read addendum (migration 7460 and later steps), section 11.2: the scheduled every-user comparison.
 *
 * OWNER CONNECTION. For every step whose mode is 'shadow' or 'precomputed', and every tenant, it runs
 * app.payroll_read_access_compare(step, tenant) in its own transaction. The comparison evaluates each of the step's
 * legacy and restated policy pieces for every user of the tenant, under that user's own role assignments, and counts
 * differences in value and in raising. Any difference marks the tenant's step untrusted in the database, so that
 * tenant's reads use the legacy functions until an operator re-trusts it (app.payroll_read_access_retrust, which
 * compares again and trusts only a clean result). A step in 'legacy' is not compared.
 *
 * Output: counts per tenant and step only when they differ (the operator needs the ids to re-trust), and one summary
 * line. No person, user, employment or money value. */
import {sql} from 'drizzle-orm';
import type {Db} from '../db/client';

export type PayrollReadAccessComparison={step:string;users:number;evaluations:number;valuesDiffer:number;raisesDiffer:number;trusted:boolean};
export type PayrollReadAccessCheck={stepsCompared:number;tenantsCompared:number;comparisonsFailed:number;comparisonsDiffering:number;untrusted:number};

export async function comparePayrollReadAccess(owner:Db,step:string,tenantId:string):Promise<PayrollReadAccessComparison>{
 const [row]=await owner.transaction(tx=>tx.execute<{r:Record<string,unknown>}>(sql`select app.payroll_read_access_compare(${step},${tenantId}::uuid) as r`));
 const r=row.r;
 return{step,users:Number(r.users),evaluations:Number(r.evaluations),valuesDiffer:Number(r.valuesDiffer),raisesDiffer:Number(r.raisesDiffer),trusted:r.trusted===true};
}

export async function payrollReadAccessCheck(owner:Db,log:(line:string)=>void=()=>{}):Promise<PayrollReadAccessCheck>{
 const out:PayrollReadAccessCheck={stepsCompared:0,tenantsCompared:0,comparisonsFailed:0,comparisonsDiffering:0,untrusted:0};
 const steps=Array.from(await owner.execute<{step:string}>(sql`select step from payroll_read_access_control where mode in ('shadow','precomputed') order by step`));
 if(!steps.length)return out;
 const tenants=Array.from(await owner.execute<{id:string}>(sql`select id::text as id from tenant order by 1`));
 out.tenantsCompared=tenants.length;
 for(const {step} of steps){
  out.stepsCompared++;
  for(const {id} of tenants){
   try{
    // P4's stored set is recomputed from scratch first (section 8.3); a difference marks the tenant's step untrusted.
    if(step==='p4_history_filter'){
     const [row]=await owner.transaction(tx=>tx.execute<{r:{missing:number;extra:number}}>(sql`select app.payroll_history_ineffective_verify(${id}::uuid) as r`));
     if(Number(row.r.missing)+Number(row.r.extra)>0)log(`payroll-read-access REBUILD DIFFERENCE step=${step} tenant=${id} missing=${row.r.missing} extra=${row.r.extra} (rebuild with app.payroll_history_ineffective_rebuild, then re-trust)`);
    }
    const c=await comparePayrollReadAccess(owner,step,id);
    if(!c.trusted)out.untrusted++;
    if(c.valuesDiffer+c.raisesDiffer>0){
     out.comparisonsDiffering++;
     log(`payroll-read-access DIFFERENCE step=${step} tenant=${id} users=${c.users} values=${c.valuesDiffer} raises=${c.raisesDiffer} (reads fall back to legacy until re-trusted)`);
    }else if(!c.trusted)log(`payroll-read-access UNTRUSTED step=${step} tenant=${id} (clean now; re-trust with app.payroll_read_access_retrust)`);
   }catch(error){
    out.comparisonsFailed++;
    log(`payroll-read-access could not compare step=${step} tenant=${id}: ${(error as Error).name}`);
   }
  }
 }
 return out;
}

/** 0 clean · 3 a comparison differs or a tenant's step is untrusted · 2 a comparison could not run. */
export function payrollReadAccessExitCode(run:PayrollReadAccessCheck):number{
 if(run.comparisonsFailed>0)return 2;
 if(run.comparisonsDiffering>0||run.untrusted>0)return 3;
 return 0;
}
