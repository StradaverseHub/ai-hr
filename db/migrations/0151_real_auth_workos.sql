-- Real per-user authentication (ADR-0072, WorkOS AuthKit).
--
-- Additive + RLS-covered. Fills the ONE step left unbuilt since ADR-0004: mapping a verified WorkOS
-- subject to an internal app_user. The authorization substrate (app.principal 0012→0016, RLS 0001/0016,
-- grants/ABAC 0009) is UNCHANGED — this migration only adds the identity-resolution + invitation seam.

-- ── 1. One WorkOS identity = one app_user (ADR-0002: one person is in exactly one tenant) ──
-- GLOBAL unique (not composite with tenant_id): the subject lookup must return exactly one row, and the
-- same subject must never resolve into two tenants. Seed placeholders ('user_dev_admin', 'seed:<email>')
-- are already per-row-unique, so this does not collide on seeded dev DBs.
CREATE UNIQUE INDEX app_user_workos_user_id_uq ON app_user (workos_user_id);
--> statement-breakpoint

-- ── 2. app_invitation — admin-issued, single-use, expiring invite to create/link an app_user ──
CREATE TABLE app_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  -- Company scope for the granted role (nullable = group-wide), mirroring role_assignment.company_id.
  company_id uuid REFERENCES company(id),
  email text NOT NULL,
  -- The role the invitee's app_user gets on acceptance (validated against the role enum in the service).
  role text NOT NULL,
  -- If the invite targets an existing person (re-issuing a login for a hired employee), link it here so
  -- the created app_user inherits that person_id; NULL = a standalone admin login with no employee record.
  person_id uuid REFERENCES person(id),
  -- HASH ONLY — the raw opaque base64url token is emailed via WorkOS and never stored (schema.ts:2649
  -- convention). token_hash = sha256(raw) hex; globally unique so the consume path can look it up pre-auth.
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES app_user(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_invitation_status_ck CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX app_invitation_token_hash_uq ON app_invitation (token_hash);
--> statement-breakpoint
CREATE INDEX app_invitation_tenant_idx ON app_invitation (tenant_id, status);
--> statement-breakpoint

-- The 0001 blanket GRANT ON ALL TABLES only covered tables existing then; new tables need their own
-- grant (as 0004/0006 do). Without this the non-privileged app role cannot touch app_invitation.
GRANT SELECT, INSERT, UPDATE ON app_invitation TO ai_hr_app;
--> statement-breakpoint

-- RLS: admins manage invitations for companies they administer (mirror role_assignment/app_user: identity
-- management is group-wide-admin-gated; a company-scoped delegated admin may issue within its subtree).
ALTER TABLE app_invitation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY app_invitation_rls ON app_invitation FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(coalesce(company_id, id)));
--> statement-breakpoint
-- The invitation lifecycle is append-then-mutate-through-service; block hard deletes so an audit gap can't
-- be opened by dropping a consumed/revoked row (mirrors domain_event immutability posture).
REVOKE DELETE, TRUNCATE ON app_invitation FROM ai_hr_app;
--> statement-breakpoint

-- ── 3. app.principal_by_subject — the WorkOS bootstrap resolver ──
-- Wraps the 0016 grants-jsonb app.principal(). Resolves a verified WorkOS subject → app_user, and ALSO
-- returns app_user_id (because getSession() has no cookie id to feed app.principal, and userId MUST be the
-- internal id, not the subject string — see ADR-0072). Runs pre-RLS (SECURITY DEFINER), same seam as
-- app.principal. Returns 0 rows for an unknown/offboarded subject → getSession treats as AuthRequired.
CREATE OR REPLACE FUNCTION app.principal_by_subject(p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid, person_id uuid, grants jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, p.tenant_id, p.person_id, p.grants
  FROM app_user u
  CROSS JOIN LATERAL app.principal(u.id) p
  WHERE u.workos_user_id = p_subject;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.principal_by_subject(text) TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Reserved system tenant for pre-auth auth events ──
-- domain_event.tenant_id has a NOT NULL FK → tenant(id). Pre-auth events (login-failed on an un-invited
-- email, reset request for an unknown email) have no real tenant, so they are stamped with this reserved
-- nil-uuid system tenant — a valid FK target that no real customer ever uses (it holds no companies /
-- people / employments, so RLS on any tenant-scoped table naturally excludes it). Idempotent insert.
INSERT INTO tenant (id, workos_org_id, name)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, 'org_system_auth_audit', 'System (auth audit)')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ── 5. app.append_auth_event — SECURITY DEFINER auth-audit writer (outside tenant RLS) ──
-- Pre-auth / cross-context auth events have NO tenant + NO session, so they cannot pass domain_event RLS
-- (0001: WITH CHECK tenant_id = app.current_tenant_id(), tenant_id NOT NULL, ai_hr_app is non-BYPASSRLS).
-- This writer appends them outside the tenant RLS path — the app.onboarding_* / app.principal pattern.
-- p_tenant_id NULL is only permitted for pre-auth events (login-failed on an un-invited email, reset
-- request for an unknown email): those get the reserved system tenant so the NOT NULL + FK columns are
-- satisfied and they stay admin-only-to-read (no subjectEmploymentId). Events WITH a resolved tenant
-- stamp the real one.
CREATE OR REPLACE FUNCTION app.append_auth_event(
  p_tenant_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_actor_type text,
  p_actor_id uuid,
  p_payload jsonb
)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
  VALUES (
    COALESCE(p_tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    p_aggregate_type, p_aggregate_id, p_event_type,
    p_actor_type::actor_type, p_actor_id, NULL, p_payload
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.append_auth_event(uuid, text, uuid, text, text, uuid, jsonb) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. app.consume_invitation — un-authenticated single-use invitation consume ──
-- The invitee has NO app.current_tenant_id and NO app.current_user_id (unlike app.onboarding_*, which run
-- post-login). So consume runs SECURITY DEFINER, taking the RAW TOKEN as its only trust input: it hashes,
-- looks up the row by token_hash, derives the tenant FROM that row, and atomically marks it accepted +
-- creates/links the app_user + sets workos_user_id + creates the role_assignment. Single-use is guarded by
-- the conditional UPDATE ... WHERE status='pending' AND expires_at > now(): a second concurrent consume
-- matches 0 rows and returns nothing. Returns the resolved (app_user_id, tenant_id) on success.
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
  RETURNS TABLE (app_user_id uuid, tenant_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  app_invitation%ROWTYPE;
  v_user_id uuid;
BEGIN
  -- Atomic single-use claim: only a still-pending, unexpired invitation flips to accepted; a concurrent
  -- second consume of the same token affects 0 rows and drops through to the NOT FOUND branch.
  UPDATE app_invitation
     SET status = 'accepted', accepted_at = now()
   WHERE token_hash = v_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RETURN; -- unknown / already-consumed / expired token → 0 rows (caller throws InvalidInvitation)
  END IF;

  -- Create or link the app_user for this subject. If a person was targeted and already has an app_user,
  -- attach the subject to it; otherwise insert a new one. workos_user_id is globally unique, so a subject
  -- already bound to another user makes this fail loudly (correct: one subject = one user).
  IF v_inv.person_id IS NOT NULL THEN
    SELECT id INTO v_user_id FROM app_user WHERE tenant_id = v_inv.tenant_id AND person_id = v_inv.person_id LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO app_user (tenant_id, workos_user_id, person_id)
    VALUES (v_inv.tenant_id, p_subject, v_inv.person_id)
    RETURNING id INTO v_user_id;
  ELSE
    UPDATE app_user SET workos_user_id = p_subject WHERE id = v_user_id;
  END IF;

  INSERT INTO role_assignment (tenant_id, app_user_id, company_id, role)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.company_id, v_inv.role::role);

  RETURN QUERY SELECT v_user_id, v_inv.tenant_id;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.consume_invitation(text, text) TO ai_hr_app;
