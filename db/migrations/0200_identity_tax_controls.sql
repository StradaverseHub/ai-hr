-- Item 8b5334db — Identification & Tax card enhancements on employee_statutory_my (additive, backward-compatible).
-- Three new tax-calculation controls, all defaulted so every existing row keeps today's behaviour byte-for-byte:
--   • tax_residency (text): resident | non_resident | rep | knowledge_worker. Backfilled from is_resident so a
--     row that was flagged non-resident stays non-resident (flat 30% MTD); everything else defaults to resident
--     (full computerised MTD). REP (Returning Expert Programme) + Knowledge Worker (specific region, e.g. Iskandar)
--     are new flat-15% statuses the calculator now supports; is_resident stays the source of truth for legacy
--     callers and is kept in sync by the setter (resident ⇒ true, else false).
--   • child_relief_mode (text): manual | auto. 'manual' = today's behaviour (HR keys num_children). 'auto' derives
--     the eligible child count from the Family register and SURFACES it for HR confirmation into num_children —
--     it never silently mutates the tax figure (respects the employee_dependent benefits-vs-tax firewall).
--   • employer_bears_tax (boolean): when true the employee's PCB is funded by the employer (subtracted from the
--     employee's statutory deductions, added to employer cost) — mirrors the employer_bears_socso/eis plumbing.
--     Default false ⇒ byte-identical. (True LHDN tax-on-tax gross-up is a documented follow-up.)
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "tax_residency" text NOT NULL DEFAULT 'resident';
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "child_relief_mode" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "employer_bears_tax" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Backfill residency from the existing is_resident flag so live behaviour is preserved. Guarded to rows still at
-- the 'resident' default so a re-run never clobbers a deliberately-set rep/knowledge_worker value.
UPDATE "employee_statutory_my" SET "tax_residency" = 'non_resident' WHERE "is_resident" = false AND "tax_residency" = 'resident';
