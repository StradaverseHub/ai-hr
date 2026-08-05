-- 6e9a126e — Architecture Review & Redesign of the Entire Leave Entitlement Workflow, RELEASE ONE of three.
--
-- The reporter's three layers, and nothing else:
--
--     leave_type  →  entitlement_template  →  entitlement_eligibility_rule
--
-- ⚠️ THIS MIGRATION ADDS. IT REMOVES NOTHING AND CLEARS NOTHING.
-- benefit_scheme, scheme_leave_entitlement, employment.benefit_scheme_id and leave_policy are all still
-- here, still resolve every live entitlement figure, and are untouched by this release. On the day this
-- ships, 9 of 26 live employments take their days through a benefit scheme and the remaining 17 fall
-- through to leave_policy (counted on production 2026-08-05) — so nothing about the old layer is
-- ceremonial and nothing about it moves here. Release two re-points the engines through the single
-- shared composition; release three archives, clears and drops.
--
-- ── WHY BOTH TABLES ARE EFFECTIVE-DATED ──────────────────────────────────────────────────────────────
-- Three readers resolve entitlement AT A PAST DATE today: the Carry Forward report (per employee at
-- THEIR own cycle open), the year sweep in expireCarriedLeave, and the /me + admin balance breakdown.
-- All three lean on leave_policy.valid_from/valid_to. A replacement without dating would answer a closed
-- year with today's figures — which contradicts the request's own "maintaining all existing calculation
-- capabilities". So an edit CLOSES the running version and INSERTS a successor, exactly as
-- createLeavePolicy already does.
--
-- ── WHY lineage_id ───────────────────────────────────────────────────────────────────────────────────
-- An eligibility rule must keep pointing at "the Executive table" across every future version of it. A FK
-- to a VERSION row goes stale the moment that version is superseded; a reference by NAME cannot survive a
-- rename. lineage_id is the identity of the table THROUGH TIME: version 1 carries its own id, successors
-- inherit it, and resolution is "the version of THIS lineage in force on THAT date".

CREATE TABLE IF NOT EXISTS entitlement_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  lineage_id uuid NOT NULL,
  -- CONSTANT across a lineage. A successor version may change the name and the bands, never the type.
  -- It is also what lets deleteLeaveType keep refusing a type that carries live entitlement
  -- configuration once leave_policy is gone (core/admin.ts's in-use guard counts these rows).
  leave_type_id uuid NOT NULL REFERENCES leave_type(id),
  name text NOT NULL,
  -- ServiceBand[] — the SAME JSONB shape scheme_leave_entitlement and leave_policy.accrual already use,
  -- resolved by the SAME bandDaysFor / isWellFormedBands. The reporter's four columns map exactly.
  -- The band CEILING moves 10 → 20 in this release, in both the write-time validator and the defensive
  -- resolver together (core/admin.ts + core/leave-compute.ts); the shape is otherwise unchanged.
  service_bands jsonb NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- A blank name is a table nobody can pick out of a list.
ALTER TABLE entitlement_template DROP CONSTRAINT IF EXISTS entitlement_template_name_check;
--> statement-breakpoint
ALTER TABLE entitlement_template ADD CONSTRAINT entitlement_template_name_check CHECK (btrim(name) <> '');
--> statement-breakpoint

-- An inverted window is a version that was never in force. valid_to is EXCLUSIVE, so equal dates are an
-- empty window and are refused too.
ALTER TABLE entitlement_template DROP CONSTRAINT IF EXISTS entitlement_template_window_check;
--> statement-breakpoint
ALTER TABLE entitlement_template ADD CONSTRAINT entitlement_template_window_check
  CHECK (valid_to IS NULL OR valid_to > valid_from);
--> statement-breakpoint

-- The band table must be an ARRAY. Shape (contiguity, first-from-0, last-open-ended, the 20-band ceiling)
-- is validated in the service, exactly where leave_policy's is; this is the floor below which no reader
-- has a defined answer at all.
ALTER TABLE entitlement_template DROP CONSTRAINT IF EXISTS entitlement_template_bands_check;
--> statement-breakpoint
ALTER TABLE entitlement_template ADD CONSTRAINT entitlement_template_bands_check
  CHECK (jsonb_typeof(service_bands) = 'array' AND jsonb_array_length(service_bands) > 0);
--> statement-breakpoint

-- At most ONE running version per lineage. "Two open versions" is a state no reader has a defined answer
-- for, so it is refused by the database and not only by the writer.
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_template_open_uq
  ON entitlement_template (tenant_id, lineage_id) WHERE valid_to IS NULL;
--> statement-breakpoint
-- Two RUNNING tables of the same name under one leave type are indistinguishable in a picker. Closed
-- versions are deliberately outside the index: a superseded "Executive" must not block its successor.
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_template_name_uq
  ON entitlement_template (tenant_id, leave_type_id, lower(name)) WHERE valid_to IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_template_type_idx ON entitlement_template (tenant_id, leave_type_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_template_lineage_idx ON entitlement_template (lineage_id);
--> statement-breakpoint

-- ── WHO GETS WHICH TABLE ─────────────────────────────────────────────────────────────────────────────
--
-- THE CRITERIA ARE core/org-criteria.ts's OrgCriteria — NOT A NEW VOCABULARY. This whole item exists
-- because the same question ("who does this apply to") is answered in several places at once. Minting a
-- THIRD engine to fix that would be self-defeating, so the criteria stored here are the EXACT object
-- resolveOrgCriteriaTargets already resolves for bulk Leave Adjustments (491c499f) and the Notice Board
-- (6e122302), widened by 18103ba4. Every dimension the reporter listed is already in it — Company,
-- Employment Type, Grade, Department, Position, Division, Gender, Minimum Service, Probation Status —
-- and every axis it can resolve is resolved AS AT a date, which is the requirement the approval matcher
-- could not have met (it is handed its attributes as of NOW by its caller).
--
-- There is deliberately NO FK on template_lineage_id: a lineage is not a row, and pointing the FK at one
-- VERSION would be the exact staleness the lineage exists to remove. The service refuses a lineage with
-- no template behind it.
CREATE TABLE IF NOT EXISTS entitlement_eligibility_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  lineage_id uuid NOT NULL,
  name text NOT NULL,
  template_lineage_id uuid NOT NULL,
  -- An EMPTY object is a real value: it means "everyone", exactly as it does for the Notice Board, and it
  -- is how a tenant expresses a single default table. Every screen that resolves criteria is required to
  -- show the resolved COUNT before anybody presses anything (countOrgCriteriaTargets).
  criteria jsonb NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE entitlement_eligibility_rule DROP CONSTRAINT IF EXISTS entitlement_eligibility_rule_name_check;
--> statement-breakpoint
ALTER TABLE entitlement_eligibility_rule ADD CONSTRAINT entitlement_eligibility_rule_name_check
  CHECK (btrim(name) <> '');
--> statement-breakpoint

ALTER TABLE entitlement_eligibility_rule DROP CONSTRAINT IF EXISTS entitlement_eligibility_rule_window_check;
--> statement-breakpoint
ALTER TABLE entitlement_eligibility_rule ADD CONSTRAINT entitlement_eligibility_rule_window_check
  CHECK (valid_to IS NULL OR valid_to > valid_from);
--> statement-breakpoint

-- An object, not an array and not a scalar. `{}` is valid and meaningful (see above).
ALTER TABLE entitlement_eligibility_rule DROP CONSTRAINT IF EXISTS entitlement_eligibility_rule_criteria_check;
--> statement-breakpoint
ALTER TABLE entitlement_eligibility_rule ADD CONSTRAINT entitlement_eligibility_rule_criteria_check
  CHECK (jsonb_typeof(criteria) = 'object');
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS entitlement_eligibility_rule_open_uq
  ON entitlement_eligibility_rule (tenant_id, lineage_id) WHERE valid_to IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_eligibility_rule_template_idx
  ON entitlement_eligibility_rule (tenant_id, template_lineage_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_eligibility_rule_window_idx
  ON entitlement_eligibility_rule (tenant_id, valid_from, valid_to);
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
--
-- STATED EXPLICITLY, not inherited. deploy/bootstrap-db.sql sets ALTER DEFAULT PRIVILEGES FOR ROLE
-- ai_hr_owner, so on production a table this role creates comes out already granted — which is exactly
-- why 0353 shipped a table with no grant and nobody noticed until a developer cluster, where a fresh
-- table can land owned by `postgres`, answered the first real render with `permission denied`. No test
-- sees it: the suite connects as the OWNER. Written out the way 0345 / 0354 / 0357 / 0381 / 0390 do.
-- Idempotent — a GRANT on an already-granted table is a no-op.
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement_template" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "entitlement_eligibility_rule" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
--
-- THE SAME TREATMENT AS THE NEIGHBOURS THEY REPLACE (0205 for benefit_scheme / scheme_leave_entitlement /
-- grade_group, 0134 for leave_policy): tenant-READ, admin-WRITE. The read half is deliberately not
-- admin-gated — an employee's own balance breakdown resolves the configuration that produced their
-- figure, exactly as it resolves leave_policy today, and gating the read would make that screen empty
-- for everyone who is not an administrator.
ALTER TABLE entitlement_template ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS entitlement_template_rls ON "entitlement_template";
--> statement-breakpoint
CREATE POLICY entitlement_template_rls ON "entitlement_template" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

ALTER TABLE entitlement_eligibility_rule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS entitlement_eligibility_rule_rls ON "entitlement_eligibility_rule";
--> statement-breakpoint
CREATE POLICY entitlement_eligibility_rule_rls ON "entitlement_eligibility_rule" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
