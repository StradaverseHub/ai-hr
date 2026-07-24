-- Organization Module — Automatic Payroll Cycle Assignment for New Companies (361e3b15). Each company
-- remembers its OWN default payroll cycle by NAME, mirroring company.leave_cycle (text NOT NULL DEFAULT).
-- Storing the default as a NAME (not an id + foreign key) is deliberate: the column DEFAULT applies on EVERY
-- creation path — the admin Add-company form, provisionTenant, and db/seed — with zero per-path wiring, so
-- no newly provisioned company is ever born without a default and every existing row reads 'Monthly'. Purely
-- ADDITIVE: no data backfill (the column default covers existing rows), no foreign key (so deletePayrollCycle
-- and the archive path need no new guard and a rename simply won't auto-follow — the same accepted trade-off
-- as leave_cycle), and no RLS change (company keeps its existing tenant/admin policies; additive columns need
-- no policy change).
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "default_payroll_cycle" text NOT NULL DEFAULT 'Monthly';
