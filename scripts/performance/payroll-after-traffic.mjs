/** Read aggregate effects from the disposable test database after client traffic settles. */
export async function readPayrollAfterTraffic(db,attemptedPayroll){
  if(!attemptedPayroll.length)return [];
  const attempts=attemptedPayroll.map(({tenant,tenantId,batchId,userId})=>({tenant,tenant_id:tenantId,batch_id:batchId,user_id:userId}));
  // Bind a text parameter so PostgreSQL decodes the serialized records exactly once.
  return db`select target.tenant,batch.status as "batchState",jobs.count as "jobCount",
   case when jobs.count=1 then jobs.state end as "jobState",slips.count as "payslipCount"
   from jsonb_to_recordset(${JSON.stringify(attempts)}::text::jsonb) as target(tenant int,tenant_id uuid,batch_id uuid,user_id uuid)
   left join public.payroll_batch batch on batch.id=target.batch_id and batch.tenant_id=target.tenant_id
   cross join lateral (select count(*)::int as count,min(job.state) as state from public.bulk_job job
    where job.tenant_id=target.tenant_id and job.created_by=target.user_id and job.kind='payroll_process'
     and (job.id=batch.processing_job_id or job.input->>'batchId'=target.batch_id::text
      or job.result->>'batchId'=target.batch_id::text)) jobs
   cross join lateral (select count(*)::int as count from public.payslip slip
    where slip.tenant_id=target.tenant_id and slip.batch_id=target.batch_id) slips
   order by target.tenant`;
}
