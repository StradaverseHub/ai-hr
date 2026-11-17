-- Recruitment slice 1 (ADR-0080 D10 new-module pack, ADR-0049 Recruiting Partner): the hiring path skeleton.
--
-- What this installs, and nothing else:
--   1. app.can_admin_recruitment_for(company) := is_admin_for(company) OR has_role_for('recruiting_partner',
--      company). Plain STABLE, mirroring app.can_admin_payroll_for (0099/0603). The label is TEXT here: 4400's
--      ADD VALUE has not committed inside the migrator's single transaction.
--   2. The role allow-lists that must admit the new label so it can be granted, invited, enrolled and
--      revoked (the same owners 0611 §6 extended for performance_partner).
--   3. Nine company-scoped tables. Every one carries tenant_id + company_id, ENABLE + FORCE row security,
--      explicit GRANTs to ai_hr_app and one policy: the current tenant AND can_admin_recruitment_for(company).
--      Hiring managers and interviewers (per-job membership) gain read access in a later slice.
--
-- Installing it seeds nothing: a company's editable default stages, process and archive reasons are written
-- by the pack service (packs/recruitment) the first time an authorized administrator opens Recruitment for
-- that company. A candidate is NOT a person or an employee and nothing here creates either.

-- ── 1. Capability helper ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.can_admin_recruitment_for(p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app.is_admin_for(p_company) OR app.has_role_for('recruiting_partner', p_company);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_admin_recruitment_for(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 2. Role allow-lists (ADR-0049 §5: company-scopable like hr_admin, granted by group admins only) ──────
-- Each owner below is restated from its latest definition (0611 §6) with the role list extended by one
-- label. access_legacy_role_authority keeps the delegated branch at hr_admin → hr_admin only, so a
-- delegated company administrator still cannot mint a partner; only a group administrator can.
-- 0312 layer 2 (latest definition: 0611): the invitable customer set. test/invitation-privesc.test.ts pins it to core/auth.ts ROLES.
ALTER TABLE app_invitation DROP CONSTRAINT app_invitation_role_customer_set;
--> statement-breakpoint
ALTER TABLE app_invitation
  ADD CONSTRAINT app_invitation_role_customer_set
  CHECK (role IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner', 'performance_partner', 'recruiting_partner'));
--> statement-breakpoint
-- 0611 named the manual-enrollment role CHECK, so it is replaced by name.
ALTER TABLE app_manual_identity_enrollment DROP CONSTRAINT app_manual_identity_enrollment_role_check;
--> statement-breakpoint
ALTER TABLE app_manual_identity_enrollment
  ADD CONSTRAINT app_manual_identity_enrollment_role_check
  CHECK (role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner','recruiting_partner'));
--> statement-breakpoint
-- manual_identity_reserve (latest definition: 0611), byte-for-byte except the role list.
CREATE OR REPLACE FUNCTION app.manual_identity_reserve(p_id uuid,p_issuer text,p_person uuid,p_username text,p_email text,p_role text,p_company uuid)
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
 OR p_email<>lower(p_email) OR p_role NOT IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner','recruiting_partner')
 OR (p_role='super_admin' AND p_company IS NOT NULL) THEN RAISE EXCEPTION 'manual_identity_invalid'; END IF;
 PERFORM app.manual_identity_target(p_person,p_role,p_company);
 INSERT INTO public.app_manual_identity_enrollment(id,tenant_id,person_id,created_by,issuer,username,email,role,company_id)
 VALUES(p_id,app.current_tenant_id(),p_person,app.current_user_id(),p_issuer,p_username,p_email,p_role,p_company) RETURNING * INTO v;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v.id,'app-user.manual-enrollment-requested','user',app.current_user_id(),
  jsonb_build_object('personId',v.person_id,'role',v.role,'companyId',v.company_id,'ownershipAttested',true));
 RETURN NEXT v;
END;
$$;
REVOKE ALL ON FUNCTION app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.manual_identity_reserve(uuid,text,uuid,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- consume_invitation (latest definition: 0611), byte-for-byte except guard A's role list.
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
$$;
--> statement-breakpoint
-- access_legacy_role_authority (latest definition: 0611), byte-for-byte except the role list.
-- It is the floor every role_assignment INSERT/UPDATE/DELETE and invitation acceptance re-checks, so
-- without the new label the role could be neither granted nor revoked from a session.
CREATE OR REPLACE FUNCTION app.access_legacy_role_authority(t uuid,u uuid,p_role text,p_company uuid,p_person uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user a JOIN public.role_assignment r ON r.app_user_id=a.id AND r.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND NOT app.login_blocked(a.id) AND NOT app.access_configuration_denied_for(t,u)
   AND (p_role IS NULL OR p_role IN ('employee','manager','hr_admin','super_admin','payroll_partner','performance_comp_partner','performance_partner','recruiting_partner'))
   AND (p_role IS DISTINCT FROM 'super_admin' OR p_company IS NULL)
   AND (r.role::text='super_admin' OR (r.role::text='hr_admin' AND r.company_id IS NULL)
    OR (r.role::text='hr_admin' AND p_role='hr_admin' AND p_company IS NOT NULL
     AND app.access_scope_covers(r.company_id,p_company,t)
     AND (p_person IS NULL OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=t AND e.person_id=p_person
      AND app.access_scope_covers(r.company_id,e.company_id,t)))))
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_legacy_role_authority(uuid,uuid,text,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

-- ── 3. Tables ─────────────────────────────────────────────────────────────────────────────────────────
-- Stage catalogue. Application Review and Onboarding are the system defaults (system_key) and can never be
-- disabled; every other stage can. Disabling a stage leaves applications already in it where they are.
CREATE TABLE public.recruitment_stage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 stage_type text NOT NULL CHECK (stage_type IN ('system_default','screening','interview','offer','test','none')),
 system_key text CHECK (system_key IN ('application_review','onboarding')),
 enabled boolean NOT NULL DEFAULT true,
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_stage_system_ck CHECK (system_key IS NULL OR (enabled AND stage_type = 'system_default')),
 CONSTRAINT recruitment_stage_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_stage_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_stage_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_stage_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_stage_name_uq ON public.recruitment_stage (tenant_id, company_id, lower(btrim(name)));
CREATE UNIQUE INDEX recruitment_stage_seed_uq ON public.recruitment_stage (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
CREATE UNIQUE INDEX recruitment_stage_system_uq ON public.recruitment_stage (tenant_id, company_id, system_key) WHERE system_key IS NOT NULL;
--> statement-breakpoint

-- A named recruitment process. Slice 1 processes apply to every department of their company; a per-department
-- scope is a later slice.
CREATE TABLE public.recruitment_process (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 enabled boolean NOT NULL DEFAULT true,
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_process_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_process_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_process_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_process_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_process_name_uq ON public.recruitment_process (tenant_id, company_id, lower(btrim(name)));
CREATE UNIQUE INDEX recruitment_process_seed_uq ON public.recruitment_process (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
--> statement-breakpoint

-- The ordered stages of a process. Both keys are composite with company_id, so a process can only hold its
-- own company's stages. Parts of their process and stage (ON DELETE CASCADE), which only a company delete
-- removes; the app role has no DELETE on either parent.
CREATE TABLE public.recruitment_process_stage (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 process_id uuid NOT NULL,
 stage_id uuid NOT NULL,
 position integer NOT NULL CHECK (position BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_process_stage_process_fk FOREIGN KEY (process_id, company_id, tenant_id)
  REFERENCES public.recruitment_process(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_process_stage_stage_fk FOREIGN KEY (stage_id, company_id, tenant_id)
  REFERENCES public.recruitment_stage(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_process_stage_position_uq UNIQUE (process_id, position) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT recruitment_process_stage_stage_uq UNIQUE (process_id, stage_id)
);
CREATE INDEX recruitment_process_stage_stage_idx ON public.recruitment_process_stage (stage_id);
--> statement-breakpoint

-- Archive (rejection) reasons: an internal reason, the external reason a candidate may be shown, Default or
-- Custom. Defaults can be hidden, never deleted; custom reasons can be deleted while nothing uses them.
CREATE TABLE public.recruitment_archive_reason (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 internal_reason text NOT NULL CHECK (length(btrim(internal_reason)) BETWEEN 1 AND 200),
 external_reason text NOT NULL CHECK (length(btrim(external_reason)) BETWEEN 1 AND 500),
 kind text NOT NULL CHECK (kind IN ('default','custom')),
 displayed boolean NOT NULL DEFAULT true,
 position integer NOT NULL DEFAULT 1000 CHECK (position BETWEEN 1 AND 10000),
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_archive_reason_seed_ck CHECK ((kind = 'default') = (seed_key IS NOT NULL)),
 CONSTRAINT recruitment_archive_reason_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_archive_reason_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_archive_reason_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_archive_reason_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_archive_reason_seed_uq ON public.recruitment_archive_reason (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
--> statement-breakpoint

-- A job opening (position). job_number is allocated by the guard below, per company, as MJ + 6 digits.
-- position_attribute is fixed at creation; process_id is fixed once the job has an application.
CREATE TABLE public.recruitment_job_opening (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_number text NOT NULL CHECK (job_number ~ '^MJ[0-9]{6}$'),
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 description text CHECK (length(description) <= 20000),
 job_grade_ids uuid[] NOT NULL CHECK (cardinality(job_grade_ids) BETWEEN 1 AND 50),
 work_location text NOT NULL CHECK (length(btrim(work_location)) BETWEEN 1 AND 200),
 recruitment_type text NOT NULL CHECK (recruitment_type IN ('budgeted','unbudgeted','replacement')),
 employment_type text NOT NULL CHECK (employment_type IN ('full_time','part_time','contract','intern')),
 replaced_employment_id uuid,
 business_unit_id uuid,
 department_id uuid REFERENCES public.department(id),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','on_hold','closed')),
 position_attribute text NOT NULL CHECK (position_attribute IN ('regular','evergreen')),
 process_id uuid NOT NULL,
 auto_archive_after_reject boolean NOT NULL DEFAULT false,
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_job_opening_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_job_opening_process_fk FOREIGN KEY (process_id, company_id, tenant_id) REFERENCES public.recruitment_process(id, company_id, tenant_id),
 CONSTRAINT recruitment_job_opening_replaced_fk FOREIGN KEY (replaced_employment_id, tenant_id) REFERENCES public.employment(id, tenant_id),
 CONSTRAINT recruitment_job_opening_business_unit_fk FOREIGN KEY (business_unit_id, tenant_id) REFERENCES public.business_unit(id, tenant_id),
 CONSTRAINT recruitment_job_opening_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_opening_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_opening_number_uq UNIQUE (tenant_id, company_id, job_number),
 CONSTRAINT recruitment_job_opening_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE INDEX recruitment_job_opening_status_idx ON public.recruitment_job_opening (tenant_id, company_id, status);
CREATE INDEX recruitment_job_opening_process_idx ON public.recruitment_job_opening (process_id);
CREATE INDEX recruitment_job_opening_department_idx ON public.recruitment_job_opening (department_id) WHERE department_id IS NOT NULL;
CREATE INDEX recruitment_job_opening_business_unit_idx ON public.recruitment_job_opening (business_unit_id) WHERE business_unit_id IS NOT NULL;
--> statement-breakpoint

-- The job's team: one recruiter, any number of assistants, hiring managers and interviewers. A team
-- membership is NOT a role grant: it confers no access in slice 1.
CREATE TABLE public.recruitment_job_member (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 member_role text NOT NULL CHECK (member_role IN ('recruiter','assistant','hiring_manager','interviewer')),
 app_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_job_member_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_job_member_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_member_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_member_uq UNIQUE (job_id, member_role, app_user_id)
);
CREATE UNIQUE INDEX recruitment_job_member_one_recruiter_uq ON public.recruitment_job_member (job_id) WHERE member_role = 'recruiter';
CREATE INDEX recruitment_job_member_user_idx ON public.recruitment_job_member (app_user_id);
--> statement-breakpoint

-- A candidate: someone who applied. Distinct from PERSON / EMPLOYEE / EMPLOYMENT; nothing here creates them.
CREATE TABLE public.recruitment_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
 email text CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$')),
 phone text CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 40),
 owner_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_owner_fk FOREIGN KEY (owner_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_scope_uq UNIQUE (id, company_id, tenant_id)
);
--> statement-breakpoint

-- An application: one candidate for one job. Hired and archived are terminal states, not stages; an archived
-- application keeps the stage it left.
CREATE TABLE public.recruitment_application (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 current_stage_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','hired','archived')),
 archive_reason_id uuid,
 stage_left_at_archive uuid,
 source text CHECK (source IS NULL OR length(btrim(source)) BETWEEN 1 AND 120),
 applied_at timestamptz NOT NULL DEFAULT now(),
 state_changed_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_application_archive_ck CHECK (
  (state = 'archived') = (archive_reason_id IS NOT NULL) AND (state = 'archived') = (stage_left_at_archive IS NOT NULL)),
 CONSTRAINT recruitment_application_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_stage_fk FOREIGN KEY (current_stage_id, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_left_stage_fk FOREIGN KEY (stage_left_at_archive, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_reason_fk FOREIGN KEY (archive_reason_id, company_id, tenant_id) REFERENCES public.recruitment_archive_reason(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_application_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_application_once_uq UNIQUE (job_id, candidate_id),
 CONSTRAINT recruitment_application_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE INDEX recruitment_application_job_state_idx ON public.recruitment_application (job_id, state);
CREATE INDEX recruitment_application_company_stage_idx ON public.recruitment_application (tenant_id, company_id, state, current_stage_id);
CREATE INDEX recruitment_application_candidate_idx ON public.recruitment_application (candidate_id);
CREATE INDEX recruitment_application_stage_idx ON public.recruitment_application (current_stage_id);
CREATE INDEX recruitment_application_left_stage_idx ON public.recruitment_application (stage_left_at_archive) WHERE stage_left_at_archive IS NOT NULL;
CREATE INDEX recruitment_application_reason_idx ON public.recruitment_application (archive_reason_id) WHERE archive_reason_id IS NOT NULL;
--> statement-breakpoint

-- Append-only application history: who moved what, from where, to where, why and when.
CREATE TABLE public.recruitment_application_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 application_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('applied','moved','rejected','hired')),
 from_stage_id uuid,
 to_stage_id uuid,
 from_state text CHECK (from_state IN ('active','hired','archived')),
 to_state text NOT NULL CHECK (to_state IN ('active','hired','archived')),
 archive_reason_id uuid,
 actor_user_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_application_event_shape_ck CHECK (
  (kind = 'applied' AND from_stage_id IS NULL AND from_state IS NULL AND to_stage_id IS NOT NULL AND to_state = 'active' AND archive_reason_id IS NULL)
  OR (kind = 'moved' AND from_stage_id IS NOT NULL AND to_stage_id IS NOT NULL AND from_state = 'active' AND to_state = 'active' AND archive_reason_id IS NULL)
  OR (kind = 'rejected' AND from_stage_id IS NOT NULL AND from_state = 'active' AND to_state = 'archived' AND archive_reason_id IS NOT NULL)
  OR (kind = 'hired' AND from_stage_id IS NOT NULL AND from_state = 'active' AND to_state = 'hired' AND archive_reason_id IS NULL)),
 CONSTRAINT recruitment_application_event_application_fk FOREIGN KEY (application_id, company_id, tenant_id) REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_event_from_fk FOREIGN KEY (from_stage_id, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_event_to_fk FOREIGN KEY (to_stage_id, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_event_reason_fk FOREIGN KEY (archive_reason_id, company_id, tenant_id) REFERENCES public.recruitment_archive_reason(id, company_id, tenant_id),
 CONSTRAINT recruitment_application_event_actor_fk FOREIGN KEY (actor_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_application_event_application_idx ON public.recruitment_application_event (application_id, occurred_at);
CREATE INDEX recruitment_application_event_from_idx ON public.recruitment_application_event (from_stage_id) WHERE from_stage_id IS NOT NULL;
CREATE INDEX recruitment_application_event_to_idx ON public.recruitment_application_event (to_stage_id) WHERE to_stage_id IS NOT NULL;
CREATE INDEX recruitment_application_event_reason_idx ON public.recruitment_application_event (archive_reason_id) WHERE archive_reason_id IS NOT NULL;
--> statement-breakpoint

-- ── 4. Row security and grants: tenant AND recruitment administration of the row's company ─────────────
-- The policy names no role, so it binds the table owner too (FORCE): the one definer function below that
-- writes these tables answers to exactly the caller's recruitment authority, never more.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_stage','recruitment_process','recruitment_process_stage','recruitment_archive_reason',
  'recruitment_job_opening','recruitment_job_member','recruitment_candidate','recruitment_application','recruitment_application_event'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL
   USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
   WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))', t || '_admin', t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_stage, public.recruitment_process, public.recruitment_process_stage,
 public.recruitment_job_opening, public.recruitment_candidate, public.recruitment_application TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_archive_reason TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_job_member TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_application_event TO ai_hr_app;
--> statement-breakpoint

-- ── 4b. People labels: the one projection Recruitment reads names through ──────────────────────────────
-- A Recruiting Partner is not an HR administrator and cannot read person rows (person_rls is NOT widened: a
-- person row carries DOB, address, gender and marital status). Recruitment screens need exactly one column
-- from it — the full name — for two sets of logins: people employed by the company (job team pickers:
-- recruiters, hiring managers, interviewers) and recruitment administrators (the actors in application
-- history). Nothing else leaves this function, and only for a caller who administers recruitment for the
-- company. A login with no person row has no label; the screen says "User" for it.
CREATE FUNCTION app.recruitment_user_labels(p_company uuid) RETURNS TABLE(app_user_id uuid, full_name text, active boolean, employed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT u.id, p.full_name, u.archived_at IS NULL,
  EXISTS (SELECT 1 FROM employment e WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id AND e.company_id = p_company)
 FROM app_user u JOIN person p ON p.id = u.person_id AND p.tenant_id = u.tenant_id
 WHERE u.tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(p_company)
  AND (EXISTS (SELECT 1 FROM employment e WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id AND e.company_id = p_company)
   OR EXISTS (SELECT 1 FROM role_assignment r WHERE r.tenant_id = u.tenant_id AND r.app_user_id = u.id
    AND r.role::text IN ('hr_admin', 'super_admin', 'recruiting_partner')))
$$;
REVOKE ALL ON FUNCTION app.recruitment_user_labels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_user_labels(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Guards: the service decides, the database refuses what the service must never write ──────────────
-- Every guard runs as the caller (no SECURITY DEFINER): the caller already administers recruitment for the
-- row's company, so it sees every row of that company it needs to compare against.

-- Shared: tenant, company and creation provenance never move.
CREATE FUNCTION app.recruitment_guard_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
  RAISE EXCEPTION 'Recruitment records keep their company' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_identity() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_stage','recruitment_process','recruitment_process_stage','recruitment_archive_reason',
  'recruitment_job_member','recruitment_candidate'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint

-- Archive reasons: a default reason can be hidden, never deleted or turned into a custom one.
CREATE FUNCTION app.recruitment_guard_archive_reason() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF OLD.kind = 'default' AND current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'A default archive reason can be hidden, not deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.seed_key IS DISTINCT FROM OLD.seed_key THEN
  RAISE EXCEPTION 'An archive reason keeps its kind' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_archive_reason() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_archive_reason_guard BEFORE UPDATE OR DELETE ON public.recruitment_archive_reason
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_archive_reason();
--> statement-breakpoint

-- Stages: a stage keeps its system identity and seed key.
CREATE FUNCTION app.recruitment_guard_stage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.system_key IS DISTINCT FROM OLD.system_key OR NEW.seed_key IS DISTINCT FROM OLD.seed_key THEN
  RAISE EXCEPTION 'A recruitment stage keeps its system identity' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_stage() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_stage_guard BEFORE UPDATE ON public.recruitment_stage
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_stage();
--> statement-breakpoint

-- Jobs: number allocation, immutable attribute, process lock and the status machine.
--   open ↔ on_hold, open/on_hold → closed, closed → open (reopen; slice 1 implementation decision).
CREATE FUNCTION app.recruitment_guard_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE next_number integer;
BEGIN
 IF NEW.department_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.department d WHERE d.id = NEW.department_id AND d.tenant_id = NEW.tenant_id
   AND (d.company_id = NEW.company_id OR d.is_global)) THEN
  RAISE EXCEPTION 'Choose a department of this company' USING ERRCODE = '23514';
 END IF;
 IF NEW.business_unit_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.business_unit b WHERE b.id = NEW.business_unit_id AND b.tenant_id = NEW.tenant_id
   AND (b.company_id = NEW.company_id OR b.is_global)) THEN
  RAISE EXCEPTION 'Choose a business unit of this company' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'open' THEN RAISE EXCEPTION 'A new job opens as Open' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_process p WHERE p.id = NEW.process_id AND p.tenant_id = NEW.tenant_id AND p.enabled) THEN
   RAISE EXCEPTION 'Choose an enabled recruitment process' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-job-number:' || NEW.tenant_id::text || ':' || NEW.company_id::text, 0));
  SELECT coalesce(max(substr(j.job_number, 3)::integer), 0) + 1 INTO next_number
   FROM public.recruitment_job_opening j WHERE j.tenant_id = NEW.tenant_id AND j.company_id = NEW.company_id;
  IF next_number > 999999 THEN RAISE EXCEPTION 'Job numbers for this company are exhausted' USING ERRCODE = '23514'; END IF;
  NEW.job_number := 'MJ' || lpad(next_number::text, 6, '0');
  NEW.status_changed_at := now();
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_number IS DISTINCT FROM OLD.job_number OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A job keeps its company and number' USING ERRCODE = '23514';
 END IF;
 IF NEW.position_attribute IS DISTINCT FROM OLD.position_attribute THEN
  RAISE EXCEPTION 'The position attribute cannot be changed after the job is created' USING ERRCODE = '23514';
 END IF;
 IF NEW.process_id IS DISTINCT FROM OLD.process_id AND EXISTS (
  SELECT 1 FROM public.recruitment_application a WHERE a.job_id = OLD.id AND a.tenant_id = OLD.tenant_id) THEN
  RAISE EXCEPTION 'The recruitment process cannot be changed once the job has an application' USING ERRCODE = '23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  IF NOT ((OLD.status, NEW.status) IN (('open','on_hold'),('on_hold','open'),('open','closed'),('on_hold','closed'),('closed','open'))) THEN
   RAISE EXCEPTION 'Job status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  NEW.status_changed_at := now();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_opening_guard BEFORE INSERT OR UPDATE ON public.recruitment_job_opening
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job();
--> statement-breakpoint

-- Applications: the stage belongs to the job's process; hired and archived are terminal.
CREATE FUNCTION app.recruitment_guard_application() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.recruitment_job_opening j
  JOIN public.recruitment_process_stage ps ON ps.process_id = j.process_id AND ps.tenant_id = j.tenant_id
  WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id AND ps.stage_id = NEW.current_stage_id) THEN
  RAISE EXCEPTION 'The stage is not part of this job''s recruitment process' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'active' THEN RAISE EXCEPTION 'A new application starts active' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
  OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An application keeps its job, candidate and company' USING ERRCODE = '23514';
 END IF;
 IF OLD.state <> 'active' THEN
  RAISE EXCEPTION 'A hired or archived application is closed' USING ERRCODE = '23514';
 END IF;
 IF NEW.state = 'archived' AND NEW.stage_left_at_archive IS DISTINCT FROM OLD.current_stage_id THEN
  RAISE EXCEPTION 'An archived application records the stage it left' USING ERRCODE = '23514';
 END IF;
 IF NEW.state <> 'active' AND NEW.current_stage_id IS DISTINCT FROM OLD.current_stage_id THEN
  RAISE EXCEPTION 'Hiring or archiving keeps the current stage' USING ERRCODE = '23514';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state THEN NEW.state_changed_at := now(); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_application() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_guard BEFORE INSERT OR UPDATE ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_application();
--> statement-breakpoint

-- History is append-only and attributed to the current user.
CREATE FUNCTION app.recruitment_guard_application_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Recruitment application history is append-only' USING ERRCODE = '23514';
 END IF;
 IF NEW.actor_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Application history records the current user' USING ERRCODE = '42501';
 END IF;
 NEW.occurred_at := clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_application_event() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_event_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_application_event
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_application_event();
--> statement-breakpoint

-- ── 6. Deleting a company (core/company-refs.ts) ───────────────────────────────────────────────────────
-- A company's recruitment SETUP (stages, processes and their ordered stages, archive reasons) means nothing once
-- the company is gone, so the company delete removes it — but only when the company has no job opening and no
-- candidate, which refuse the delete as retained history first. The app role has no DELETE on the setup tables
-- and default reasons refuse deletion, so this one function does it, re-checking the caller's authority, and
-- says how many rows it removed. Called once per declared setup table; the second and third calls find nothing.
CREATE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
--> statement-breakpoint
-- AI Centre switch for the Recruitment module read (lib/ai/module-agents.ts: authorized_recruitment_pipeline_counts).
-- The read returns per-company position and application counts only — never a candidate, application or job record.
-- On by default like every other module read; it still needs the Recruitment entitlement and the caller's own
-- app.can_admin_recruitment_for(company), and an administrator can switch it off in the AI Centre.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES ('module:recruitment',true);
