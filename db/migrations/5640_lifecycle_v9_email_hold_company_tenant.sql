-- Board release 12 November 2026 (boards 4a60b3ec, 6bdda222): lc_v9_email_hold, created in 5460, names its company
-- through a plain company(id) key only. ADR-0174 (migrations 2101/2102, test/tenant-company-fk.test.ts) requires every
-- tenant-scoped table that stores company_id to tie it to a company of the SAME tenant, with the same delete action as
-- the single-column key (NO ACTION). 5460 is unapplied everywhere, so the table is new and empty on every installation:
-- the key is created validated, with no data scan to stage. The writer (packs/lifecycle/v9/service.ts) stamps the
-- session tenant and the case's company under row security, so no existing writer is refused. The single-column key
-- stays, like every 2101 table. No grant, policy or column changes.
ALTER TABLE public.lc_v9_email_hold ADD CONSTRAINT lc_v9_email_hold_company_tenant_fk
  FOREIGN KEY (company_id, tenant_id) REFERENCES public.company (id, tenant_id) ON DELETE NO ACTION;
