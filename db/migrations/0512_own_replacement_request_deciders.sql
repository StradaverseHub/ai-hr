-- r389 (board bc3e203d, "Leave Credit History") — THE NAME OF WHOEVER DECIDED YOUR OWN LEAVE CREDIT REQUEST,
-- AND NOTHING ELSE ABOUT THEM.
--
-- THE SITUATION. My Leave › Leave Credit History opens a read-only View panel whose Approval section the
-- reporter's spec and the approved mockup draw as "Approved · <date time> / Level 1 · <approver's name>".
-- `replacement_leave_request.decided_by_user_id` records WHO decided, but an employee cannot turn that id into
-- a name: `app_user` → `person` is fenced by `app.can_see_person` (0001, 0029, 0099), which admits self,
-- administrators and people whose EMPLOYMENT the caller may see — and visibility flows DOWNWARD only, so a
-- manager's (or an HR administrator's) person row is invisible to the report they decided for. Verified, not
-- assumed: test/r389-leave-credit-history.test.ts reads the join as ai_hr_app with the employee's session and
-- gets no name, then reads it through this function and gets it.
--
-- WHY A FUNCTION AND NOT A POLICY — the widening 0472 and 0498 already refused, refused again. `person`
-- carries date_of_birth, gender, marital_status, religion, race (PDPA 2010 s.40 sensitive data), addresses
-- and contacts, and `app.can_see_person` also gates statutory, dependant, relief, photo, emergency-contact and
-- TP3 rows. An upward branch would hand every employee all of that about everyone who ever decided for them.
-- NEITHER `app.can_see_person` NOR `app.can_see_employment` NOR any policy is touched. The only new object is
-- one SECURITY DEFINER reader, in the shape of `app.own_leave_request_approvals` (0472).
--
-- WHAT IT RETURNS, AND THE FENCES ON IT
--
--   app.own_replacement_request_deciders(p_request_ids uuid[]) → request_id, decided_by_name
--
--   1. OWNERSHIP, CHECKED INSIDE. A row only for a replacement_leave_request in app.current_tenant_id() whose
--      employment's person_id equals the app_user.person_id of app.current_user_id() (same tenant). A
--      colleague's request, a report's request read by their manager, an id from another tenant, or no
--      session at all returns NO ROWS — never an error — so it cannot be used to probe which ids exist.
--      There is deliberately NO administrator branch: an administrator already reads these names through
--      RLS, and this read exists for the one audience that cannot.
--   2. DECIDED ONLY. status approved or rejected, with decided_by_user_id set. A pending or cancelled request
--      names nobody.
--   3. ONE COLUMN ABOUT THE DECIDER: `person.full_name`. No employee code, no employment, no contact, no
--      role. A decider whose login has no person (an installation operator) yields NULL, and the screen
--      then prints the level alone.
--
-- search_path = pg_catalog, public, pg_temp AND every relation schema-qualified (migration 0312's rule for
-- SECURITY DEFINER): with `search_path = public` alone Postgres still searches pg_temp FIRST, and an app-role
-- session that created a temp `app_user` table could otherwise answer the ownership check with a person of
-- its own choosing. The test reproduces that attack and expects no rows.
--
-- EXECUTE: revoked from PUBLIC (a new function is executable by PUBLIC by default) and granted to ai_hr_app
-- only.
--
-- ⚠️ NUMBERING. 0512, allocated centrally for r389: 0510 and 0511 ship on build/r389-c-company-drafts with
-- `when` 1791210417875 and 1791210418875, and this entry's `when` is strictly greater (1791210419875) so the
-- three apply in order whichever branch merges first.
--
-- Rollback:
--   DROP FUNCTION app.own_replacement_request_deciders(uuid[]);

CREATE OR REPLACE FUNCTION app.own_replacement_request_deciders(p_request_ids uuid[])
  RETURNS TABLE(request_id uuid, decided_by_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.id,
         (SELECT p.full_name
            FROM public.app_user du
            JOIN public.person p ON p.id = du.person_id AND p.tenant_id = du.tenant_id
           WHERE du.id = r.decided_by_user_id
             AND du.tenant_id = r.tenant_id)
    FROM public.replacement_leave_request r
    JOIN public.employment e ON e.id = r.employment_id AND e.tenant_id = r.tenant_id
   WHERE r.id = ANY(p_request_ids)
     AND r.tenant_id = app.current_tenant_id()
     AND r.status IN ('approved', 'rejected')
     AND r.decided_by_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id()
          AND u.tenant_id = r.tenant_id
          AND u.person_id = e.person_id
     );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_replacement_request_deciders(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_replacement_request_deciders(uuid[]) TO ai_hr_app;
