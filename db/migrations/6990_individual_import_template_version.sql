-- Draft allocation. Confirm both live migration journals and coordinator allocation before integration.
-- Existing queued work uses the exact template contract that was accepted at submission.
alter table public.payroll_individual_import_job
 add column template_version smallint not null default 1 check(template_version in (1,2));
