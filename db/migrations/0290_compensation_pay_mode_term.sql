-- 0290 (feedback 642ecc55) — Employee-specific Pay Mode + Payment Term + Rate on Basic Salary.
-- Supersedes the ADR-0064 / R46 79eb7151 "surface, do not duplicate" decision (see ADR-0078): the salary
-- STRUCTURE (pay mode, payment term, non-monthly rate) now lives on the effective-dated compensation row,
-- so one payroll policy can serve a mixed monthly/daily/hourly workforce.
--
-- Design (ADR-0078):
--   • basic_salary KEEPS its monthly-equivalent semantics — every statutory / derived calculation (ORP
--     hourly basis, OT wage base, TOIL First-Schedule ceiling, reporting) still reads it as a MONTHLY
--     figure. The new rate_amount is what pays a daily/hourly employee (rate × days / rate × hours).
--   • pay_mode reuses the existing payroll_policy_type enum (no second enum), payment_term is plain text
--     validated in the service against the PayrollFrequency TS union (a parallel pg enum would need a
--     migration per new term).
--   • Both pay_mode and payment_term are BACKFILLED and NOT NULL — no nullable "inherit from policy"
--     fallback. payroll_policy is mutable, so a NULL row would resolve through the policy AS IT IS NOW,
--     not as it was then, breaking "historical calculations use the configuration effective at that time".
--   • Backfill order: add nullable → backfill → SET NOT NULL, in this one migration.
--
-- Backfill sources, per row (ALL rows, not just the open one — history keeps the settings in force then):
--   • pay_mode: the employment's resolved policy (resolveAssignedPolicy semantics — the directly-assigned
--     policy when ACTIVE; an inactive/missing assignment resolves to monthly, NOT to the company default;
--     only an UNASSIGNED employment falls through to the company-default policy). Else 'monthly'.
--   • payment_term: the COMPANY DEFAULT policy's config frequency (what the engine actually reads at
--     core/payroll.ts runFrequency — cutOffSchedule.defaultConfig), else 'monthly'. Backfilling from the
--     assigned policy would write values the engine never used.
--   • rate_amount: the resolved policy's pay_rule rate where its type is daily/hourly, else NULL. This is
--     what makes day one byte-identical: the daily branch's rate source moves from policy.pay_rule.rate to
--     compensation.rate_amount holding the same number.
-- DEFAULT 'monthly' is a plain constant (today's only behaviour), NOT a policy fallback — it keeps raw
-- INSERTs (tests, tooling) valid under NOT NULL; the service always writes explicit values.
ALTER TABLE compensation ADD COLUMN pay_mode payroll_policy_type DEFAULT 'monthly';--> statement-breakpoint
ALTER TABLE compensation ADD COLUMN payment_term text DEFAULT 'monthly';--> statement-breakpoint
ALTER TABLE compensation ADD COLUMN rate_amount numeric(12, 2);--> statement-breakpoint
-- BACKFILL (equivalence-tested in test/employee-pay-structure.test.ts, which re-executes this statement):
UPDATE compensation c SET
  pay_mode = COALESCE(r.mode, 'monthly'),
  payment_term = COALESCE(r.freq, 'monthly'),
  rate_amount = r.rate
FROM (
  SELECT DISTINCT ON (e.id)
    e.id AS employment_id,
    -- resolveAssignedPolicy semantics: assigned id when present (even if inactive — an inactive assigned
    -- policy resolves to monthly, it does NOT fall through to the company default), else company default.
    CASE WHEN ap.status = 'active' THEN ap.policy_type END AS mode,
    CASE WHEN ap.status = 'active' AND ap.policy_type IN ('daily', 'hourly')
         THEN NULLIF(ap.pay_rule ->> 'rate', '')::numeric(12, 2) END AS rate,
    -- runFrequency source: the COMPANY DEFAULT policy's config frequency (core/payroll.ts line ~2083).
    CASE WHEN dp.status = 'active' AND dp.config ->> 'frequency' IN ('monthly', 'weekly', 'biweekly')
         THEN dp.config ->> 'frequency' END AS freq
  FROM employment e
  LEFT JOIN company_payroll_config cfg ON cfg.company_id = e.company_id
  LEFT JOIN payroll_policy ap ON ap.id = COALESCE(e.payroll_policy_id, cfg.default_payroll_policy_id)
  LEFT JOIN payroll_policy dp ON dp.id = cfg.default_payroll_policy_id
  ORDER BY e.id
) r
WHERE r.employment_id = c.employment_id;--> statement-breakpoint
ALTER TABLE compensation ALTER COLUMN pay_mode SET NOT NULL;--> statement-breakpoint
ALTER TABLE compensation ALTER COLUMN payment_term SET NOT NULL;
