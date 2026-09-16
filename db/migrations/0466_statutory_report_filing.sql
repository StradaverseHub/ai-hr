-- r292 / readiness 3.2 — MAKE "FILED" A STATE A RETURN CAN ACTUALLY REACH.
--
-- Until now every `statutory_report` row was born 'draft' and nothing anywhere updated the column
-- (core/reporting.ts hardcoded `status: 'draft'` at both insert sites), so `final`, `submitted` and
-- `amended` were vocabulary with no door into them: all 20 rows on production are 'draft'. The
-- consequence was not cosmetic — `batchDownstreamWarnings.statutoryFiled` is `rows.length > 0`, so the
-- warning shown before an unlock / reset / processed-run edit said "already filed" when somebody had
-- merely PREVIEWED and recorded a draft, and could never say it when a return really had been filed.
--
-- These four columns are the evidence that turns the claim into a fact. They are what a customer would
-- be asked for in an audit: WHO filed it, WHEN they filed it with the agency, and the agency's
-- acknowledgement. `status` alone cannot carry that.
--
-- ── WHY TWO TIMES, AND WHICH ONE A DEADLINE IS JUDGED AGAINST ────────────────────────────────────────
--   filed_on  DATE        — the day the return was lodged WITH THE AGENCY, as declared by the operator.
--                           THIS is the date a statutory deadline is measured against.
--   filed_at  TIMESTAMPTZ — the instant somebody recorded the fact in this system.
-- They are routinely different: a CP39 lodged on the 15th and keyed here on the 20th. Collapsing them
-- into one column would make an on-time filing read as five days late, which is exactly the class of
-- unsupportable assertion CLAUDE.md §8 forbids on a statutory surface.
--
-- ── NO CHECK CONSTRAINT, ON PURPOSE ─────────────────────────────────────────────────────────────────
-- "a filed row must carry an acknowledgement" is a real rule and it is enforced in `markReportFiled`
-- (core/reporting.ts), the one service that decides it. CLAUDE.md §6: a NOT VALID check still fires on
-- every UPDATE of an existing table, and this table already has writers (recordReport,
-- recordFileReport) plus tenant erasure. Columns stay nullable; the service is the gate.
--
-- No GRANT statement: 0026 granted SELECT/INSERT/UPDATE/DELETE on the TABLE to ai_hr_app, and a
-- table-level grant covers columns added later. The 0026 RLS policy is FOR ALL with a WITH CHECK on
-- app.is_admin_for(company_id), so it already backstops the UPDATE these columns exist for.
ALTER TABLE "statutory_report" ADD COLUMN "filed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "statutory_report" ADD COLUMN "filed_on" date;--> statement-breakpoint
ALTER TABLE "statutory_report" ADD COLUMN "filed_by" uuid;--> statement-breakpoint
ALTER TABLE "statutory_report" ADD COLUMN "ack_ref" text;--> statement-breakpoint
-- PARTIAL, so it is empty the day it lands and only ever holds returns that have actually been filed.
-- It serves the one hot read this round creates: `batchDownstreamWarnings` asks "are there FILED returns
-- for this company + month" before every unlock, reset and processed-run edit. The existing
-- statutory_report_company_period_idx leads with company_id but puts report_type before period_key, so
-- it cannot answer that pair without a scan of the company's whole history.
CREATE INDEX "statutory_report_filed_idx" ON "statutory_report" USING btree ("company_id","period_key") WHERE status in ('submitted','amended');
