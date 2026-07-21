-- User lifecycle: archive a login + block a leaver at sign-in (feedback aaaaaaaa).
--
-- Two ways a login stops working, one predicate:
--   1) MANUAL — an administrator archives it (app_user.archived_at set). Reversible from the UI.
--   2) DERIVED — every employment belonging to the login's person has ENDED. Not stored, not swept:
--      computed at resolve time, exactly like core/employment-status.ts derives the employee status.
--      This is deliberate. A stored flag drifts (a nightly sweep leaves an overnight window in which a
--      leaver still has access, and it silently never runs if the schedule was not installed); a derived
--      predicate cannot. Clearing the employment end dates restores access by itself, with no un-archive
--      step, which is also the documented unwind for a reversed termination.
--
-- OFF-BY-ONE, DELIBERATE AND LOAD-BEARING: an employment counts as ended only when
-- current_date > (earliest end date) — STRICTLY after. So the login still works for the whole of the
-- final working day, which is what handover requires. core/employment-status.ts flips the LABEL at
-- today >= ended, so on the last day the person reads "Resigned" on other screens while their login
-- still works. That one-day divergence is intended; the same note is on isLoginBlocked() in
-- core/employment-status.ts.
--
-- A person with NO employment row at all is never blocked here — external/IT-admin logins that were
-- never linked to a human must keep working, and only a manual archive touches them.
--
-- BREAK-GLASS (support runbook). Ending the employment of a group's only group-wide admin blocks their
-- login with no in-app recovery: setAppUserArchived() guards the manual path, but the derived path
-- cannot be guarded from here. To restore access, run ONE of these as the migration role:
--   -- reversed termination (the correct unwind — also restores the employee status everywhere):
--   UPDATE employment SET resignation_date = NULL, last_working_date = NULL, terminated_on = NULL,
--          blacklisted_at = NULL
--    WHERE person_id = (SELECT person_id FROM app_user WHERE id = '<app_user_id>');
--   -- manual archive taken in error:
--   UPDATE app_user SET archived_at = NULL WHERE id = '<app_user_id>';
--
-- POST-MERGE: app.principal_by_subject is CREATE OR REPLACE'd here. If another branch also replaces it,
-- whichever migration runs LAST wins and would silently drop the NOT app.login_blocked(u.id) filter,
-- reopening this hole with every test still green. After any such merge, re-read the deployed body.

-- ── 1. The archive flag ──────────────────────────────────────────────────────
-- Nullable, no default: every existing login is Active. No archived_reason column — the reason is
-- derived (left the company vs archived by an administrator) and the manual case's detail lands
-- losslessly in the app-user.archived domain event payload.
ALTER TABLE app_user ADD COLUMN archived_at timestamptz;
--> statement-breakpoint

-- Row security needs no change: 0016 already recreated app_user's policy as
--   USING (tenant_id = app.current_tenant_id())
--   WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin())
-- so a non-group-admin cannot write archived_at even with a raw SQL handle. test/user-lifecycle.test.ts
-- proves that rather than assuming it.

-- ── 2. app.login_blocked — the single definition of "this login is switched off" ──
-- SECURITY DEFINER so it can read app_user/employment from inside app.principal_by_subject (which is
-- itself SECURITY DEFINER and runs pre-RLS) and from the dev-switcher lookup in lib/session.ts.
--
-- "Ended" mirrors deriveEmploymentStatus() in core/employment-status.ts: blacklisted_at wins outright,
-- otherwise the EARLIEST non-null of resignation_date / last_working_date / terminated_on. Postgres
-- LEAST() ignores NULLs and returns NULL only when all inputs are NULL, matching earliest() there.
-- The TS mirror is isLoginBlocked(); test/user-lifecycle.test.ts asserts the two agree across a matrix.
--
-- Cost: employment_person_idx (0000) covers the person_id lookup, so this adds one indexed EXISTS to a
-- function that already does a LEFT JOIN + jsonb_agg.
CREATE OR REPLACE FUNCTION app.login_blocked(p_user_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app_user u
    WHERE u.id = p_user_id
      AND (
        -- manual archive
        u.archived_at IS NOT NULL
        -- or: linked to a person who HAS employments, and none of them is still open
        OR (
          u.person_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM employment e WHERE e.person_id = u.person_id)
          AND NOT EXISTS (
            SELECT 1
            FROM employment e
            WHERE e.person_id = u.person_id
              AND e.blacklisted_at IS NULL
              AND (
                LEAST(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
                -- strictly-after: on the final working day the login still resolves
                OR current_date <= LEAST(e.resignation_date, e.last_working_date, e.terminated_on)
              )
          )
        )
      )
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.login_blocked(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Enforce it on the production (WorkOS) resolve path ────────────────────
-- Header rewritten: the 0151 comment claimed this already returned 0 rows for an offboarded subject.
-- It did not — nothing anywhere reacted to a leaving date. Now it does.
--
-- Returns 0 rows for an unknown subject, an ARCHIVED login, or a login whose person has left →
-- resolveWorkosPrincipal() throws AuthRequiredError → app/layout.tsx redirects to /login. A session
-- already open is stopped on the next page load (WorkOS exposes no server-side session kill).
--
-- NOT applied to app.principal(uuid). That is not an oversight — see lib/session.ts resolveDevPrincipal:
-- it walks [cookieUser, DEV_USER_ID] and returns the FIRST id that RESOLVES, an intentional self-heal
-- for stale cookies. Filtering app.principal would make an archived cookie identity fall THROUGH to
-- DEV_USER_ID (normally the seeded group admin), so archiving a user would ESCALATE their privileges
-- instead of blocking them — and demoSwitcherEnabled() is true in a real build whenever
-- ALLOW_DEMO_SESSION is set, so that is not a dev-only concern. The dev path instead calls
-- app.login_blocked() separately and fails CLOSED on a blocked-but-resolving id, keeping the
-- unknown-id self-heal intact. Do not "fix" this by adding the filter below.
CREATE OR REPLACE FUNCTION app.principal_by_subject(p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid, person_id uuid, grants jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, p.tenant_id, p.person_id, p.grants
  FROM app_user u
  CROSS JOIN LATERAL app.principal(u.id) p
  WHERE u.workos_user_id = p_subject
    AND NOT app.login_blocked(u.id);
$$;
