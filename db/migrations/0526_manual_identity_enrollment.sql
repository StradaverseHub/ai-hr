-- Credential values belong only to Keycloak. This table is the durable enrollment intent,
-- not a second user directory, and contains no password, invitation token or provider token.
CREATE TABLE app_manual_identity_enrollment (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id),
 person_id uuid NOT NULL REFERENCES person(id), created_by uuid NOT NULL REFERENCES app_user(id),
 issuer text NOT NULL, username text NOT NULL, email text NOT NULL,
 role text NOT NULL CHECK (role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner')),
 company_id uuid REFERENCES company(id),
 status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','prepared','linked','active','cancelled')),
 subject text, app_user_id uuid REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status='reserved' AND subject IS NULL AND app_user_id IS NULL)
     OR (status='prepared' AND subject IS NOT NULL AND app_user_id IS NULL)
     OR (status='cancelled' AND app_user_id IS NULL)
     OR (status IN ('linked','active') AND subject IS NOT NULL AND app_user_id IS NOT NULL)),
 CHECK (role <> 'super_admin' OR company_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX manual_identity_person_uq ON app_manual_identity_enrollment(tenant_id,person_id) WHERE status <> 'cancelled';
--> statement-breakpoint
CREATE UNIQUE INDEX manual_identity_username_uq ON app_manual_identity_enrollment(issuer,lower(username)) WHERE status <> 'cancelled';
--> statement-breakpoint
ALTER TABLE app_manual_identity_enrollment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app_manual_identity_enrollment FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Read live grants and the actor's enrolled identity, rather than trusting stale role claims.
CREATE FUNCTION app.manual_identity_authorized(p_issuer text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u
 JOIN public.app_external_identity i ON i.app_user_id=u.id
 JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
 AND i.issuer=p_issuer AND i.revoked_at IS NULL AND NOT app.login_blocked(u.id)
 AND (r.role='super_admin' OR (r.role='hr_admin' AND r.company_id IS NULL)));
$$;
--> statement-breakpoint
-- Person locks are shared with both invitation consumers below. Existing real identities,
-- revoked identities, ambiguous logins and archived/terminated accounts cannot be replaced.
CREATE FUNCTION app.manual_identity_target(p_person uuid,p_role text,p_company uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_user public.app_user%ROWTYPE; v_count int;
BEGIN
 PERFORM 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.invitation_refs_in_tenant(app.current_tenant_id(),p_company,p_person)
 OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
   AND e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on) >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN
  RAISE EXCEPTION 'manual_identity_target' USING ERRCODE='insufficient_privilege';
 END IF;
 SELECT count(*) INTO v_count FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.person_id=p_person;
 IF v_count>1 THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 SELECT * INTO v_user FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.person_id=p_person FOR UPDATE;
 IF FOUND AND (NOT app.is_placeholder_subject(v_user.workos_user_id) OR app.login_blocked(v_user.id)
 OR EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.app_user_id=v_user.id)
 OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=v_user.id
   AND NOT app.invitation_confers(p_role,p_company,r.role::text,r.company_id))) THEN
  RAISE EXCEPTION 'manual_identity_conflict' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN v_user.id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_reserve(p_id uuid,p_issuer text,p_person uuid,p_username text,p_email text,p_role text,p_company uuid)
RETURNS SETOF public.app_manual_identity_enrollment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE;
BEGIN
 IF NOT app.manual_identity_authorized(p_issuer) THEN RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-enrollment:'||p_id::text,0));
 SELECT * INTO v FROM public.app_manual_identity_enrollment e WHERE e.id=p_id FOR UPDATE;
 IF FOUND THEN
  IF (v.tenant_id,v.issuer,v.person_id,v.username,v.email,v.role,v.company_id)
   IS DISTINCT FROM (app.current_tenant_id(),p_issuer,p_person,p_username,p_email,p_role,p_company)
   OR v.status='cancelled' THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
  RETURN NEXT v; RETURN;
 END IF;
 IF p_username !~ '^[a-z0-9][a-z0-9._@+-]{2,63}$' OR p_username LIKE 'service-account-%'
 OR length(p_email)>255 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
 OR p_email<>lower(p_email) OR p_role NOT IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner')
 OR (p_role='super_admin' AND p_company IS NOT NULL) THEN RAISE EXCEPTION 'manual_identity_invalid'; END IF;
 PERFORM app.manual_identity_target(p_person,p_role,p_company);
 INSERT INTO public.app_manual_identity_enrollment(id,tenant_id,person_id,created_by,issuer,username,email,role,company_id)
 VALUES(p_id,app.current_tenant_id(),p_person,app.current_user_id(),p_issuer,p_username,p_email,p_role,p_company) RETURNING * INTO v;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v.id,'app-user.manual-enrollment-requested','user',app.current_user_id(),
  jsonb_build_object('personId',v.person_id,'role',v.role,'companyId',v.company_id,'ownershipAttested',true));
 RETURN NEXT v;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_read(p_id uuid,p_lock boolean DEFAULT false)
RETURNS SETOF public.app_manual_identity_enrollment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE;
BEGIN
 SELECT * INTO v FROM public.app_manual_identity_enrollment e
 WHERE e.id=p_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.manual_identity_authorized(v.issuer) THEN RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege'; END IF;
 IF p_lock THEN
  SELECT * INTO v FROM public.app_manual_identity_enrollment e WHERE e.id=p_id FOR UPDATE;
  IF v.status='linked' THEN
   PERFORM 1 FROM public.app_user u WHERE u.id=v.app_user_id FOR UPDATE;
   IF app.login_blocked(v.app_user_id) OR NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=v.issuer AND i.subject=v.subject AND i.app_user_id=v.app_user_id AND i.revoked_at IS NULL) THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
  END IF;
 END IF;
 RETURN NEXT v;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_list(p_issuer text)
RETURNS SETOF public.app_manual_identity_enrollment
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.manual_identity_authorized(p_issuer) THEN RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege'; END IF;
 RETURN QUERY SELECT * FROM public.app_manual_identity_enrollment e
 WHERE e.tenant_id=app.current_tenant_id() AND e.issuer=p_issuer AND e.status IN ('reserved','prepared','linked') ORDER BY e.created_at,e.id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_prepare(p_id uuid,p_subject text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE;
BEGIN
 SELECT * INTO v FROM app.manual_identity_read(p_id,true);
 IF v.status='prepared' AND v.subject=p_subject THEN RETURN; END IF;
 IF v.status<>'reserved' OR p_subject IS NULL OR p_subject !~ '^[a-zA-Z0-9_-]{1,128}$'
 OR EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=v.issuer AND i.subject=p_subject) THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 UPDATE public.app_manual_identity_enrollment SET status='prepared',subject=p_subject WHERE id=p_id;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v.id,'app-user.manual-enrollment-prepared','user',app.current_user_id(),jsonb_build_object('enrollmentId',v.id));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_link(p_id uuid,p_subject text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE; v_user uuid; v_legacy text;
BEGIN
 SELECT * INTO v FROM app.manual_identity_read(p_id,true);
 IF v.status IN ('linked','active') AND v.subject=p_subject THEN RETURN v.app_user_id; END IF;
 IF v.status<>'prepared' OR v.subject IS DISTINCT FROM p_subject OR p_subject IS NULL OR p_subject !~ '^[a-zA-Z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 v_user:=app.manual_identity_target(v.person_id,v.role,v.company_id);
 IF EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=v.issuer AND i.subject=p_subject) THEN
  RAISE EXCEPTION 'manual_identity_conflict';
 END IF;
 v_legacy:='oidc:'||encode(sha256(convert_to(v.issuer||chr(10)||p_subject,'UTF8')),'hex');
 IF v_user IS NULL THEN
  INSERT INTO public.app_user(tenant_id,person_id,workos_user_id) VALUES(v.tenant_id,v.person_id,v_legacy) RETURNING id INTO v_user;
 ELSE UPDATE public.app_user SET workos_user_id=v_legacy WHERE id=v_user; END IF;
 INSERT INTO public.app_external_identity(issuer,subject,app_user_id) VALUES(v.issuer,p_subject,v_user);
 INSERT INTO public.role_assignment(tenant_id,app_user_id,role,company_id)
 SELECT v.tenant_id,v_user,v.role::public.role,v.company_id
 WHERE NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=v.tenant_id
  AND r.app_user_id=v_user AND r.role=v.role::public.role AND r.company_id IS NOT DISTINCT FROM v.company_id);
 UPDATE public.app_manual_identity_enrollment SET status='linked',subject=p_subject,app_user_id=v_user WHERE id=p_id;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v_user,'app-user.manual-enrollment-linked','user',app.current_user_id(),jsonb_build_object('enrollmentId',v.id));
 RETURN v_user;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.manual_identity_finish(p_id uuid,p_cancel boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE;
BEGIN
 SELECT * INTO v FROM app.manual_identity_read(p_id,true);
 IF (p_cancel AND v.status='cancelled') OR (NOT p_cancel AND v.status='active') THEN RETURN; END IF;
 IF (p_cancel AND v.status NOT IN ('reserved','prepared')) OR (NOT p_cancel AND v.status<>'linked') THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 IF NOT p_cancel AND (NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=v.issuer AND i.subject=v.subject AND i.app_user_id=v.app_user_id AND i.revoked_at IS NULL)
   OR app.login_blocked(v.app_user_id)) THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 UPDATE public.app_manual_identity_enrollment SET status=CASE WHEN p_cancel THEN 'cancelled' ELSE 'active' END WHERE id=p_id;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',COALESCE(v.app_user_id,v.id),
  CASE WHEN p_cancel THEN 'app-user.manual-enrollment-cancelled' ELSE 'app-user.manual-enrollment-enabled' END,
  'user',app.current_user_id(),jsonb_build_object('enrollmentId',v.id));
END;
$$;
--> statement-breakpoint
-- Company lifecycle reads only whether retained enrollment history references its own visible company.
CREATE FUNCTION app.manual_identity_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_admin_for(p_company) AND EXISTS(SELECT 1 FROM public.app_manual_identity_enrollment e
 WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=p_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.manual_identity_company_in_use(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.manual_identity_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.manual_identity_authorized(text),app.manual_identity_target(uuid,text,uuid),app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid),app.manual_identity_read(uuid,boolean),app.manual_identity_list(text),app.manual_identity_prepare(uuid,text),app.manual_identity_link(uuid,text),app.manual_identity_finish(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.manual_identity_authorized(text),app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid),app.manual_identity_read(uuid,boolean),app.manual_identity_list(text),app.manual_identity_prepare(uuid,text),app.manual_identity_link(uuid,text),app.manual_identity_finish(uuid,boolean) TO ai_hr_app;

--> statement-breakpoint
-- Shared person locks serialize manual and emailed enrollment without weakening any invitation guard.
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.consume_identity_invitation(p_raw_token text,p_issuer text,p_subject text,p_email text)
RETURNS TABLE(app_user_id uuid,tenant_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_inv public.app_invitation%ROWTYPE;
  v_existing uuid;
  v_legacy text;
  v_result record;
BEGIN
  IF p_issuer IS NULL OR p_issuer='' OR p_subject IS NULL OR p_subject='' OR p_email IS NULL THEN RETURN; END IF;
  SELECT * INTO v_inv FROM public.app_invitation i
    WHERE i.token_hash=encode(sha256(convert_to(p_raw_token,'UTF8')),'hex')
      AND i.status='pending' AND i.expires_at>now() AND lower(i.email)=lower(p_email)
    FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.person p WHERE p.id=v_inv.person_id AND p.tenant_id=v_inv.tenant_id FOR UPDATE;
  SELECT i.app_user_id,u.workos_user_id INTO v_existing,v_legacy
    FROM public.app_external_identity i JOIN public.app_user u ON u.id=i.app_user_id
    WHERE i.issuer=p_issuer AND i.subject=p_subject AND i.revoked_at IS NULL;
  IF v_existing IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=v_existing AND u.tenant_id=v_inv.tenant_id) THEN
    RAISE EXCEPTION 'identity belongs to another tenant' USING ERRCODE='insufficient_privilege';
  END IF;
  IF v_inv.person_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM public.app_user u JOIN public.app_external_identity i ON i.app_user_id=u.id
    WHERE u.tenant_id=v_inv.tenant_id AND u.person_id=v_inv.person_id AND u.id IS DISTINCT FROM v_existing
  ) THEN RAISE EXCEPTION 'invitation cannot replace an enrolled identity' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_existing IS NOT NULL AND (v_inv.person_id IS NULL OR app.login_blocked(v_existing)) THEN
    RAISE EXCEPTION 'existing identity requires its active person-targeted invitation' USING ERRCODE='insufficient_privilege';
  END IF;
  v_legacy:=COALESCE(v_legacy,'oidc:'||encode(sha256(convert_to(p_issuer||chr(10)||p_subject,'UTF8')),'hex'));
  SELECT * INTO v_result FROM app.consume_invitation(p_raw_token,v_legacy);
  IF v_result.app_user_id IS NULL THEN RETURN; END IF;
  IF v_existing IS NOT NULL AND v_existing<>v_result.app_user_id THEN
    RAISE EXCEPTION 'invitation target differs from enrolled identity' USING ERRCODE='insufficient_privilege';
  END IF;
  INSERT INTO public.app_external_identity(issuer,subject,app_user_id)
    VALUES(p_issuer,p_subject,v_result.app_user_id) ON CONFLICT(issuer,subject) DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=p_issuer AND i.subject=p_subject AND i.app_user_id=v_result.app_user_id AND i.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'identity binding conflict' USING ERRCODE='insufficient_privilege';
  END IF;
  RETURN QUERY SELECT v_result.app_user_id::uuid,v_result.tenant_id::uuid;
END;
$$;
