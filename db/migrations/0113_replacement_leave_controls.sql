-- ADR-0033 (RL Control & Validation Engine): replacement-leave (TOIL) controls. Gated (TOIL_ENABLED).
-- Additive columns only — no new table, so the existing toil_policy_rls / toil_accrual_rls policies and
-- ai_hr_app grants are INHERITED (deliberate: nothing to re-grant). All adds are NOT NULL DEFAULT, so
-- existing seeded rows are accepted without a backfill.
--
-- toil_policy:
--   auto_accrue_on_approval  — opt-in (default false): when on, approving a rest-day/holiday attendance
--                              correction auto-banks the RL credit (no manual roster election needed).
--   carry_forward_at_year_end — opt-in (default false): when on, an accrual survives the year-end close
--                              sweep instead of being expired. FROZEN onto each accrual at accrual time.
-- toil_accrual:
--   days_taken               — signed per-accrual consumption tally. The active bucket nets to
--                              Σ(days_credited − days_taken); an accrual flips to 'taken' only when fully
--                              consumed. Keeps one row per worked day (preserves the unique index + the
--                              payroll predicate join) instead of splitting rows on partial consumption.
--   carry_forward_at_year_end — the policy flag copied at accrual time (mirrors expiry_action's freeze), so
--                              a mid-year policy flip cannot retroactively change a banked entitlement's fate.

ALTER TABLE "toil_policy" ADD COLUMN "auto_accrue_on_approval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "toil_policy" ADD COLUMN "carry_forward_at_year_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "days_taken" numeric(6, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD COLUMN "carry_forward_at_year_end" boolean DEFAULT false NOT NULL;
