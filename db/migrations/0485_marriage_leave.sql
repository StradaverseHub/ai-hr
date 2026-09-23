-- Marriage Leave — 72fca31d, points 2/3/4 (the "only Single may apply" gate, point 1, was already
-- configured on production and is untouched here).
--
-- THREE THINGS, and the first is why the other two can exist at all.
--
-- 1. `marriage` JOINS THE ROLE VOCABULARY. Every behaviour below has to answer "is THIS the tenant's
--    Marriage Leave type", and until now nothing in the system could. `leave_type.role` (65f466e2,
--    migration 0387) is the tenant-independent marker and its CHECK is a closed 7-value set with no
--    marriage in it; the only other marriage-ish strings in the repo are `lib/leave-groups.ts` and
--    `lib/leave-visual.ts`, and both are DISPLAY maps keyed on the seeded code 'MARRIAGE' — a code the
--    pack does not actually seed and which production's row (coded `MRL`) does not carry. Scoping these
--    rules by NAME was refused for the reason 0387 was written: a name match is a tenant's free text.
--
--    THE BACKFILL DOES NOT GUESS — it is 0387's own two passes, both exact, no LIKE and no fuzz:
--      pass 1, by exact code: 'MARRIAGE' (what the display maps assume) and 'MRL' (measured on the
--              reporting account 2026-09-23, where the Marriage Leave row carries
--              eligibility {"maritalStatus":["single"]} and probation_eligibility 'confirmed_only');
--      pass 2, by exact name: 'marriage leave', trimmed and case-folded, exactly as 0387 pass 2
--              classified this account's EL / MTL / PTL / RL rows.
--    Anything unmatched stays NULL = UNCLASSIFIED = today's behaviour, and points 2/3/4 simply do not
--    apply to it. That is the safe direction and it is REPORTED below rather than assumed: if the
--    notice says 0 rows classified on a tenant that does have Marriage Leave, a human classifies the
--    row by hand — the software must never widen the match to find one.
--
-- 2. person.marital_status_source_request_id — THE PERSISTED CAUSE, so the reversal in point 4 can be
--    certain instead of clever. It names the leave request whose approval wrote the CURRENT value of
--    person.marital_status, and it is NULLed by every other writer of that column (core/profile.ts
--    setPersonComplianceFields and decideProfileChange, the only two). So "a status a human set by
--    hand" carries no pointer and can never be reverted — the guarantee is structural, not inferred
--    from timestamps or from the event log.
--
-- 3. TWO SECURITY DEFINER WRITERS, because the approver is usually NOT allowed to write `person`.
--    person_rls (latest definition 0099) is `WITH CHECK (tenant_id = … AND (app.is_admin() OR
--    app.is_self_person(id)))`. A line manager clearing the final approval step is neither, so a plain
--    UPDATE person from inside the approval transaction is refused by RLS and rolls the whole approval
--    back. Widening that policy is out of the question — it guards IC, bank and every other person
--    column. So the write goes through two functions that can do EXACTLY the two lawful moves and
--    nothing else, which is the reasoning migrations 0207 and 0433 already wrote down for app_user.
--
--    Each function DERIVES everything from the leave request id: the caller cannot name a person, a
--    value, or a leave type. Each returns an OUTCOME CODE rather than a boolean, so the caller can tell
--    "lawfully did nothing" (the person was not single; a human had changed the value) apart from "I was
--    refused" (the type does not play the marriage role) — the second is a code/SQL drift and
--    core/leave.ts throws on it rather than letting a designed behaviour silently stop running, which is
--    the exact failure 0387 was written to end.
--
-- No leave, balance, ledger or entitlement row is read or written by this migration.

-- ── 1. the role ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS leave_type_role_check;--> statement-breakpoint
ALTER TABLE leave_type ADD CONSTRAINT leave_type_role_check
  CHECK (role IS NULL OR role IN
    ('annual','sick','hospitalization','maternity','paternity','emergency','replacement','marriage'));--> statement-breakpoint

-- Pass 1 — by exact code (see the header for why 'MRL' is here and why it is not a fuzzy match).
UPDATE leave_type SET role = 'marriage'
 WHERE role IS NULL
   AND upper(btrim(code)) IN ('MARRIAGE','MRL');--> statement-breakpoint

-- Pass 2 — by exact English name, for a tenant whose code is neither of the two above.
UPDATE leave_type SET role = 'marriage'
 WHERE role IS NULL
   AND lower(btrim(name)) = 'marriage leave';--> statement-breakpoint

DO $$
DECLARE n int; dupes text;
BEGIN
  SELECT count(*) INTO n FROM leave_type WHERE role = 'marriage' AND archived_at IS NULL;
  RAISE NOTICE '0485 leave_type.role=marriage: % row(s) classified. Unmatched rows stay NULL and keep today''s behaviour (points 2/3/4 do not apply to them).', n;

  SELECT string_agg(t, '; ') INTO dupes FROM (
    SELECT tenant_id::text || ' x' || count(*)::text AS t
      FROM leave_type WHERE role = 'marriage' AND archived_at IS NULL
     GROUP BY tenant_id HAVING count(*) > 1
  ) d;
  IF dupes IS NOT NULL THEN
    RAISE WARNING '0485: MORE THAN ONE ROW CLAIMS role=marriage — %. The pending-duplicate rule spans all of them; a human should confirm that is intended.', dupes;
  END IF;
END $$;--> statement-breakpoint

-- ── 2. the persisted cause ─────────────────────────────────────────────────────────────────────────
ALTER TABLE person ADD COLUMN IF NOT EXISTS marital_status_source_request_id uuid;--> statement-breakpoint

-- ON DELETE SET NULL, not CASCADE: losing the leave request must lose the CLAIM about who set the
-- status, never the status itself.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'person_marital_status_source_request_fk') THEN
    ALTER TABLE person ADD CONSTRAINT person_marital_status_source_request_fk
      FOREIGN KEY (marital_status_source_request_id) REFERENCES leave_request(id) ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint

COMMENT ON COLUMN person.marital_status_source_request_id IS
  '72fca31d — the approved Marriage Leave request whose approval wrote the CURRENT marital_status. '
  'NULL means a human (or any other writer) owns the value, and a Marriage Leave cancellation must then '
  'never revert it. Every other writer of marital_status NULLs this column.';--> statement-breakpoint

-- ── 3. the two privileged writers ──────────────────────────────────────────────────────────────────
-- The role test restates leaveTypeIs(lt, 'marriage') (core/leave.ts): a non-blank role wins outright,
-- a blank/NULL role falls back to the seeded code. test/marriage-leave.test.ts drives all three
-- branches through THIS function so the restatement cannot drift unnoticed.
CREATE OR REPLACE FUNCTION app.marriage_leave_set_married(p_request_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_person_id uuid; v_status text; v_n int;
BEGIN
  SELECT p.id, r.status INTO v_person_id, v_status
    FROM leave_request r
    JOIN employment e ON e.id = r.employment_id
    JOIN person p ON p.id = e.person_id
    JOIN leave_type lt ON lt.id = r.leave_type_id
   WHERE r.id = p_request_id
     AND r.tenant_id = app.current_tenant_id()
     AND (CASE WHEN coalesce(btrim(lt.role), '') <> '' THEN btrim(lt.role) = 'marriage'
               ELSE upper(btrim(lt.code)) = 'MARRIAGE' END);
  IF v_person_id IS NULL THEN RETURN 'not_marriage'; END IF;
  IF v_status <> 'approved' THEN RETURN 'not_approved'; END IF;

  UPDATE person
     SET marital_status = 'married', marital_status_source_request_id = p_request_id
   WHERE id = v_person_id AND marital_status = 'single';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n > 0 THEN 'changed' ELSE 'not_single' END;
END $$;--> statement-breakpoint

-- THE REVERSAL, and the two things it refuses.
--   · it refuses unless person.marital_status_source_request_id names THIS APPLICATION. "This
--     application" is the request itself OR a sibling sharing its parent_group_id, because a partial
--     cancellation (ADR-0065) SPLITS one application into several rows and the pointer keeps naming the
--     row it was written for. Widening it to the group is the same application, not a different one.
--   · it refuses while ANY row of that application is still approved — giving back one day of a
--     three-day marriage leave does not un-marry anybody.
CREATE OR REPLACE FUNCTION app.marriage_leave_revert_single(p_request_id uuid)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_person_id uuid; v_group uuid; v_source uuid; v_marital text; v_live int; v_n int;
BEGIN
  SELECT p.id, r.parent_group_id, p.marital_status_source_request_id, p.marital_status
    INTO v_person_id, v_group, v_source, v_marital
    FROM leave_request r
    JOIN employment e ON e.id = r.employment_id
    JOIN person p ON p.id = e.person_id
    JOIN leave_type lt ON lt.id = r.leave_type_id
   WHERE r.id = p_request_id
     AND r.tenant_id = app.current_tenant_id()
     AND (CASE WHEN coalesce(btrim(lt.role), '') <> '' THEN btrim(lt.role) = 'marriage'
               ELSE upper(btrim(lt.code)) = 'MARRIAGE' END);
  IF v_person_id IS NULL THEN RETURN 'not_marriage'; END IF;
  IF v_source IS NULL THEN RETURN 'not_caused_by_request'; END IF;

  IF v_source <> p_request_id THEN
    IF v_group IS NULL THEN RETURN 'not_caused_by_request'; END IF;
    PERFORM 1 FROM leave_request s
      WHERE s.id = v_source AND s.tenant_id = app.current_tenant_id() AND s.parent_group_id = v_group;
    IF NOT FOUND THEN RETURN 'not_caused_by_request'; END IF;
  END IF;

  SELECT count(*) INTO v_live FROM leave_request s
   WHERE s.tenant_id = app.current_tenant_id()
     AND s.status = 'approved'
     AND (s.id = p_request_id OR (v_group IS NOT NULL AND s.parent_group_id = v_group));
  IF v_live > 0 THEN RETURN 'still_approved'; END IF;

  IF v_marital IS DISTINCT FROM 'married' THEN RETURN 'not_married'; END IF;

  UPDATE person
     SET marital_status = 'single', marital_status_source_request_id = NULL
   WHERE id = v_person_id AND marital_status = 'married';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n > 0 THEN 'changed' ELSE 'not_married' END;
END $$;--> statement-breakpoint

-- The application role reaches these two writes ONLY through these functions, so the EXECUTE grants are
-- the whole of its access (production's ALTER DEFAULT PRIVILEGES does not cover functions — 0433).
GRANT EXECUTE ON FUNCTION app.marriage_leave_set_married(uuid) TO ai_hr_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.marriage_leave_revert_single(uuid) TO ai_hr_app;
