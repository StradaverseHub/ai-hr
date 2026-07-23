-- Feedback 0df0c635 — Others Statutory card (Personnel > Bank & Statutory): per-employee "Subject to
-- HRDF" control. NULLABLE boolean, tri-state by design: NULL = follow the company's HRDF registration
-- default (registered ⇒ subject, not_registered ⇒ not) — exactly today's behaviour, so every existing
-- row is byte-identical at deploy; the checkbox writes an explicit true/false only when HR saves the
-- card. Purely ADDITIVE: no backfill, no RLS change (employee_statutory_my keeps its existing tenant
-- policies).
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "subject_to_hrdf" boolean;
