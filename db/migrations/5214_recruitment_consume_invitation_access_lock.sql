-- Recruitment block, after the renumber above main's watermark (5200-5213 apply after 5000).
-- 5201 restates app.consume_invitation from its 0611 body with recruiting_partner in guard A. 5000
-- (access reader/writer core) has since restated the same function with the exclusive Access lock taken
-- before any row lock, and 5201 now applies after 5000, so it would drop that lock. This restates 5000's
-- definition byte-for-byte except guard A's role list, which gains 'recruiting_partner' exactly as in 5201.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
 RETURNS TABLE(app_user_id uuid, tenant_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  public.app_invitation%ROWTYPE;
  v_user_id uuid;
  v_bound_subject text;
  v_logins int;
  v_tenant uuid;
BEGIN
  -- Account creation is an authority change: own the exclusive Access lock before any row lock.
  SELECT i.tenant_id INTO v_tenant FROM public.app_invitation i WHERE i.token_hash = v_hash;
  IF v_tenant IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||v_tenant::text,0));
  END IF;
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
  IF v_inv.role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner', 'performance_partner', 'recruiting_partner') THEN
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
    PERFORM 1 FROM public.person p WHERE p.id=v_inv.person_id AND p.tenant_id=v_inv.tenant_id FOR UPDATE;
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
$function$;
