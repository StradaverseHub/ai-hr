-- Draft allocation. Confirm both live migration journals and coordinator allocation before integration.
insert into public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
values ('payroll_transaction_export',null,'creator','{"kind":"string","filters":"object","asOf":"string?"}',65536,false);
--> statement-breakpoint
create table app.payroll_transaction_export_part (
 job_id uuid not null references public.bulk_job(id) on delete cascade,
 part integer not null check(part>=0),
 content bytea not null check(octet_length(content) between 1 and 262144),
 expires_at timestamptz not null default statement_timestamp()+interval '1 day',
 primary key (job_id,part)
);
--> statement-breakpoint
create index payroll_transaction_export_expiry on app.payroll_transaction_export_part(expires_at);
--> statement-breakpoint
revoke all on app.payroll_transaction_export_part from public,ai_hr_app;
--> statement-breakpoint
create function app.payroll_transaction_export_store(p_job uuid,p_part integer,p_content bytea)
returns void language plpgsql volatile security definer set search_path=pg_catalog,public,pg_temp as $$
declare job public.bulk_job;
begin
 job:=app.bulk_job_held(p_job);
 if job.kind<>'payroll_transaction_export' or job.state<>'finalizing' or not app.bulk_job_access(p_job)
    or exists(select from unnest(job.company_ids) as c(company_id) where not coalesce(app.can_admin_payroll_for(c.company_id),false)) then
  raise exception 'transaction_export_write_refused' using errcode='42501';
 end if;
 if p_part=0 then
  delete from app.payroll_transaction_export_part where job_id=p_job;
  delete from app.payroll_transaction_export_part where ctid in (
   select ctid from app.payroll_transaction_export_part where expires_at<=statement_timestamp() limit 1024
  );
 end if;
 insert into app.payroll_transaction_export_part(job_id,part,content) values(p_job,p_part,p_content);
end $$;
--> statement-breakpoint
revoke all on function app.payroll_transaction_export_store(uuid,integer,bytea) from public;
--> statement-breakpoint
grant execute on function app.payroll_transaction_export_store(uuid,integer,bytea) to ai_hr_app;
--> statement-breakpoint
create function app.payroll_transaction_export_read(p_job uuid,p_part integer)
returns bytea language sql stable security definer set search_path=pg_catalog,public,pg_temp as $$
 select p.content
 from app.payroll_transaction_export_part p
 join public.bulk_job job on job.id=p.job_id
 where p.job_id=p_job and p.part=p_part and p.expires_at>statement_timestamp()
   and job.kind='payroll_transaction_export' and job.state='completed'
   and job.tenant_id=app.current_tenant_id() and job.created_by=app.current_user_id()
   and app.bulk_job_access(job.id)
   and (job.result->>'employmentId' is null or exists (
     select from public.employment e where e.id=(job.result->>'employmentId')::uuid and e.tenant_id=job.tenant_id
       and app.can_admin_payroll_for(e.company_id)
   ))
   and cardinality(job.company_ids)>0
   and not exists(select from unnest(job.company_ids) as c(company_id) where not coalesce(app.can_admin_payroll_for(c.company_id),false))
$$;
--> statement-breakpoint
revoke all on function app.payroll_transaction_export_read(uuid,integer) from public;
--> statement-breakpoint
grant execute on function app.payroll_transaction_export_read(uuid,integer) to ai_hr_app;
