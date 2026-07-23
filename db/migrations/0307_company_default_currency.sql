-- 297ae65a — Currency on Basic Salary: the COMPANY-LEVEL default salary currency. New Basic Salary
-- records preselect it (HR may change it per record); compensation.currency (already NOT NULL DEFAULT
-- 'MYR') stays the per-record store. Purely ADDITIVE: one NOT NULL column with a DEFAULT, so every
-- existing company_payroll_config row backfills to 'MYR' — the organization default the ticket asks
-- for — and existing salary amounts/records are untouched. No RLS change: company_payroll_config keeps
-- its existing company-scoped admin policies (additive columns need no policy change).
ALTER TABLE "company_payroll_config" ADD COLUMN IF NOT EXISTS "default_currency" text NOT NULL DEFAULT 'MYR';
