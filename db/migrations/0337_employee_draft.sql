-- r86c · 6d671f44 — "Redesign Create New Employee Workflow with Step-by-Step Form and Save as Draft".
--
-- WHAT THIS TABLE IS FOR, AND WHY IT IS NOT AN EMPLOYMENT ROW.
-- The obvious implementation of "save as draft" is a partially-populated person + employment with a
-- status flag. That is the wrong shape and the reporter's own requirements say why: a draft must not
-- appear as an employee, must not enter payroll selection, must not trigger statutory calculation,
-- must not be counted in reports, and must NOT consume an Employee ID. An employment row with a flag
-- would satisfy none of those by construction — every list read in the product joins `employment`,
-- and each one would need a new exclusion, forever, with the failure mode being a half-entered person
-- silently appearing in a headcount or a payroll run.
--
-- So a draft is captured INPUT, not a record. It holds what HR has typed so far as JSONB and creates
-- nothing until the wizard's final step, which then runs the SAME writers a hand-entered hire runs
-- (hireEmployee → the company pack's statutory.set → setCompensation). An imported, a hand-entered
-- and a wizard-created employee are therefore indistinguishable, events included.
--
-- WHY THE PAYLOAD IS JSONB AND NOT FORTY COLUMNS. The wizard's field set is the profile's field set,
-- which changes whenever the profile screen does. Mirroring it as columns would mean a migration per
-- profile change and two definitions of "an employee's details" that drift. Nothing READS individual
-- keys in SQL — the draft is opaque to the database and is only ever validated by the same TypeScript
-- that validates the hire form. `label` and `company_id` are lifted out ONLY because the drafts LIST
-- must show a name and scope a draft to a company without parsing every payload.
--
-- RLS — a draft is visible to its AUTHOR and to admins, which is a DIFFERENT rule from an employment's.
-- `created_by_person_id` is the author. There is no `app.can_see_person` here because the draft is not
-- about a person yet: nobody it describes exists. An HR admin can see and finish a colleague's draft
-- (handover is a real need); nobody else sees it at all.
--
-- NO UNIQUE CONSTRAINT ON ANYTHING IN THE PAYLOAD. Two drafts may name the same person, because a draft
-- is not a claim on an identity — the duplicate checks (employee code, IC, email) run at COMPLETION,
-- against the live tables, where they are authoritative. Enforcing them here would block a legitimate
-- second attempt at the same joiner and would still not prevent a concurrent hand-entry.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX use IF NOT EXISTS; the policy is DROP ... IF EXISTS then
-- CREATE. Safe on a re-run and on a fresh chain replayed in one transaction.
--
-- ROLLBACK: DROP TABLE employee_draft. Nothing else references it, and no employee record depends on a
-- draft having existed — completion copies the values forward and deletes the draft.

CREATE TABLE IF NOT EXISTS employee_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- The company chosen on the Employment step, once it has been chosen. Nullable because a draft may
  -- legitimately be saved after step 1 with nothing but a name.
  company_id uuid REFERENCES company(id),
  -- The author. Nullable so a draft is never orphaned into invisibility if its author's person row is
  -- ever removed; an admin can still see and finish it.
  created_by_person_id uuid REFERENCES person(id),
  -- The name typed so far, for the drafts list. Empty string, not null, so the list never has to
  -- special-case a missing label.
  label text NOT NULL DEFAULT '',
  -- Everything the wizard has captured. Opaque to SQL by design (see the header).
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where the wizard should reopen. 1-based, matching the step numbers on screen.
  current_step integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_draft_step_ck CHECK (current_step >= 1 AND current_step <= 20)
);--> statement-breakpoint

-- The drafts list is "mine / this tenant's, most recently touched first".
CREATE INDEX IF NOT EXISTS employee_draft_tenant_updated_idx
  ON employee_draft (tenant_id, updated_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS employee_draft_author_idx
  ON employee_draft (tenant_id, created_by_person_id);--> statement-breakpoint

ALTER TABLE employee_draft ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_draft TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS employee_draft_rls ON employee_draft;--> statement-breakpoint
CREATE POLICY employee_draft_rls ON employee_draft FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.is_admin() OR app.is_self_person(created_by_person_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (app.is_admin() OR app.is_self_person(created_by_person_id))
  );--> statement-breakpoint
