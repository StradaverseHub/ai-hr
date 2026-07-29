-- r79a · 4fb8b75a steps 2 + 3 — "Review and Consolidate Payroll Settings to Remove Duplicate Configuration".
--
-- company_payroll_config accumulated four columns that are not payroll scheduling. This migration removes
-- one that nothing reads, and RELOCATES three that are live, carrying every stored value across first.
--
-- ── STEP 2 · payment_basis is DELETED ────────────────────────────────────────────────────────────────
-- Written by app/admin/payroll-config/actions.ts → core/payroll-config.ts, read by NOTHING except the
-- <select> that writes it. Verified by exhaustive search over both spellings plus every dynamic-access
-- shape (computed member access, Object.keys/entries, whole-object spread): there is no consumer in
-- payroll math, payslips, statutory, reports, exports or any API response. Every other query against this
-- table uses an explicit column projection that omits it. It is the vestigial ADR-0035 ancestor of
-- compensation.pay_mode / payment_term / rate_amount (ADR-0078, migration 0290), which are effective-dated,
-- per-employee and genuinely load-bearing. Historical company.payroll-config.* domain events keep their
-- paymentBasis key in the payload — that is an immutable audit record and is deliberately left alone.
--
-- ── STEP 3 · three live settings MOVE, they are not dropped ──────────────────────────────────────────
-- Each has exactly one proven reader, and none of them is payroll:
--   probation_months      → app/admin/personnel/actions.ts (a full-time hire's probation end date) and
--                           app/admin/personnel/page.tsx (the hire form's default). Hiring.
--   review_reminder_days  → core/employment-review.ts sweepReviewReminders (the nightly probation /
--                           confirmation review nudge). Employment review, not payroll.
--   default_currency      → app/admin/personnel/[employmentId]/page.tsx (the Basic Salary form's currency
--                           preselect for a brand-new salary record). Compensation.
--
-- DESTINATION for the first two: COLUMNS ON `company`, not a new table — the 0287 precedent verbatim
-- (leave escalation settings) and its siblings leave_multi_approval / leave_cycle /
-- leave_half_day_full_deduction. `company` already has RLS and the app grant, so columns avoid a new table
-- plus policies plus GRANT (the ADR-0002 footgun) entirely. Both are nullable, so a company with nothing
-- configured keeps today's behaviour (probation 3 months; reminders [30,14,7], resolved at compute time).
--
-- DESTINATION for the third: `company.currency`, which ALREADY EXISTS (ISO-4217, NOT NULL DEFAULT 'MYR')
-- and is editable on Organization → General. It is today read by nothing but listCompanies — an editable,
-- inert field sitting beside a payroll-screen field that does the real work. This is the genuine duplicate
-- of the pair, so the two collapse into one: Organization owns the company currency and the salary form
-- reads it. No new column.
--
-- ── IDEMPOTENCE ─────────────────────────────────────────────────────────────────────────────────────
-- Every DDL statement is IF (NOT) EXISTS or guarded on pg_constraint. Every data-carry statement is wrapped
-- in a source-column existence guard (the source columns are dropped at the end of THIS migration, so a
-- naive re-run would otherwise fail on a missing column) AND a target guard that makes the write a no-op
-- once carried: `company.<target> IS NULL` for the two new columns, and `company.currency = 'MYR' AND
-- default_currency <> 'MYR'` for the currency. A second run therefore updates zero rows; it can never
-- double-write, and it can never clobber a currency an admin set deliberately on Organization → General.

ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "probation_months" integer;--> statement-breakpoint

ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "review_reminder_days" integer[];--> statement-breakpoint

-- Named CHECKs mirroring the service-side cleaners (core/hiring-defaults.ts): probation is any positive
-- integer (no arbitrary upper clamp, per the 0136 rationale); the reminder cadence is 1..10 offsets, each
-- 1..365 days. ADD CONSTRAINT has no IF NOT EXISTS, so both are guarded on pg_constraint.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_probation_months_check') THEN
		ALTER TABLE "company" ADD CONSTRAINT "company_probation_months_check"
			CHECK ("probation_months" IS NULL OR "probation_months" > 0);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_review_reminder_days_check') THEN
		ALTER TABLE "company" ADD CONSTRAINT "company_review_reminder_days_check"
			CHECK (
				"review_reminder_days" IS NULL
				OR (
					array_length("review_reminder_days", 1) BETWEEN 1 AND 10
					AND 1 <= ALL ("review_reminder_days")
					AND 365 >= ALL ("review_reminder_days")
				)
			);
	END IF;
END $$;--> statement-breakpoint

-- Carry probation_months across. Source guard: the column still exists (it is dropped below). Target guard:
-- only fills a NULL, so a re-run writes nothing and an admin edit made after the move is never overwritten.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'company_payroll_config' AND column_name = 'probation_months'
	) THEN
		EXECUTE $carry$
			UPDATE company c
			SET probation_months = pc.probation_months
			FROM company_payroll_config pc
			WHERE pc.company_id = c.id
			  AND pc.tenant_id = c.tenant_id
			  AND pc.probation_months IS NOT NULL
			  AND pc.probation_months > 0
			  AND c.probation_months IS NULL
		$carry$;
	END IF;
END $$;--> statement-breakpoint

-- Carry review_reminder_days across, same two guards. Empty arrays are treated as "not configured" exactly
-- as resolveReminderDays does, so they are not carried as an empty array that would fail the CHECK.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'company_payroll_config' AND column_name = 'review_reminder_days'
	) THEN
		EXECUTE $carry$
			UPDATE company c
			SET review_reminder_days = pc.review_reminder_days
			FROM company_payroll_config pc
			WHERE pc.company_id = c.id
			  AND pc.tenant_id = c.tenant_id
			  AND pc.review_reminder_days IS NOT NULL
			  AND array_length(pc.review_reminder_days, 1) BETWEEN 1 AND 10
			  AND 1 <= ALL (pc.review_reminder_days)
			  AND 365 >= ALL (pc.review_reminder_days)
			  AND c.review_reminder_days IS NULL
		$carry$;
	END IF;
END $$;--> statement-breakpoint

-- Collapse the two currency fields into company.currency. The payroll-config value is the one that drives
-- behaviour today (the salary form reads it), so where a company deliberately set a non-MYR salary default
-- it WINS and the company's live prefill does not change. `c.currency = 'MYR'` keeps the migration off any
-- company whose Organization currency was set to something other than the seeded default, and is what makes
-- a re-run a no-op (after the first run the target no longer equals 'MYR').
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'company_payroll_config' AND column_name = 'default_currency'
	) THEN
		EXECUTE $carry$
			UPDATE company c
			SET currency = pc.default_currency
			FROM company_payroll_config pc
			WHERE pc.company_id = c.id
			  AND pc.tenant_id = c.tenant_id
			  AND pc.default_currency IS NOT NULL
			  AND pc.default_currency <> 'MYR'
			  AND c.currency = 'MYR'
		$carry$;
	END IF;
END $$;--> statement-breakpoint

ALTER TABLE "company_payroll_config" DROP COLUMN IF EXISTS "payment_basis";--> statement-breakpoint

ALTER TABLE "company_payroll_config" DROP COLUMN IF EXISTS "probation_months";--> statement-breakpoint

ALTER TABLE "company_payroll_config" DROP COLUMN IF EXISTS "review_reminder_days";--> statement-breakpoint

ALTER TABLE "company_payroll_config" DROP COLUMN IF EXISTS "default_currency";--> statement-breakpoint

-- No RLS change: both tables keep their existing policies (company_payroll_config is company-scoped admin;
-- `company` its own tenant policy), and additive/removed columns need no policy change. The grant is
-- re-stated explicitly rather than assumed, per the migration standard — a no-op re-grant on an existing
-- table, and the guarantee that the two new `company` columns are reachable by the app role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "company" TO ai_hr_app;
