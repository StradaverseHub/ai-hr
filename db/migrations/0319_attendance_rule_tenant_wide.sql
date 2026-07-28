-- 6da67ab7 · "Remove Company-Level Segregation from Attendance Policy (Bind Directly to Shift Setting)".
--
-- The attendance CALCULATION rules behind the Attendance Policy screen (attendance_rule) become TENANT-WIDE,
-- exactly as shift templates did in migration 0197 (R33 f21d6eee). A shift already picks its rule through
-- shift.rule_id, and a shift is tenant-wide — so a per-company rule library meant one shared shift could only
-- ever point at ONE company's rules while employees of every other company were rostered onto it. Dropping
-- the company axis is what makes the reporter's sentence true: the policy applied is decided by whichever
-- shift the employee is assigned to, regardless of company.
--
-- NOT TOUCHED — attendance_policy (the per-company work schedule). That row is the FALLBACK for a day with
-- NO assigned shift: the branch b7b886e2 deliberately left on the legacy duration math and pinned by
-- test/attendance-shift-window.test.ts. A shift cannot supply the schedule for a day that has no shift, so
-- it stays; the screen now names it for what it is instead of calling it "the attendance policy".
--
-- CONVERSION — nothing is deleted, no company loses the settings it has today:
--   1. company_id → NULLABLE and then NULLed on every row: one tenant-wide list, no company filter.
--   2. ONE tenant-wide Standard (is_default) rule. Where a tenant held several (one per company), the
--      Standard of the company with the MOST employments wins, so the largest population of no-shift /
--      no-rule employees keeps exactly the thresholds it has today. Every other company's Standard SURVIVES
--      as an ordinary named rule, renamed "Standard — <Company>" so an admin can see what it came from and
--      attach it to that company's shifts.
--   3. Rule names become unique tenant-wide (case-insensitive). Leftover collisions are suffixed " #n",
--      never merged — the same non-destructive rule 0197 used for shift names.
--   4. RLS write gate: app.is_admin_for(company_id) → app.is_admin(). is_admin_for is unusable against a
--      NULL company_id, and a shared library is a tenant-admin object (identical reasoning to 0197).
--
-- Idempotent: on a re-run there is already at most one default per tenant, no non-null company_id and no
-- duplicate names, so every UPDATE touches zero rows.

ALTER TABLE "attendance_rule" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "attendance_rule_default_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "attendance_rule_company_name_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "attendance_rule_company_idx";--> statement-breakpoint

-- Report what is about to move, per rule, while company_id is still readable (the plan's "assert no company
-- silently loses its current rules"). The rename below carries the same provenance into the UI permanently.
DO $$
DECLARE r record;
BEGIN
	FOR r IN
		SELECT ar.tenant_id, ar.name, ar.is_default, c.legal_name AS company_name
		FROM attendance_rule ar LEFT JOIN company c ON c.id = ar.company_id
		WHERE ar.company_id IS NOT NULL
		ORDER BY ar.tenant_id, ar.is_default DESC, ar.name
	LOOP
		RAISE NOTICE '0319 attendance_rule: tenant % — "%" (company %) becomes tenant-wide%',
			r.tenant_id, r.name, COALESCE(r.company_name, '?'), CASE WHEN r.is_default THEN ' [was a company Standard]' ELSE '' END;
	END LOOP;
END $$;--> statement-breakpoint

-- Elect the surviving tenant Standard: most employments first, then oldest. Demote the rest — kept in full,
-- renamed so their origin stays visible and the tenant-wide name index below can be created.
WITH ranked AS (
	SELECT ar.id,
		row_number() OVER (
			PARTITION BY ar.tenant_id
			ORDER BY (SELECT count(*) FROM employment e WHERE e.company_id = ar.company_id) DESC, ar.created_at, ar.id
		) AS rn
	FROM attendance_rule ar
	WHERE ar.is_default
)
UPDATE attendance_rule ar
SET is_default = false,
	name = 'Standard — ' || COALESCE((SELECT c.legal_name FROM company c WHERE c.id = ar.company_id), 'Company'),
	description = COALESCE(ar.description, 'Default attendance calculation rule.')
		|| ' (Was this company''s Standard rule before attendance rules became tenant-wide.)'
FROM ranked k
WHERE k.id = ar.id AND k.rn > 1;--> statement-breakpoint

UPDATE attendance_rule SET company_id = NULL WHERE company_id IS NOT NULL;--> statement-breakpoint

-- Any remaining cross-company name collision is disambiguated, never merged: keep the earliest row of each
-- group and suffix the rest.
UPDATE attendance_rule ar SET name = ar.name || ' #' || d.rn
FROM (
	SELECT id, row_number() OVER (PARTITION BY tenant_id, lower(name) ORDER BY created_at, id) AS rn
	FROM attendance_rule
) d
WHERE ar.id = d.id AND d.rn > 1;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "attendance_rule_tenant_default_uq" ON "attendance_rule" USING btree ("tenant_id") WHERE "is_default";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_rule_tenant_name_uq" ON "attendance_rule" USING btree ("tenant_id", lower("name"));--> statement-breakpoint

DROP POLICY IF EXISTS attendance_rule_rls ON attendance_rule;--> statement-breakpoint
CREATE POLICY attendance_rule_rls ON attendance_rule FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

DROP POLICY IF EXISTS attendance_rule_ot_row_rls ON attendance_rule_ot_row;--> statement-breakpoint
-- OT rows follow their rule; with the library tenant-wide there is no company left to gate on.
CREATE POLICY attendance_rule_ot_row_rls ON attendance_rule_ot_row FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
