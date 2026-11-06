-- Tenant-isolation defence in depth, ADR-0174 follow-up part 2 of 3: the six company references that are not
-- called company_id get the same tenant-bound key 2101 gave company_id. Each still referenced company(id)
-- alone, so a writer could store a parent company, reporting-line scope, notice owner, overtime creation
-- company or KPI group from another tenant. Nothing of that tenant became readable; the row was a dangling
-- cross-tenant reference. setCompanyParent and the delegation scope picker pass a submitted company id
-- straight to these columns, so the key is what refuses one from another tenant.
--
-- teras_chat.company_id (2000) had no company key at all: the chat takes its company from the browser's
-- conversation scope. The owner chose ON DELETE NO ACTION (4 November 2026): a company with chats or chat
-- tombstones refuses deletion as `other` until retention removes them (at most the tenant's "Keep chats for",
-- 1 to 365 days). A chat whose company is refused is simply not stored; the reply is still shown.
--
-- NOT VALID: existing rows are not scanned here; 2402 checks the data and validates. Every INSERT and every
-- UPDATE of the column or tenant_id is checked from this migration on. Writers were reviewed: application
-- writes stamp the session tenant under RLS with a company the actor administers, and reparenting stays
-- inside one tenant. MATCH SIMPLE keeps a NULL reference valid. Every existing key is ON DELETE NO ACTION and
-- so is each new one; the single-column keys stay. No grant, policy or column changes.
-- test/tenant-company-fk.test.ts fails if any single-column company key on a tenant table lacks its twin.
ALTER TABLE public.company ADD CONSTRAINT company_parent_company_tenant_fk
  FOREIGN KEY (parent_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.notice ADD CONSTRAINT notice_owner_company_tenant_fk
  FOREIGN KEY (owner_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.overtime_pattern ADD CONSTRAINT overtime_pattern_creation_company_tenant_fk
  FOREIGN KEY (creation_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.overtime_pattern_version ADD CONSTRAINT overtime_pattern_version_creation_company_tenant_fk
  FOREIGN KEY (creation_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.performance_kpi_library ADD CONSTRAINT performance_kpi_library_group_company_tenant_fk
  FOREIGN KEY (group_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.reporting_line ADD CONSTRAINT reporting_line_scope_company_tenant_fk
  FOREIGN KEY (scope_company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE public.teras_chat ADD CONSTRAINT teras_chat_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION NOT VALID;
