-- Recruitment slice 6 (docs/recruitment-reconstruction/specification.md "Slice 6"): indexes for the four report
-- dashboards (packs/recruitment/reports.ts). Indexes only: no table, column, policy, grant, function or data changes.
--
-- Each dashboard filters by tenant, company and a period on one timestamp, inside a read-only snapshot. The existing
-- indexes answer "by job" and "by current stage"; these answer "by company and date":
--   recruitment_application        (tenant_id, company_id, applied_at)  — applications received in the period;
--   recruitment_application_event  (tenant_id, company_id, occurred_at) — Team: moves and hires in the period
--                                   (the stage-history funnel already uses (application_id, occurred_at), 4401);
--   recruitment_interview          (tenant_id, company_id, created_at)  — Team: interviews scheduled in the period
--                                   (held / upcoming use (tenant_id, company_id, starts_at), 4402);
--   recruitment_offer              (tenant_id, company_id, created_at)  — Team: offers created in the period.
-- Plain CREATE INDEX inside the migration transaction, like 4401–4405: these tables are new in this release block
-- (4401–4405 are unapplied outside throwaway databases and CI), so there is no populated table to lock.
CREATE INDEX recruitment_application_company_applied_idx ON public.recruitment_application (tenant_id, company_id, applied_at);
--> statement-breakpoint
CREATE INDEX recruitment_application_event_company_occurred_idx ON public.recruitment_application_event (tenant_id, company_id, occurred_at);
--> statement-breakpoint
CREATE INDEX recruitment_interview_company_created_idx ON public.recruitment_interview (tenant_id, company_id, created_at);
--> statement-breakpoint
CREATE INDEX recruitment_offer_company_created_idx ON public.recruitment_offer (tenant_id, company_id, created_at);
