-- domain_event subject-scoped reads (ADR-0015 — privacy fix).
--
-- The old read policy was tenant-wide (any member could read every event payload). The new policy:
--   * admins (app.is_admin) read every event in their tenant — the audit ledger is unchanged;
--   * a non-admin reads a row ONLY when it has a subject employment they may see
--     (app.can_see_employment = self OR admin-line manager OR company admin), MIRRORING the
--     visibility of the base tables these events audit (compensation/payslip/leave use the same
--     gate);
--   * rows with no subject (company/cycle/batch/policy events) are admin-only — fail-closed, so a
--     forgotten subject leaks to nobody but admins.
-- The INSERT policy and append-only REVOKE are unchanged (append stays tenant-scoped; the backfill
-- below runs as the migration owner, which bypasses RLS and the ai_hr_app REVOKE).

-- Backfill historical rows: derive the subject employment from the aggregate.
UPDATE domain_event de SET subject_employment_id = e.id
  FROM employment e
  WHERE e.id = de.aggregate_id AND de.aggregate_type = 'employment' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = c.employment_id
  FROM compensation c
  WHERE c.id = de.aggregate_id AND de.aggregate_type = 'compensation' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = lr.employment_id
  FROM leave_request lr
  WHERE lr.id = de.aggregate_id AND de.aggregate_type = 'leave-request' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = a.employment_id
  FROM attendance a
  WHERE a.id = de.aggregate_id AND de.aggregate_type = 'attendance' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = ac.employment_id
  FROM attendance_correction ac
  WHERE ac.id = de.aggregate_id AND de.aggregate_type = 'attendance-correction' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = pr.employment_id
  FROM performance_review pr
  WHERE pr.id = de.aggregate_id AND de.aggregate_type = 'performance-review' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = rl.subordinate_employment_id
  FROM reporting_line rl
  WHERE rl.id = de.aggregate_id AND de.aggregate_type = 'reporting-line' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = a.employment_id
  FROM assignment a
  WHERE a.id = de.aggregate_id AND de.aggregate_type = 'assignment' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = pcr.employment_id
  FROM profile_change_request pcr
  WHERE pcr.id = de.aggregate_id AND de.aggregate_type = 'profile-change' AND de.subject_employment_id IS NULL;--> statement-breakpoint
-- Person-scoped aggregates → deterministic employment pick (prefer active, earliest hired, min id).
UPDATE domain_event de SET subject_employment_id = pick.employment_id
  FROM employee_statutory_my s,
       LATERAL (
         SELECT e.id AS employment_id FROM employment e
         WHERE e.person_id = s.person_id
         ORDER BY (e.terminated_on IS NOT NULL), e.hired_on, e.id LIMIT 1
       ) pick
  WHERE s.id = de.aggregate_id AND de.aggregate_type = 'employee-statutory-my' AND de.subject_employment_id IS NULL;--> statement-breakpoint
UPDATE domain_event de SET subject_employment_id = (
    SELECT e.id FROM employment e
    WHERE e.person_id = de.aggregate_id
    ORDER BY (e.terminated_on IS NOT NULL), e.hired_on, e.id LIMIT 1
  )
  WHERE de.aggregate_type = 'person' AND de.subject_employment_id IS NULL;--> statement-breakpoint

-- Replace the tenant-wide read with the subject-scoped read.
DROP POLICY domain_event_read ON domain_event;--> statement-breakpoint
CREATE POLICY domain_event_read ON domain_event FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (subject_employment_id IS NOT NULL AND app.can_see_employment(subject_employment_id))
    )
  );
