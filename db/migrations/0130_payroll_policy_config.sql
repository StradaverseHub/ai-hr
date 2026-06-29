-- 2.1.1 Payroll Policy — Monthly General Settings (ADR-0064). Make a Monthly policy genuinely configurable
-- and have those settings apply at run time. Additive + backfill-safe: `config` is nullable (NULL = today's
-- exact behaviour, proven byte-identical by the default-equals-legacy golden matrix); `priority` defaults 0.
-- No RLS change — both columns live on payroll_policy, which already has tenant-wide-read / admin-write RLS
-- (0128). The kernel resolves the assigned policy as raw tenant-scoped SQL inside the run's Tx; it appends NO
-- DomainEvent (derived read on every compute). `priority` is added now (no later migration) but is consumed
-- only by Phase 2 bulk-assign — the run-time kernel never reads it.
ALTER TABLE "payroll_policy" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "payroll_policy" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;
