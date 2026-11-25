/** ADR 0181 payroll read addendum, change F (migration 7500): the worker's projection of imported-history run
 * summaries. A singleton tick on the existing lane (core/worker-lane-loop.ts). It does nothing while the step is
 * 'legacy'; otherwise it projects up to `limit` tenants whose summary version moved since their last projection, each
 * in its own transaction. A tenant with a history stage in flight is skipped (the function returns -1) and comes back
 * on a later tick. OWNER CONNECTION. No person, money or tenant value is logged. */
import type postgres from 'postgres';

export async function runPayrollBatchSummaryTick(owner:postgres.Sql,limit=5):Promise<boolean>{
 const [control]=await owner<{mode:string}[]>`select mode from payroll_read_access_control where step='f_history_summary'`;
 if(!control||control.mode==='legacy')return false;
 const due=await owner<{id:string}[]>`select tenant_id::text as id from payroll_batch_summary_state where version>projected_version order by tenant_id limit ${limit}`;
 let worked=false;
 for(const {id} of due){
  const [row]=await owner.begin(tx=>tx<{n:number}[]>`select app.payroll_batch_summary_project(${id}::uuid) as n`);
  if(Number(row.n)>=0)worked=true;
 }
 return worked;
}
