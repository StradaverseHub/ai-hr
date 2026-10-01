-- r375 (board 7c972a40, "An employee cannot be shown their own supervisor's name") — THE NAME AND EMPLOYEE
-- ID OF YOUR OWN SUPERVISOR, AND NOTHING ELSE ABOUT THEM.
--
-- THE SITUATION THIS FIXES. Visibility in this product flows DOWNWARD. `app.can_see_employment` (latest
-- definition 0109) admits admin-for-company, self, the recursive administrative DOWN-walk via
-- `app.is_admin_report_of`, and the head-of-department tree via `app.heads_department_of`. There is no
-- upward branch, and `app.can_see_person` (0029, widened for partners in 0099) delegates its third
-- disjunct to it. `reporting_line` SELECT is tenant-wide (0196 leaves USING as tenant_id only), so the
-- EDGE is visible to the subordinate — what drops the name is the join to `employment` and `person`.
-- Two readers hit this, by two different code paths:
--
--   • core/read.ts `reportingLinesFor` — one query inner-joining reporting_line → employment → person.
--     For a plain employee the `managers` array comes back EMPTY, so the five
--     `lines.managers.find(administrative)?.name ?? t('otGoesToUnknown')` call sites
--     (app/attendance/request-status/page.tsx, .../request-status/export/route.ts, .../requests/page.tsx,
--     .../plan-ot/page.tsx, .../plan-ot/apply/page.tsx) fall through. `otGoesToUnknown` is NOT an unknown:
--     its value in messages/en.json is "Your HR administrator" (and the equivalent in ms, zh, th, vi, ta).
--     `assertCanDecide` (core/approvals.ts) admits an hr_admin/super_admin OR the subject's current direct
--     administrative manager OR an active delegate, so naming HR is a PERMITTED decider — just the wrong
--     normal answer for anybody who has a supervisor.
--   • core/roster.ts `administrativeManagerNameTx`, called from `myRosterWindow` — its own helper, and NOT
--     one join: it reads `reporting_line` alone first (tenant-wide, so it SUCCEEDS and yields the manager's
--     employment id), then joins employment → person in a SECOND query, which returns no row. Same block,
--     different mechanism. My Roster therefore prints "speak to your supervisor" rather than the name the
--     approved design shows.
--
-- WHY A FUNCTION AND NOT A POLICY — THE WIDENING THIS MIGRATION REFUSES. `person` carries date_of_birth,
-- gender, marital_status, religion, race (PDPA 2010 s.40 sensitive personal data), address_line1..3,
-- personal_email, phone and home_phone. `app.can_see_person` ADDITIONALLY gates employee_statutory_my
-- (0004), employee_dependent (0137), tp1_relief (0102), the person photo (0168),
-- person_emergency_contact (0322) and employee_tp3 (0480). Adding an upward branch to it would hand every
-- subordinate every one of those columns for their manager, through every read in the product, forever.
-- Migration 0472's header refused this exact widening for the leave approver names for this exact reason;
-- this migration refuses it again. NEITHER `app.can_see_person` NOR `app.can_see_employment` NOR any
-- policy is touched here. The only new object is one SECURITY DEFINER reader, following the two existing
-- precedents: `app.self_delegations` (0196) and `app.own_leave_request_approvals` (0472).
--
-- WHAT THE FUNCTION RETURNS, AND THE FOUR FENCES ON IT
--
--   app.own_reporting_managers(p_employment_id uuid)
--     → reporting_line_id, line_type, manager_employment_id, manager_person_id, full_name, employee_code,
--       valid_from, valid_to
--
--   1. OWNERSHIP. Rows only when the ARGUMENT employment's person_id equals the app_user.person_id of
--      app.current_user_id(), inside app.current_tenant_id(). A colleague's employment, a report's
--      employment viewed by their manager, an id from another tenant, or no session at all returns NO
--      ROWS — never an error — so the function cannot be used to probe which ids exist. There is
--      deliberately NO admin branch: an administrator already reads these names through RLS, and this
--      read exists for the one audience that cannot.
--   2. ONE HOP. Only edges whose subordinate IS the argument employment. Not the chain above the manager.
--      `app.own_reporting_managers(my_manager_id)` returns nothing, because that employment is not mine.
--   3. CURRENT ONLY, and the DATE IS THE TENANT'S. superseded_at IS NULL, valid_from <= today and
--      (valid_to IS NULL OR valid_to > today), where today is `(now() AT TIME ZONE 'Asia/Kuala_Lumpur')
--      ::date` — the SQL form of lib/hr-date.ts `todayInKualaLumpur()`, the idiom 0288/0320/0449 already
--      use. NOT `current_date`: on a UTC server that is yesterday for the first eight hours of every
--      Malaysian day, which would hand the screen the OUTGOING supervisor's name across a handover.
--      There is no as-of PARAMETER on purpose — a date argument would turn this into a history reader,
--      and the approved scope is the current line.
--   4. NO delegate EDGES. `line_type::text <> 'delegate'` (the ::text parity 0196/0109/0138 use). A
--      `delegate` row is an approver stand-in, not a supervisor (ADR-0052), and `delegationsFor` already
--      surfaces those separately to the people entitled to them.
--
-- NON-ADMINISTRATIVE LINES ARE INCLUDED (functional, project, dotted) because the approved
-- expected_behavior asks for "the people directly above them in their own reporting line", not only the
-- administrative one. Every current screen filters to `administrative` itself.
--
-- COLUMNS: display identity only — full_name and employee_code, plus the ids and dates the two callers
-- need to apply their own existing window rules unchanged. No pay, no statutory or identity number, no
-- bank detail, no date of birth, no address, no contact, no photo, no employment record. `valid_from` /
-- `valid_to` are returned so core/roster.ts can keep its exact tie-break (latest valid_from wins among
-- several current administrative lines) instead of relocating that rule into SQL.
--
-- search_path = pg_catalog, public, pg_temp AND every relation schema-qualified (migration 0312's rule for
-- SECURITY DEFINER): with `search_path = public` alone Postgres still searches pg_temp FIRST, and an
-- app-role session that creates a temp `app_user` table would otherwise answer the ownership check with a
-- person of its own choosing. test/r375-own-supervisor-name.test.ts reproduces that attack.
--
-- EXECUTE: revoked from PUBLIC (a new function is executable by PUBLIC by default) and granted to
-- ai_hr_app.
--
-- ⚠️ NUMBERING. 0498 — allocated from max(idx) in db/migrations/meta/_journal.json, which is 497.
-- entries.length is 406 and MUST NOT be used: a number below the applied watermark is a SILENT skip at
-- exit 0.
--
-- Rollback:
--   DROP FUNCTION app.own_reporting_managers(uuid);

CREATE OR REPLACE FUNCTION app.own_reporting_managers(p_employment_id uuid)
  RETURNS TABLE(
    reporting_line_id uuid,
    line_type text,
    manager_employment_id uuid,
    manager_person_id uuid,
    full_name text,
    employee_code text,
    valid_from date,
    valid_to date
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH today AS (
    -- The tenant's calendar date, not the server's. See fence 3 in the header.
    SELECT ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AS d
  ),
  -- The ONE employment this call may answer for: an employment of the signed-in user's own person,
  -- inside the session's tenant. No match ⇒ the joins below produce no rows at all.
  mine AS (
    SELECT e.id, e.tenant_id
    FROM public.employment e
    WHERE e.id = p_employment_id
      AND e.tenant_id = app.current_tenant_id()
      AND EXISTS (
        SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id()
          AND u.tenant_id = e.tenant_id
          AND u.person_id = e.person_id
      )
  )
  SELECT rl.id,
         rl.line_type::text,
         rl.manager_employment_id,
         me.person_id,
         p.full_name,
         me.employee_code,
         rl.valid_from,
         rl.valid_to
  FROM mine
  CROSS JOIN today t
  JOIN public.reporting_line rl
    ON rl.subordinate_employment_id = mine.id
   AND rl.tenant_id = mine.tenant_id
  JOIN public.employment me
    ON me.id = rl.manager_employment_id
   AND me.tenant_id = rl.tenant_id
  JOIN public.person p
    ON p.id = me.person_id
   AND p.tenant_id = me.tenant_id
  WHERE rl.line_type::text <> 'delegate'
    AND rl.superseded_at IS NULL
    AND rl.valid_from <= t.d
    AND (rl.valid_to IS NULL OR rl.valid_to > t.d);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_reporting_managers(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_reporting_managers(uuid) TO ai_hr_app;
