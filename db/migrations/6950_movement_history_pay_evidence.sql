-- Candidate only. Historical salary and payment method evidence is isolated from live payroll inputs.
create table app.movement_history_pay_evidence (
 event_id uuid primary key references public.domain_event(id) on delete cascade,
 tenant_id uuid not null references public.tenant(id) on delete cascade,
 employment_id uuid not null,
 company_ids uuid[] not null check(cardinality(company_ids)>0),
 facts jsonb not null check(jsonb_typeof(facts)='object' and facts<>'{}'::jsonb),
 foreign key (employment_id,tenant_id) references public.employment(id,tenant_id)
);
--> statement-breakpoint
alter table app.movement_history_pay_evidence enable row level security;
--> statement-breakpoint
alter table app.movement_history_pay_evidence force row level security;
--> statement-breakpoint
create policy movement_history_pay_select on app.movement_history_pay_evidence for select to ai_hr_app
 using (
  tenant_id=app.current_tenant_id()
  and app.can_admin_employment(employment_id)
  and not exists(select from unnest(company_ids) as c(id) where not coalesce(app.can_admin_payroll_for(c.id),false))
 );
--> statement-breakpoint
create policy movement_history_pay_insert on app.movement_history_pay_evidence for insert to ai_hr_app
 with check (
  tenant_id=app.current_tenant_id()
  and app.can_admin_employment(employment_id)
  and not exists(select from unnest(company_ids) as c(id) where not coalesce(app.can_admin_payroll_for(c.id),false))
  and exists(select from public.domain_event event where event.id=event_id
   and event.tenant_id=app.current_tenant_id() and event.subject_employment_id=employment_id
   and event.actor_id=app.current_user_id()
   and event.payload->>'hasPayEvidence'='true'
   and event.event_type in ('employment.history.recorded','employment.history.edited'))
 );
--> statement-breakpoint
revoke all on app.movement_history_pay_evidence from public,ai_hr_app;
--> statement-breakpoint
grant select,insert on app.movement_history_pay_evidence to ai_hr_app;
