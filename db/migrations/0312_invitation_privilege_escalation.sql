-- Slice 0 — close the invitation privilege-escalation seam (ADR-0077 program, findings F3/F18).
--
-- THE HOLE
-- --------
-- Three facts combined into a tenant-wide escalation that `test/invitation-privesc.test.ts` reproduces
-- against the pre-migration tree:
--
--   1. `app_invitation_rls`'s WITH CHECK (0151:51-53) carries NO role conjunct — it asks only
--      `app.is_admin_for(coalesce(company_id, id))`. A COMPANY-SCOPED hr_admin, who under
--      `role_assignment_write` (0295:66-82) may grant ONLY `hr_admin` inside its own subtree, could
--      therefore write an invitation for ANY role — `super_admin`, or even `operator`.
--   2. `app.consume_invitation` is SECURITY DEFINER (0281) and inserts `v_inv.role` into
--      `role_assignment` uncritically (0151:158-159). `role_assignment` is not FORCE-RLS, so the
--      definer runs as owner and 0295's matrix NEVER EVALUATES. The invitation seam was a way to
--      write a grant that the grant table itself would have refused.
--   3. `role` is not the only payload. `person_id` is too, and the definer's REBIND branch does
--      `UPDATE app_user SET workos_user_id = <the accepter's subject>` on whatever login that person
--      already has. An invitation whose ROLE is perfectly legitimate (hr_admin, own company) but whose
--      PERSON is the group super_admin therefore handed the accepter the victim's identity — every
--      grant it carries — and locked the victim out, since their old subject then resolves to no row.
--      This is the sharper half of the hole: it needs no forbidden role at all.
--   4. The invitation row is MUTABLE after issue. `ai_hr_app` holds UPDATE on every column and the
--      policy's USING is scope-only, so anything that could satisfy the WITH CHECK for the resulting
--      row could flip a `revoked` or `accepted` invitation back to `pending`, blank `accepted_at`, push
--      `expires_at` forward and install a `token_hash` of its own choosing — defeating single-use,
--      expiry and `revokeInvitation` (core/auth.ts:280-286) in one statement. A WITH CHECK cannot fix
--      this: it sees only the NEW row, never the transition.
--   5. THE INVITATION SEAM IS NOT THE ONLY DOOR TO fact (3). `app_user`'s policy (0016:191-193) is
--      `USING (tenant_id = app.current_tenant_id())
--       WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin())`, and ai_hr_app holds
--      table-level UPDATE on app_user (deploy/bootstrap-db.sql:51's ALTER DEFAULT PRIVILEGES). So a GROUP
--      admin could simply run
--          UPDATE app_user SET workos_user_id = '<my second WorkOS account>' WHERE id = <any login>;
--      and re-point ANY login in its tenant — including the installation-tier `operator` login, which
--      `app_user.tenant_id NOT NULL` guarantees lives inside some tenant (db/seed.ts:181-193 puts it in
--      the same tenant as the customer admins). No invitation, no trigger, no guard. Closing hole (3)
--      only at the seam left the shorter path wide open, so layer 5 below closes it at the TABLE.
--
-- The role escalation lands because `app.is_group_admin()` (0016:38-44) is true for ANY `super_admin`
-- grant regardless of company scope — so a company-scoped admin that minted itself a company-scoped
-- `super_admin` became a GROUP admin.
--
-- `core/auth.ts` (ROLES set + assertGroupAdmin) guards the one TypeScript call site, which is why
-- this was not reachable through the invite screen. That is a call site; this is the boundary.
--
-- WHAT THIS MIGRATION DOES — layers, in increasing order of bluntness
-- ------------------------------------------------------------------
--   0. A one-off clean of rows the new constraints would refuse (see below — this is what makes the
--      constraints VALIDATED-safe on a deployment where the hole was already used).
--   1. RLS WITH CHECK: the invitation seam now enforces the SAME matrix as role_assignment_write, plus
--      0020's super_admin-is-group-wide rule, plus a person-scope conjunct on the delegated branch and
--      a tenant-consistency conjunct on the two FK payload columns. An invitation can no longer express
--      a grant OR an identity rebind its creator could not have written directly.
--   2. CHECK constraints: `role` must be a CUSTOMER role, and a `super_admin` invitation must be
--      group-wide — enforced against EVERY writer including ai_hr_owner. Safe because operator grants
--      are never invited: 0294's header is explicit, "Operator grants are inserted by ai_hr_owner only
--      (the seed for dev, by hand on a deployment)".
--   3. A BEFORE UPDATE trigger: an issued invitation is immutable except for its status, its status is
--      one-way, and a SESSION may only ever write `revoked` (the one transition core/auth.ts performs).
--      This is fact (4) above, and it needs a trigger because only a trigger sees OLD.
--   4. consume_invitation re-validates the stored row before granting — the backstop for a row that
--      predates layers 1-3 on a deployment this migration has not seen — and refuses a rebind that
--      would hand the accepter AUTHORITY the invitation does not itself carry.
--   5. A BEFORE UPDATE trigger on app_user: `workos_user_id` — the identity itself — may only be
--      rewritten by the role that OWNS the schema, i.e. by app.consume_invitation (SECURITY DEFINER) or
--      by a migration/maintenance script. This is fact (5) above. Layers 1 and 4 police the invitation
--      seam; this one closes the same takeover at the table, where no invitation is involved at all.
--
-- EVERY SECURITY DEFINER FUNCTION HERE PINS pg_temp LAST IN ITS search_path
-- -------------------------------------------------------------------------
-- Postgres searches the session's TEMPORARY schema FIRST whenever `pg_temp` is not named explicitly, so
-- the house-standard `SET search_path = public` does NOT keep a definer function safe: any ai_hr_app
-- session may `CREATE TEMP TABLE employment(...)` (TEMP is granted to PUBLIC on every database) and
-- thereby choose the answer a definer helper gives. That defeats the person-scope conjunct in layer 1
-- and the tenant guard in layer 4 — the two things this migration adds. Every function this file
-- creates therefore uses `SET search_path = pg_catalog, public, pg_temp` AND schema-qualifies every
-- relation it reads; both, so neither alone is load-bearing.
--
-- app.can_admin_person answers through app.is_admin_for → app.has_role_for → app.is_company_descendant,
-- so pinning only the new functions would leave the conjunct shadowable one level down. The two
-- pre-existing helpers in that chain that actually read a relation (`company`) are therefore re-issued
-- below, unchanged except for the search_path and the qualification. The remaining 0015/0016 helpers
-- (can_see_person, can_admin_employment, can_see_employment, company_subtree) have the same defect and
-- are a follow-up: nothing this migration guarantees routes through them.
--
-- WHAT IS DELIBERATELY *NOT* CHECKED AT CONSUME (a correction to the slice plan)
-- -----------------------------------------------------------------------------
-- The plan called for consume to also refuse "company-scoped rows unless hr_admin". That rule is
-- WRONG and would break a legitimate path: 0295's group branch (`app.is_group_admin()`) permits a
-- group admin to grant ANY customer role at ANY scope, including a company-scoped `manager`. At
-- consume time the session belongs to the INVITEE (or to the definer), so INVITER-CONTEXT conjuncts —
-- `is_group_admin()`, `is_admin_for(company_id)`, `can_admin_person(person_id)` — are not re-evaluable.
-- Consume therefore checks only facts that are properties of the ROW, of the ROWS IT REFERENCES, or of
-- the TARGET LOGIN, never of the inviter: the role is a real customer role, it is not `operator`, a
-- `super_admin` row is group-wide, its company/person live in its own tenant, and the login being
-- rebound is both un-activated AND carries no authority beyond what this invitation grants.
--
-- WHAT AN INVITEE SEES WHEN A GUARD FIRES (deliberate, not an oversight)
-- ---------------------------------------------------------------------
-- The guards RAISE with ERRCODE `insufficient_privilege`. `acceptInvitation` (core/auth.ts:288-295)
-- converts only an EMPTY result set into InvalidInvitationError, so a RAISE propagates and
-- app/invite/[token]/activate/page.tsx:79 rethrows it into the generic error boundary — the invitee
-- gets a 500, not the friendly "this invitation is no longer valid" page. That is the wanted outcome:
-- every row that can reach a guard is either an attack artifact or a pre-migration relic, and neither
-- should be presented to the holder as a merely-stale link. A loud, logged failure is the signal.
--
-- That claim only holds if the guards have NO false positives, because a false positive is a 500 shown
-- to an innocent invitee. Two existed and both are fixed below:
--
--   • Re-inviting a person who already has an activated login, accepted from that SAME WorkOS subject,
--     is reachable straight from the shipped UI (app/admin/users/page.tsx's person dropdown does not
--     filter people who already hold a login) and the "rebind" it performs is a literal no-op. Guard B
--     therefore runs only when the subject actually CHANGES.
--   • Guard B(ii) was written as a SUBSET rule and implemented as strict tuple EQUALITY, which refused a
--     login carrying a strictly WEAKER grant. That is the shape db/seed.ts actually ships — every
--     `seed:<email>` login carries `employee`/`manager` group-wide (:264-268, :493-499) — while
--     scripts/auth/bootstrap-invite.ts, whose documented job is to rebind exactly those logins, defaults
--     to `--role hr_admin`. So four of the five seeded logins were permanently un-activatable. The rule
--     is now expressed against AUTHORITY (app.invitation_confers below), not against tuple identity.
--
-- ONE FALSE POSITIVE IS KEPT DELIBERATELY, and it has no in-app recovery: a person whose login is
-- ACTIVATED and who must move to a DIFFERENT WorkOS subject (email change, re-hire, lost account) can no
-- longer be re-bound by invitation, and the invitee sees the 500. The database cannot tell that case
-- apart from a takeover — both are "somebody holding a token wants this activated login re-pointed at a
-- new subject" — so the refusal is correct and mapping it to the friendly "invitation no longer valid"
-- page would silence the attack alongside the accident. Recovery is deliberately owner-side: reset the
-- login to a placeholder (`UPDATE app_user SET workos_user_id = 'provision:' || gen_random_uuid()`,
-- which layer 5 still permits for the owner) and re-run scripts/auth/bootstrap-invite.ts.
--
-- AND ONE RESIDUAL IS ACCEPTED. Guard B lets a company-scoped hr_admin activate the UN-ACTIVATED login
-- of a person inside its own subtree and thereby become that person for every person_id-keyed policy
-- (their own leave, their bank/payroll details). The invitation's `email` is chosen by the inviter and
-- is not checked against the person's `primary_email`, so this is delivery-address-free. It is bounded
-- by the layer-1 person conjunct (own subtree only) and by Guard B(ii) (no grant beyond the
-- invitation's), and it is the same capability the rebind branch exists to provide, so it is not closed
-- here — but it IS a different capability from "can read that person's HR record", and naming it is the
-- point of this paragraph.

-- ── 0. Make the constraints below VALIDATED-safe on an already-exploited deployment ───────────────
--
-- A plain (validating) ADD CONSTRAINT full-scans the table and ABORTS the migration if any existing
-- row violates it. On a deployment where this very hole was used, an `operator` invitation EXISTS —
-- so the migration that closes the hole would be the one thing that cannot deploy, and drizzle wraps
-- each file in one transaction, so the whole fix would roll back and the watermark would not advance.
--
-- Deleting is the right disposition rather than revoking: a revoked row still carries role='operator'
-- and would still fail validation, and such a row has no legitimate consumer — layer 4 would refuse it
-- anyway. Nothing references app_invitation, so the delete is FK-clean, and the record is NOT lost:
-- every invitation writes an `app-user.invited` domain_event carrying email/role/companyId at creation
-- (core/auth.ts:139-149, db/provision.ts:249-258), which is the audit trail and is untouched here.
--
-- On dev and on the live deployment this deletes zero rows (verified: app_invitation is empty on both
-- at the time of writing). It exists for the install we have not seen.
DELETE FROM app_invitation
 WHERE role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner')
    OR (role = 'super_admin' AND company_id IS NOT NULL);
--> statement-breakpoint

-- ── 1a. app.can_admin_person — "is this person inside MY admin subtree?" ──────────────────────────
--
-- `app.can_see_person` (0001:48-59) is NOT the predicate we need: its first disjunct is the coarse
-- `app.is_admin()` ("an admin somewhere"), so a company-scoped hr_admin passes it for EVERY person in
-- the tenant. This is the scoped sibling, modelled on `app.can_admin_employment` (0016:46-49): a
-- person is administrable iff they hold a CURRENT employment in a company this session administers.
--
-- `terminated_on IS NULL` is deliberate and is where this DIVERGES from can_admin_employment, which
-- carries no such filter. Without it "administrable" would be a HISTORICAL set, not a current one: a
-- company's hr_admin would keep aim over everyone who ever worked there, including people who have
-- since transferred to a sibling company entirely outside its subtree — and aim is exactly what the
-- rebind half of the hole needs. `terminated_on IS NULL` is the repo's standard active-employment
-- predicate (0109:33,46-47,72; 0121:37; 0288:65,70). The divergence is safe in this direction: this
-- function is only ever read as a WITH CHECK conjunct, so a narrower answer can only REFUSE writes,
-- never permit one.
--
-- SECURITY DEFINER for the same reason 0016's helpers are: `employment` carries its own RLS, and a
-- policy expression that read it directly would be filtered by that policy rather than answering the
-- question. search_path names pg_temp LAST and the relation is schema-qualified — see this file's
-- header: `SET search_path = public` alone leaves pg_temp searched first, so a caller-created
-- `CREATE TEMP TABLE employment(...)` would choose this function's answer.
CREATE OR REPLACE FUNCTION app.can_admin_person(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employment e
    WHERE e.person_id = p_person
      AND e.tenant_id = app.current_tenant_id()
      AND e.terminated_on IS NULL
      AND app.is_admin_for(e.company_id)
  );
$$;
--> statement-breakpoint
-- CREATE OR REPLACE leaves EXECUTE with PUBLIC by default, and a definer helper that takes a
-- caller-supplied argument should not be callable by anyone the policy does not need. The explicit
-- grant below is sufficient: a policy expression evaluates as the QUERYING role, not as PUBLIC.
REVOKE EXECUTE ON FUNCTION app.can_admin_person(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_admin_person(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 1a′. app.invitation_refs_in_tenant — the row's two FK payloads belong to the row's own tenant ──
--
-- `app_invitation.company_id` and `person_id` are PLAIN FKs to company(id) / person(id) with no tenant
-- composite, and neither branch of the policy below ties them to the row's tenant: the group branch is
-- `app.is_group_admin()` and nothing else, and the delegated branch's `is_admin_for` / `can_admin_person`
-- are session-scoped, not row-scoped. So a group admin of tenant A could write an invitation naming
-- tenant B's person, and consume would build an app_user in tenant A bound to a person in tenant B plus
-- a role_assignment scoped to a company in tenant B. Every downstream policy filters on tenant_id (which
-- comes from the invitation), so nothing LEAKS — but the row is structurally invalid and the identity it
-- creates is a lie. Refusing it is a two-EXISTS conjunct; storing it is a support ticket nobody can read.
--
-- SECURITY DEFINER, same reason as can_admin_person: `company` and `person` both carry RLS, so a policy
-- expression reading them inline would be filtered by THOSE policies and silently answer "no" for a row
-- the session simply cannot see — a false negative on the legitimate path.
CREATE OR REPLACE FUNCTION app.invitation_refs_in_tenant(p_tenant uuid, p_company uuid, p_person uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (p_company IS NULL OR EXISTS (SELECT 1 FROM public.company c WHERE c.id = p_company AND c.tenant_id = p_tenant))
     AND (p_person  IS NULL OR EXISTS (SELECT 1 FROM public.person  p WHERE p.id  = p_person  AND p.tenant_id = p_tenant));
$$;
--> statement-breakpoint
-- Unlike every other definer helper in this repo this one takes a caller-supplied tenant rather than
-- reading the session's, so left with PUBLIC's default EXECUTE it is a cross-tenant oracle for anyone
-- holding two UUIDs. Narrow it to the one role whose policies call it.
REVOKE EXECUTE ON FUNCTION app.invitation_refs_in_tenant(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.invitation_refs_in_tenant(uuid, uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 1a″. Re-issue the two 0015/0016 helpers can_admin_person answers THROUGH ──────────────────────
--
-- Bodies verbatim from 0015:5-12 and 0016:18-24; the ONLY changes are the pinned search_path and the
-- schema-qualified `company`. Without this, `CREATE TEMP TABLE company (id uuid, parent_company_id uuid)`
-- in an ai_hr_app session makes `app.is_company_descendant` answer from the attacker's own rows, which
-- makes `app.has_role_for` → `app.is_admin_for` → `app.can_admin_person` answer true for ANY person —
-- i.e. layer 1's person conjunct, the fix for hole (3), would be bypassable by the very role it binds.
--
-- Re-issued rather than left to a follow-up because this migration's guarantee DEPENDS on them; the
-- other 0015/0016 helpers with the same defect are named in this file's header and are a follow-up.
CREATE OR REPLACE FUNCTION app.is_company_descendant(child uuid, ancestor uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_company_id FROM public.company WHERE id = child
    UNION ALL
    SELECT c.id, c.parent_company_id FROM public.company c JOIN up ON c.id = up.parent_company_id
  )
  SELECT EXISTS (SELECT 1 FROM up WHERE id = ancestor);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.has_role_for(p_role text, p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.current_grants() g
    WHERE g.role = p_role
      AND (g.company_id IS NULL OR g.company_id = p_company OR app.is_company_descendant(p_company, g.company_id))
  );
$$;
--> statement-breakpoint

-- ── 1a‴. app.acting_as_owner — "is this a migration/definer, or a live application session?" ──────
--
-- The two triggers below have to distinguish app.consume_invitation (SECURITY DEFINER, so current_user
-- is the schema owner while it runs) and owner-side scripts from an ordinary ai_hr_app session. A
-- transaction-local GUC would NOT do: any session may set_config() a custom GUC, so the attacker sets
-- the flag itself. Role membership cannot be forged.
--
-- The owner is read off app_user's own catalog entry rather than hardcoded, because the role that owns
-- the schema differs by environment — `ai_hr_owner` on a deployment (deploy/bootstrap-db.sql), the
-- superuser in dev and in the test template (TEST_MIGRATION_DATABASE_URL). 'public.app_user' is fully
-- qualified: with pg_temp in the path a bare 'app_user'::regclass could resolve to a temp table.
--
-- Gating on the OWNER (not on "not ai_hr_app") is the honest boundary: anyone holding owner credentials
-- can drop the trigger anyway, so binding them buys nothing. The boundary being defended is ai_hr_app.
CREATE OR REPLACE FUNCTION app.acting_as_owner() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_catalog.pg_has_role(
           current_user,
           (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.app_user'::regclass),
           'USAGE');
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.acting_as_owner() TO ai_hr_app;
--> statement-breakpoint

-- ── 1b. The seam enforces role_assignment_write's matrix (0295:66-82), plus scope and person ──────
--
-- `app_invitation.role` is TEXT (db/schema.ts), not the `role` enum, so these are plain text
-- comparisons — 0295's "never cast a literal to ::role" discipline is satisfied trivially here.
--
-- CONJUNCT BY CONJUNCT:
--   • `role <> 'operator'` — redundant against layer 2's CHECK constraint and kept anyway, mirroring
--     0295's explicit style: the two layers are independently reviewable, and a future edit that
--     relaxes the constraint must not silently reopen the policy. test/invitation-privesc.test.ts
--     drops the constraint inside the operator RLS tests so this conjunct is what they actually pin.
--   • `role <> 'super_admin' OR company_id IS NULL` — mirrors 0020's role_assignment_super_admin_
--     group_wide. Without it the seam happily accepts a company-scoped super_admin invitation that
--     can NEVER be consumed: consume dies at the final role_assignment INSERT on that constraint
--     (SQLSTATE 23514), the invitee gets a 500, and the row sits pending forever. The admin UI reaches
--     this combination directly — app/admin/users/page.tsx offers super_admin in the role select and
--     an INDEPENDENT company scope select, and core/auth.ts inviteUser passes companyId straight
--     through — so it is a live dead-invite bug, not a theoretical one.
--   • `app.invitation_refs_in_tenant(tenant_id, company_id, person_id)` — outside the branch split, so
--     it binds a group admin too. See 1a′ above.
--   • `person_id IS NULL OR app.can_admin_person(person_id)` on the DELEGATED branch only — the fix
--     for hole (3). A company-scoped hr_admin may only aim an invitation at a person it actually
--     administers, so it can no longer name the group super_admin (or anyone outside its subtree) and
--     have the rebind hand over that identity. The GROUP branch deliberately keeps no person conjunct:
--     a group admin already holds every customer power in the tenant, so restricting WHO it may invite
--     buys nothing — and layer 4 still refuses to rebind an activated login (or one carrying grants
--     this invitation does not itself confer) even for a group admin.
--
-- USING is left as scope-only, matching the pre-existing policy — and it is worth being accurate about
-- what that means: reads are TENANT-WIDE, not admin-only. Any tenant member with a session can SELECT
-- every invitation row (email, role, person_id, token_hash). That is unchanged by this migration and
-- bounded on purpose: token_hash is a sha256 of a 32-byte random token, so it is not a usable
-- credential, and the WRITE path — which is where the escalation lived — is what is tightened here.
--
-- A scope-only USING also means an UPDATE may pick up ANY row in the tenant, not only the writer's own.
-- The WITH CHECK constrains the RESULTING row, so a walk-up (role, company, person) is refused — but a
-- WITH CHECK cannot see the transition, so `status`/`expires_at`/`token_hash` needed the trigger in
-- layer 3 rather than another conjunct here.
DROP POLICY app_invitation_rls ON app_invitation;
--> statement-breakpoint
CREATE POLICY app_invitation_rls ON app_invitation FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND app.invitation_refs_in_tenant(tenant_id, company_id, person_id)
    AND role <> 'operator'
    AND (role <> 'super_admin' OR company_id IS NULL)
    AND (
      app.is_group_admin()
      OR (
        role = 'hr_admin'
        AND company_id IS NOT NULL
        AND app.is_admin_for(company_id)
        AND (person_id IS NULL OR app.can_admin_person(person_id))
      )
    )
  );
--> statement-breakpoint

-- ── 2. Table constraints — these bind ai_hr_owner too ─────────────────────────────────────────────
--
-- The enum's labels are employee, manager, hr_admin, super_admin, payroll_partner,
-- performance_comp_partner, operator. Everything except `operator` is invitable. Listing them as
-- text literals (rather than casting the column to ::role) keeps this constraint independent of the
-- enum's evolution: adding a label to `role` does NOT silently make it invitable — a later migration
-- has to say so here, which is the reviewable outcome. The same six literals appear in
-- `core/auth.ts` ROLES and in the consume guard below; test/invitation-privesc.test.ts reads this
-- constraint out of pg_constraint and asserts set-equality with the exported ROLES, so the three
-- copies cannot drift apart silently.
--
-- This also rejects garbage: `role` is a free TEXT column, so 'root' or '' were previously storable
-- and would have reached `v_inv.role::public.role` at consume as a runtime cast error rather than a policy
-- decision.
ALTER TABLE app_invitation
  ADD CONSTRAINT app_invitation_role_customer_set
  CHECK (role IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner'));
--> statement-breakpoint
-- The table-level mirror of 0020's role_assignment_super_admin_group_wide. role_assignment already
-- refuses a company-scoped super_admin; without this, the INVITATION for one was still writable by
-- anything that bypasses RLS (a script, a seed, ai_hr_owner) and only failed at the invitee's click.
ALTER TABLE app_invitation
  ADD CONSTRAINT app_invitation_super_admin_group_wide
  CHECK (role <> 'super_admin' OR company_id IS NULL);
--> statement-breakpoint

-- ── 2b. Re-issue the REVOKE the lifecycle trigger below silently depends on ───────────────────────
--
-- The trigger in layer 3 is BEFORE UPDATE only, so DELETE-then-INSERT would reinstate any consumed or
-- revoked invitation under the same token_hash with a fresh expiry — defeating exactly the single-use,
-- expiry and revoke guarantees layer 3 exists to provide. The only thing making that unreachable from a
-- session is `REVOKE DELETE, TRUNCATE ON app_invitation FROM ai_hr_app` in 0151:57, while
-- deploy/bootstrap-db.sql:51-52 makes the DEFAULT posture the unsafe one
-- (`ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE`). 0295's own header records why
-- that is dangerous to leave implicit: "cleanroom-verify.sh reproduces that same ALTER DEFAULT
-- PRIVILEGES, so the cleanroom MASKS a missing GRANT and can NEVER catch a missing REVOKE."
--
-- Re-issuing it is idempotent and puts the guarantee and its precondition in the same file.
-- test/invitation-privesc.test.ts reads ai_hr_app's grant set out of information_schema and asserts it
-- is exactly SELECT/INSERT/UPDATE, so a future ALTER DEFAULT PRIVILEGES change cannot restore DELETE
-- unnoticed.
REVOKE DELETE, TRUNCATE ON app_invitation FROM ai_hr_app;
--> statement-breakpoint

-- ── 3. An issued invitation is immutable except for its status, and its status is one-way ─────────
--
-- Fact (4) in this file's header. `ai_hr_app` holds UPDATE on all twelve columns (0151:44) and the
-- policy's USING is tenant-wide, so before this trigger any principal that could satisfy the WITH CHECK
-- for the resulting row could take SOMEBODY ELSE'S terminal invitation and re-arm it:
--
--     UPDATE app_invitation
--        SET status = 'pending', accepted_at = NULL, expires_at = now() + interval '30 days',
--            token_hash = <a hash of a token I chose>
--      WHERE id = <a revoked or already-accepted row>;
--
-- which defeats single-use, expiry and revokeInvitation at once, and mints a working token out of a
-- row the attacker never had to create. A WITH CHECK conjunct cannot express this: a policy sees only
-- the NEW row, so "did this status go backwards" is not a question it can ask. A BEFORE UPDATE trigger
-- is the mechanism — the same one 0011 uses for closed-payroll immutability, and unlike a policy it
-- also binds ai_hr_owner, seeds and scripts.
--
-- THE WHITELIST IS TIGHT ON PURPOSE. Exactly three writers ever UPDATE this table, and all three touch
-- only status (+ accepted_at): app.consume_invitation's single-use claim (pending → accepted),
-- core/auth.ts revokeInvitation (pending → revoked), and scripts/provision-runner.ts's re-issue, which
-- revokes the stale pending row before minting a fresh one (:249-256). Nothing legitimately edits an
-- invitation's role, scope, target, token or expiry after issue — re-issuing is an INSERT. So the rule
-- is "only status and accepted_at may change", which subsumes the role/company/person walk-up the
-- policy already refuses and makes the token itself immutable.
--
-- AND THE TRANSITION IS ROLE-AWARE. `accepted` is a state only app.consume_invitation should ever write
-- — it is the definer's single-use claim — while the app's own transition is pending → revoked
-- (core/auth.ts revokeInvitation, scripts/provision-runner.ts:247-256). The policy's USING is
-- tenant-wide, so without this an admin could reach ANY pending invitation in the tenant and flip it
-- straight to `accepted`: the activation link for a provisioned tenant admin (db/provision.ts
-- mintActivationInvitation) dies silently, the row reads as accepted although no login was ever created,
-- and the terminal state then blocks any legitimate revoke. Restricting a SESSION to `revoked` also
-- makes the trigger mirror core/auth.ts's own rule — assertGroupAdmin + the audit event — for revocation,
-- which the raw statement otherwise skipped entirely.
CREATE OR REPLACE FUNCTION app.guard_invitation_lifecycle() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.email, NEW.role, NEW.person_id,
      NEW.token_hash, NEW.expires_at, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.company_id, OLD.email, OLD.role, OLD.person_id,
      OLD.token_hash, OLD.expires_at, OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'invitation % is immutable once issued: only status may change (token_hash, expires_at, role, company_id, person_id, email and tenant_id are fixed)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- One-way lifecycle. `accepted`, `revoked` and `expired` are terminal; only a pending invitation has
  -- a next state. Re-arming is the whole attack, so the refusal names the transition it stopped.
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invitation % is % and its lifecycle is one-way: it cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A live session may only REVOKE. `accepted` belongs to app.consume_invitation, which runs as the
  -- owner (SECURITY DEFINER) and therefore passes app.acting_as_owner(). The group-admin conjunct
  -- mirrors core/auth.ts revokeInvitation's assertGroupAdmin, so a delegated company admin can no
  -- longer silently kill an invitation it did not create and could not have written.
  IF NOT app.acting_as_owner() AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status <> 'revoked' THEN
      RAISE EXCEPTION 'invitation % may only be revoked from a session: % is written by app.consume_invitation alone', OLD.id, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app.is_group_admin() THEN
      RAISE EXCEPTION 'invitation % may only be revoked by a group administrator', OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER app_invitation_lifecycle_guard
  BEFORE UPDATE ON app_invitation
  FOR EACH ROW EXECUTE FUNCTION app.guard_invitation_lifecycle();
--> statement-breakpoint

-- ── 4a. app.is_placeholder_subject — has this login ever been activated? ──────────────────────────
--
-- The REBIND branch of consume_invitation exists for exactly ONE purpose: activating a login that was
-- created ahead of its human. Every such login carries a PLACEHOLDER subject — a value no WorkOS user
-- has ever authenticated as — and the repo has always named them in exactly three shapes:
--
--   • `provision:<uuid>` — db/provision.ts:186 (operator-provisioned tenant admin; its own comment
--     calls this "a UUID-based placeholder … NEVER derived from the email")
--   • `seed:<email>`     — db/seed.ts:264,495 (demo data)
--   • `user_dev_admin`   — db/seed.ts:166 (the pinned demo admin the dev switcher resolves)
--
-- 0151's header (line 9) already names the set as "Seed placeholders ('user_dev_admin', 'seed:<email>')"
-- and scripts/auth/bootstrap-invite.ts:10 repeats it. This function makes that convention a predicate
-- instead of a comment, which is what the guard below needs.
--
-- IMMUTABLE: pure text inspection of its argument, no catalog or session access.
CREATE OR REPLACE FUNCTION app.is_placeholder_subject(p_subject text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT p_subject LIKE 'provision:%' OR p_subject LIKE 'seed:%' OR p_subject = 'user_dev_admin';
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.is_placeholder_subject(text) TO ai_hr_app;
--> statement-breakpoint

-- ── 4a′. app.customer_role_rank / app.invitation_confers — "is this grant WITHIN the invitation?" ──
--
-- Guard B(ii) needs to answer whether a grant already sitting on the target login is authority the
-- invitation itself confers. Comparing the (role, company_id) TUPLES is the wrong question and was the
-- first implementation's bug: an `employee` grant on a login being invited as `hr_admin` confers nothing
-- extra, yet tuple equality refused it — and that is the shape db/seed.ts ships for every seeded login
-- (`seed:<email>` + employee/manager, group-wide), which scripts/auth/bootstrap-invite.ts then rebinds
-- at its default `--role hr_admin`. Four of the five seeded logins were un-activatable. See the header.
--
-- The ordering is over AUTHORITY, and only the four hierarchical roles have one:
--   employee < manager < hr_admin < super_admin
-- `payroll_partner` and `performance_comp_partner` sit BESIDE that ladder, not on it — a partner grant
-- is functional access to payroll / performance data that an hr_admin invitation does not imply — so
-- they get a NULL rank and are conferred only by an invitation for that same role. The role enum's own
-- label order is NOT usable here: it puts the partners after super_admin, which would silently rank them
-- as the most powerful roles in the system.
--
-- The COALESCEs are load-bearing. `p_inv_company = p_grant_company` is NULL when the grant is group-wide
-- and the invitation is company-scoped, and a NULL verdict would make the caller's `IF NOT …` fall
-- through and PERMIT the rebind — the exact escalation this guard exists to refuse. Default false: an
-- unanswerable comparison means "not conferred".
CREATE OR REPLACE FUNCTION app.customer_role_rank(p_role text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role
           WHEN 'employee'    THEN 1
           WHEN 'manager'     THEN 2
           WHEN 'hr_admin'    THEN 3
           WHEN 'super_admin' THEN 4
         END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.customer_role_rank(text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.invitation_confers(
  p_inv_role text, p_inv_company uuid, p_grant_role text, p_grant_company uuid
) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    -- SCOPE: a group-wide invitation (company_id NULL) covers every scope; a company-scoped one covers
    -- only that same company. A group-wide GRANT is therefore never conferred by a scoped invitation,
    -- which is what keeps "company admin inherits a group-wide grant" refused.
    (p_inv_company IS NULL OR p_inv_company = p_grant_company)
    -- ROLE: identical, or strictly weaker on the hierarchical ladder.
    AND (
      p_grant_role = p_inv_role
      OR COALESCE(app.customer_role_rank(p_inv_role) >= app.customer_role_rank(p_grant_role), false)
    ),
    false);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.invitation_confers(text, uuid, text, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 4b. consume_invitation: re-validation before the grant is written ─────────────────────────────
--
-- Unchanged from 0281 except for the guard blocks marked below (A on the row, B on the rebind). The
-- function stays SECURITY DEFINER (it must create the app_user and the grant for a caller who has no
-- session yet) — which is exactly why it has to police its own input.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  public.app_invitation%ROWTYPE;
  v_user_id uuid;
  v_bound_subject text;
  v_logins int;
BEGIN
  -- Atomic single-use claim: only a still-pending, unexpired invitation flips to accepted; a concurrent
  -- second consume of the same token affects 0 rows and drops through to the NOT FOUND branch.
  UPDATE public.app_invitation
     SET status = 'accepted', accepted_at = now()
   WHERE token_hash = v_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RETURN; -- unknown / already-consumed / expired token → 0 rows (caller throws InvalidInvitation)
  END IF;

  -- ── SLICE-0 GUARD A: the row's own shape ───────────────────────────────────────────────────────
  -- The last line of defence for a row that predates the WITH CHECK and the CHECK constraints above.
  -- ROW facts only (see this file's header for why inviter-context conjuncts cannot be re-checked
  -- here). Every RAISE aborts the transaction, so the `status = 'accepted'` flip above is rolled back
  -- too — a refused invitation is left pending rather than silently burned, and the refusal is
  -- visible in the log instead of manifesting as a mysterious missing grant.
  IF v_inv.role = 'operator' THEN
    RAISE EXCEPTION 'invitation refused: the operator role is not grantable by invitation (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_inv.role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner') THEN
    RAISE EXCEPTION 'invitation refused: % is not a valid customer role (invitation %)', v_inv.role, v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Mirrors 0020's role_assignment_super_admin_group_wide. Without this the row would still be refused
  -- — but 40 lines later, by that constraint, as an opaque 23514 from inside a definer function.
  IF v_inv.role = 'super_admin' AND v_inv.company_id IS NOT NULL THEN
    RAISE EXCEPTION 'invitation refused: super_admin is group-wide only, it cannot be scoped to a company (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The FK payloads must live in the invitation's own tenant (see 1a′). Still a pure ROW fact — it is a
  -- property of the rows this row points at, not of anybody's session — so it belongs in guard A.
  IF NOT app.invitation_refs_in_tenant(v_inv.tenant_id, v_inv.company_id, v_inv.person_id) THEN
    RAISE EXCEPTION 'invitation refused: it names a company or person outside its own tenant (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Create or link the app_user for this subject. If a person was targeted and already has an app_user,
  -- attach the subject to it; otherwise insert a new one. workos_user_id is globally unique, so a subject
  -- already bound to another user makes this fail loudly (correct: one subject = one user).
  --
  -- WHICH LOGIN, EXACTLY. Nothing enforces one app_user per person — there is no unique index on
  -- (tenant_id, person_id) — and app_user's policy lets any group admin INSERT more. The original
  -- `LIMIT 1` with no ORDER BY therefore let an arbitrary row decide guard B's whole verdict
  -- (placeholder-or-not, grants-or-not), and a planted grant-less `seed:` twin could be made to win it.
  -- Two logins for one person is a state nobody should silently pick a winner in, so it is refused
  -- outright; the ORDER BY makes the single-row case deterministic rather than plan-dependent.
  IF v_inv.person_id IS NOT NULL THEN
    SELECT count(*) INTO v_logins
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id;
    IF v_logins > 1 THEN
      RAISE EXCEPTION 'invitation refused: that person has % logins, so there is no single login to activate (invitation %)', v_logins, v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Aliased (u.) — an unqualified tenant_id here collides with the RETURNS TABLE OUT parameter.
    SELECT u.id, u.workos_user_id INTO v_user_id, v_bound_subject
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id
     ORDER BY u.created_at, u.id
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.app_user (tenant_id, workos_user_id, person_id)
    VALUES (v_inv.tenant_id, p_subject, v_inv.person_id)
    RETURNING id INTO v_user_id;
  ELSIF v_bound_subject IS DISTINCT FROM p_subject THEN
    -- ── SLICE-0 GUARD B: the rebind is an ACTIVATION, never a takeover ───────────────────────────
    -- This branch re-points an existing login at whoever is holding the token. That is legitimate for
    -- a login created ahead of its human (provisioning, seed, bootstrap-invite) and it is an identity
    -- theft for any other. It is what closes hole (3) for EVERY inviter, including a group admin and
    -- including a row forged before layer 1 existed — the person-scope conjunct in the WITH CHECK
    -- narrows who can aim at whom, this decides whether the shot lands at all.
    --
    -- The ELSIF is the no-false-positive half: when the bound subject IS the accepter's, the UPDATE
    -- below would set the column to the value it already holds. Nothing is taken over, so nothing is
    -- refused — re-inviting an existing user (to add a second grant) is a live UI path and it worked
    -- before this migration. See this file's header.
    --
    -- TWO questions have to be asked, because "activated" and "carries authority" are NOT the same
    -- question and only the second one is about privilege:
    IF NOT app.is_placeholder_subject(v_bound_subject) THEN
      -- (i) IDENTITY. A non-placeholder subject means a real human has authenticated as this login;
      -- re-pointing it steals their identity and locks them out (their old subject then resolves to
      -- no row at all).
      RAISE EXCEPTION 'invitation refused: that person already has an activated login, which an invitation may not re-bind (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.role_assignment ra
       WHERE ra.app_user_id = v_user_id
         AND NOT app.invitation_confers(v_inv.role, v_inv.company_id, ra.role::text, ra.company_id)
    ) THEN
      -- (ii) AUTHORITY, and this is the one a placeholder check alone gets WRONG. The grants are
      -- attached to the app_user BEFORE anyone authenticates as it, so "nobody has logged in yet"
      -- does not mean "there is nothing to steal": db/seed.ts:167 and test/operator-provision.test.ts
      -- both build `provision:<uuid>`/`user_dev_admin` logins that already carry a group-wide hr_admin.
      -- Without this conjunct a company-scoped hr_admin could write a wholly LEGITIMATE-looking
      -- invitation (role hr_admin, its own company, a person it administers — every layer-1 conjunct
      -- satisfied), consume it from a fresh subject, land on that pending admin's login and inherit
      -- its group-wide grant.
      --
      -- SUBSET, NOT EQUALITY — see app.invitation_confers above. The rebind is refused only when the
      -- login carries authority this invitation does not itself confer, which is a question about the
      -- ROLE LADDER and the SCOPE, not about tuple identity. "No grants at all" was rejected because it
      -- breaks scripts/auth/bootstrap-invite.ts, whose entire job is to rebind a SEEDED placeholder, and
      -- seeded placeholders carry grants (db/seed.ts:167 withRoleAssignment: true, :262-268, :493-499).
      -- Tuple EQUALITY was the same mistake one step smaller: it refused a login whose only grant was
      -- strictly weaker than the invitation's, which is precisely what those seeded logins carry.
      -- Anything the invitation confers, layer 1 already proved the inviter was allowed to write.
      RAISE EXCEPTION 'invitation refused: that login already carries a grant this invitation does not confer, so re-binding it would hand the accepter authority the inviter never had (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.app_user SET workos_user_id = p_subject WHERE id = v_user_id;
  END IF;

  INSERT INTO public.role_assignment (tenant_id, app_user_id, company_id, role)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.company_id, v_inv.role::public.role);

  RETURN QUERY SELECT v_user_id, v_inv.tenant_id;
END;
$$;
--> statement-breakpoint

-- ── 5. The identity itself: only the owner may re-point a login ───────────────────────────────────
--
-- Fact (5) in this file's header, and the reason layers 1 and 4 are not sufficient on their own.
-- app_user's policy (0016:191-193) is `WITH CHECK (tenant_id = … AND app.is_group_admin())` and
-- ai_hr_app holds table-level UPDATE, so before this trigger
--
--     UPDATE app_user SET workos_user_id = '<my second WorkOS account>' WHERE id = <the operator login>;
--
-- was a one-statement identity takeover for any group admin — no invitation, no token, no guard. It
-- reaches the `operator` login too, because app_user.tenant_id is NOT NULL so the operator's login
-- necessarily lives in some tenant (db/seed.ts puts it in the same one as the customer admins).
--
-- The rule is blunt on purpose: NO session may change workos_user_id, at all. That is affordable
-- because nothing in the TypeScript ever writes the column — core/, app/ and lib/ only read it, and the
-- three writers are db/seed.ts and db/provision.ts (INSERT, owner-side) and app.consume_invitation's
-- rebind (SECURITY DEFINER, so current_user is the owner while it runs). A subset check mirroring
-- Guard B was considered and rejected: it would put the rebind policy in two places that must agree
-- forever, whereas "route every rebind through consume_invitation" leaves exactly one.
--
-- INSERT is untouched — creating a login is what the group-admin WITH CHECK is legitimately for. Only
-- re-pointing an EXISTING one is a takeover.
CREATE OR REPLACE FUNCTION app.guard_app_user_subject() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.workos_user_id IS DISTINCT FROM OLD.workos_user_id AND NOT app.acting_as_owner() THEN
    RAISE EXCEPTION 'login % cannot be re-pointed at another subject from a session: identity rebinding goes through app.consume_invitation', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER app_user_subject_guard
  BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION app.guard_app_user_subject();
