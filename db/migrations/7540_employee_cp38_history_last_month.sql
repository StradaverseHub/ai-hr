-- Board bc6b5490 (with 038c304b and 124a979e, 26 November 2026): CP38 correction history and the last-month amount.
-- Reserved in docs/MIGRATION-ALLOCATION.md (journal index 10940, when 1795495007540; renumbered from 7510 on 26 Nov 2026 to land after 7530).
--
-- 1. employee_cp38.last_month_amount — the instalment for the record's LAST charged month only ("RM300.00 January to
--    June, RM289.35 in July"). NULL keeps today's behaviour: the monthly amount applies all the way through. Nullable
--    with no default because the table is populated (docs/SCALE-AND-RELEASE-RULES.md rule 10): every existing row reads
--    NULL, which is exactly what it means today. The CHECK says a last-month amount needs a last month: valid_to is the
--    EXCLUSIVE end (the first day after the last charged month, the gist rule's '[)' upper bound), so an open-ended
--    record has no last month to apply it to. Every writer of employee_cp38 is core/cp38.ts (setCp38 inserts with it
--    NULL or with a bounded window; updateCp38, terminateCp38 and deleteCp38 keep the two together), plus the reviewed
--    data step scripts/cp38-inclusive-effective-to-bc6b5490.ts, which only moves valid_to later. Existing rows satisfy
--    the CHECK (the column is NULL), so validating it on install only reads the table.
--
-- 2. employee_cp38_revision — the correction history: one row per edit or delete of a CP38 record, with the values
--    before and after, who and when. It exists because the event log may not carry the amount (ADR-0006 / ADR-0030
--    Layer 0: domain_event has a broader read surface than the CP38 row), and the reporter asked to see amounts
--    before and after. So the amounts live here, behind the same row security as employee_cp38 itself.
--      * Append-only: ai_hr_app gets SELECT and INSERT only; the UPDATE and DELETE the owner's default privileges add
--        are revoked, and no UPDATE or DELETE policy exists.
--      * Read: the employment is one the viewer can see (the precomputed visible-employment answer, read once per
--        statement, exactly as employee_cp38_rls reads it since 0515).
--      * Insert: an administrator (as employee_cp38's WITH CHECK) and an employment they can see. Payroll
--        administration of the employment's company is enforced by the writer (core/cp38.ts, the same transaction),
--        as it is for employee_cp38: a per-row app.can_admin_payroll_for(company) here would be a per-row authority
--        call (FUTURE-BUILD-CONTRACT "Database read cost" rule 1).
--      * Not FORCEd, like employee_cp38: the owner-run data step writes its revision rows as the owner.
--    Indexed for its two readers: one record's history (cp38_id) and one employee's history (employment_id).
--
-- No existing policy, function, column or row changes. Rollback (before any revision is written):
--   DROP TABLE employee_cp38_revision;
--   ALTER TABLE employee_cp38 DROP CONSTRAINT employee_cp38_last_month_amount_check;
--   ALTER TABLE employee_cp38 DROP COLUMN last_month_amount;
ALTER TABLE employee_cp38 ADD COLUMN last_month_amount numeric(12, 2);--> statement-breakpoint
ALTER TABLE employee_cp38 ADD CONSTRAINT employee_cp38_last_month_amount_check
  CHECK (last_month_amount IS NULL OR (last_month_amount >= 0 AND valid_to IS NOT NULL));--> statement-breakpoint

CREATE TABLE employee_cp38_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  cp38_id uuid NOT NULL REFERENCES employee_cp38(id),
  employment_id uuid NOT NULL REFERENCES employment(id),
  action text NOT NULL CHECK (action IN ('edit', 'delete')),
  before jsonb NOT NULL,
  after jsonb,
  actor_user_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK ((action = 'delete') = (after IS NULL))
);--> statement-breakpoint
CREATE INDEX employee_cp38_revision_cp38_idx ON employee_cp38_revision (cp38_id, at);--> statement-breakpoint
CREATE INDEX employee_cp38_revision_employment_idx ON employee_cp38_revision (employment_id, at);--> statement-breakpoint

ALTER TABLE employee_cp38_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON employee_cp38_revision FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON employee_cp38_revision TO ai_hr_app;--> statement-breakpoint
-- The owner's default privileges also give ai_hr_app UPDATE and DELETE on every new table: take them back.
REVOKE UPDATE, DELETE, TRUNCATE ON employee_cp38_revision FROM ai_hr_app;--> statement-breakpoint
CREATE POLICY employee_cp38_revision_read ON employee_cp38_revision FOR SELECT TO ai_hr_app
  USING ((tenant_id = app.current_tenant_id()) AND (employment_id = ANY ((SELECT app.visible_employment_ids())::uuid[])));--> statement-breakpoint
CREATE POLICY employee_cp38_revision_insert ON employee_cp38_revision FOR INSERT TO ai_hr_app
  WITH CHECK ((tenant_id = app.current_tenant_id()) AND (SELECT app.is_admin())
    AND (employment_id = ANY ((SELECT app.visible_employment_ids())::uuid[])));
