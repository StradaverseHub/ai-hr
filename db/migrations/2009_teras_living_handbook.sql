-- AI v2 Phase 2, P2-5: the Living Handbook (owner-approved Phase 2 plan and Handbook mock-up, AI Centre › Policies,
-- 3 November 2026).
-- Source allocation 2009 / when1793330001409 in the AI Centre block 2000-2019 (docs/MIGRATION-ALLOCATION.md), renumbered
-- from the never-applied 0971 / when1793330000371 at the AI v2 Phase 2 integration (4 November 2026). It grants no
-- installation. Production is held.
--
-- WHAT IT HOLDS. A company's own policies, written in their own words, versioned and effective-dated, and the values
-- the system enforces from them:
--  1. teras_policy_document: one policy (its area and title). Written once by an administrator; never changed or deleted.
--  2. teras_policy_version: one version of its text, with the date it applies from. A draft is edited in place by the
--     administrators of every company it applies to; it is then sent for approval (locked), approved (immutable) or
--     returned to draft. At most one version of a policy is in progress at a time. Approval is checked HERE as well as in
--     code: a version that changes what the system enforces is approved only once a group administrator who contributed
--     nothing to it (not its author, an editor, a reader or decider of its values, a text-only marker or a sender, table 9)
--     has approved it; a text-only version needs one group administrator's approval. Whether a version changes what the
--     system enforces is DERIVED here when it is sent, never taken from the sender: it does when any value read from its
--     current text is confirmed (Phase 2 hardening, 4 November 2026).
--  3. teras_policy_scope: the companies a version applies to, all of the caller's tenant. Never across tenants.
--  4. teras_policy_value: a value AI Centre read from the text for a setting that ALREADY EXISTS in an owner service
--     (claims mileage rates, the claims submission window, a leave type's default entitlement table), with the exact
--     words it came from. Bound to the digest of the text it was read from: once the text changes, it no longer counts.
--     The model proposes; it never confirms or applies anything.
--  5. teras_policy_value_confirmation: a person's decision on one value (confirmed or rejected). The latest one counts.
--  6. teras_policy_approval: a group administrator's approval or return of one submission of a version.
--  7. teras_policy_application: what the owner service did with a confirmed value of an approved version: applied (with
--     the owner's value before and after), refused (with the owner's own message) or scheduled for its effective date.
--     The write itself is the owner's own settings write, under the approving administrator's login.
--  8. teras_policy_drift_finding: a disagreement between an approved policy value and the owner's current setting that
--     an administrator acted on ("Use the handbook" or "Update the handbook"), with both values and the draft prepared.
--  9. teras_policy_contribution: who shaped a version, recorded by this migration's own triggers under the acting login:
--     its author, each editor of its text, date or companies, each login that read or decided its values or marked a
--     setting text only, and each sender. Never written by an approval or a return.
-- 10. teras_policy_text_only: a person's mark that what a version's current text says about one enforceable setting is
--     text only and not enforced (the owner's setting stays), or the withdrawal of that mark. The latest one counts. A
--     version is sent only when every value read from its current text that is not confirmed is covered: a confirmed value
--     of the same setting, or this mark.
-- No amount is computed or stored by AI Centre: the values are the policy's own words, the before and after values are
-- the owner's, and the impact simulation is the claims service's read-only answer (it is not stored).
--
-- Who reads (FORCE row-level security on all ten tables):
--  - administrators of any company a version applies to: the policy, every version, its values, decisions, approvals,
--    applications and drift findings;
--  - every other login of the tenant who holds a current employment in a company a version applies to: APPROVED versions
--    only (their text and companies), never a draft, a value, a decision or an approval;
--  - scope rows (version and company ids only) are readable by the tenant, so the policies above can be evaluated;
--  - never an agent principal; never another tenant.
-- Who writes: administrators of every company a version applies to (drafts, values, decisions, applications, drift
-- findings, text-only marks); group administrators (approvals, and the version's move to approved or back to draft).
-- Contributions are written by the triggers below, each for the acting login only. Every row is attributed to the
-- current login. Grants: SELECT and INSERT; UPDATE on teras_policy_version only; DELETE on teras_policy_scope only (a
-- draft's companies). Everything else is revoked. Triggers refuse every other change.
--
-- Writers reviewed: all ten tables are new; core/handbook/policies.ts and this migration's triggers are their only
-- writers. Nothing here changes an existing table, policy or function.

-- 1. Policies.
CREATE TABLE public.teras_policy_document (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 area text NOT NULL CHECK (area IN ('leave','attendance','claims','allowances','people','other')),
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160 AND title=btrim(title)),
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_document_tenant_idx ON public.teras_policy_document(tenant_id,area,title);
--> statement-breakpoint
-- 2. Versions.
CREATE TABLE public.teras_policy_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 version integer NOT NULL CHECK (version>=1),
 body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
 effective_from date NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
 origin text NOT NULL DEFAULT 'written' CHECK (origin IN ('written','use_handbook','update_handbook','restored')),
 based_on_version_id uuid REFERENCES public.teras_policy_version(id),
 submission integer NOT NULL DEFAULT 0 CHECK (submission>=0),
 changes_settings boolean,
 author_user_id uuid NOT NULL REFERENCES public.app_user(id),
 submitted_by_user_id uuid REFERENCES public.app_user(id),
 submitted_at timestamptz,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (document_id,version),
 UNIQUE (id,tenant_id),
 FOREIGN KEY (document_id,tenant_id) REFERENCES public.teras_policy_document(id,tenant_id),
 CHECK ((status='draft')=(submitted_at IS NULL)),
 CHECK ((status='draft')=(submitted_by_user_id IS NULL)),
 CHECK ((status='draft')=(changes_settings IS NULL)),
 CHECK ((status='approved')=(approved_at IS NOT NULL))
);
--> statement-breakpoint
-- At most one version of a policy is in progress (draft or sent for approval) at a time.
CREATE UNIQUE INDEX teras_policy_version_open_uq ON public.teras_policy_version(document_id) WHERE status<>'approved';
--> statement-breakpoint
CREATE INDEX teras_policy_version_in_force_idx ON public.teras_policy_version(tenant_id,document_id,status,effective_from DESC,version DESC);
--> statement-breakpoint
-- 3. The companies a version applies to.
CREATE TABLE public.teras_policy_scope (
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 company_id uuid NOT NULL,
 PRIMARY KEY (version_id,company_id),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_scope_company_idx ON public.teras_policy_scope(tenant_id,company_id);
--> statement-breakpoint
-- 4. Values read from a version's text, each for an existing owner setting, with the words it came from.
CREATE TABLE public.teras_policy_value (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 setting text NOT NULL CHECK (setting IN ('claims.mileage_rates','claims.submit_within_days','leave.entitlement_days')),
 target jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(target)='object' AND octet_length(target::text)<=512),
 value jsonb NOT NULL CHECK (octet_length(value::text)<=4096),
 spans jsonb NOT NULL CHECK (jsonb_typeof(spans)='array' AND jsonb_array_length(spans) BETWEEN 1 AND 40 AND octet_length(spans::text)<=8192),
 body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
 source text NOT NULL CHECK (source IN ('model','drift','copied')),
 proposed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (id,tenant_id),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_value_version_idx ON public.teras_policy_value(version_id,proposed_at);
--> statement-breakpoint
-- 5. A person's decision on a value.
CREATE TABLE public.teras_policy_value_confirmation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 value_id uuid NOT NULL,
 decision text NOT NULL CHECK (decision IN ('confirmed','rejected')),
 decided_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (value_id,tenant_id) REFERENCES public.teras_policy_value(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_value_confirmation_value_idx ON public.teras_policy_value_confirmation(value_id,decided_at DESC);
--> statement-breakpoint
-- 6. Approvals and returns, one per approver per submission.
CREATE TABLE public.teras_policy_approval (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 submission integer NOT NULL CHECK (submission>=1),
 decision text NOT NULL CHECK (decision IN ('approved','returned')),
 approver_user_id uuid NOT NULL REFERENCES public.app_user(id),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (version_id,submission,approver_user_id),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id)
);
--> statement-breakpoint
-- 7. What the owner service did with a confirmed value of an approved version.
CREATE TABLE public.teras_policy_application (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 value_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('applied','refused','scheduled')),
 before_value jsonb CHECK (before_value IS NULL OR octet_length(before_value::text)<=4096),
 after_value jsonb CHECK (after_value IS NULL OR octet_length(after_value::text)<=4096),
 apply_on date NOT NULL,
 owner_message text CHECK (owner_message IS NULL OR length(owner_message)<=300),
 applied_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id),
 FOREIGN KEY (value_id,tenant_id) REFERENCES public.teras_policy_value(id,tenant_id),
 CHECK ((status='refused')=(owner_message IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX teras_policy_application_version_idx ON public.teras_policy_application(version_id,applied_at DESC);
--> statement-breakpoint
-- 8. Drift findings an administrator acted on.
CREATE TABLE public.teras_policy_drift_finding (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 value_id uuid NOT NULL,
 company_id uuid,
 setting text NOT NULL CHECK (setting IN ('claims.mileage_rates','claims.submit_within_days','leave.entitlement_days')),
 handbook_value jsonb NOT NULL CHECK (octet_length(handbook_value::text)<=4096),
 system_value jsonb CHECK (system_value IS NULL OR octet_length(system_value::text)<=4096),
 resolution text NOT NULL CHECK (resolution IN ('use_handbook','update_handbook')),
 prepared_version_id uuid NOT NULL,
 resolved_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 resolved_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id),
 FOREIGN KEY (value_id,tenant_id) REFERENCES public.teras_policy_value(id,tenant_id),
 FOREIGN KEY (prepared_version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
-- 9. Who contributed to a version (written by the triggers below, for the acting login).
CREATE TABLE public.teras_policy_contribution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES public.app_user(id),
 kind text NOT NULL CHECK (kind IN ('author','editor','value_reader','value_decider','text_only_marker','sender')),
 contributed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_contribution_version_idx ON public.teras_policy_contribution(version_id,user_id);
--> statement-breakpoint
-- 10. A person's mark that what the current text says about a setting is text only, not enforced (or its withdrawal).
CREATE TABLE public.teras_policy_text_only (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 version_id uuid NOT NULL,
 setting text NOT NULL CHECK (setting IN ('claims.mileage_rates','claims.submit_within_days','leave.entitlement_days')),
 body_digest text NOT NULL CHECK (body_digest ~ '^[a-f0-9]{64}$'),
 marked boolean NOT NULL,
 marked_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 marked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (version_id,tenant_id) REFERENCES public.teras_policy_version(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_policy_text_only_version_idx ON public.teras_policy_text_only(version_id,setting,marked_at DESC);
--> statement-breakpoint
-- ── Who the caller is for a version (invoker rights: each reads the scope rows under the tenant's own policy) ──
-- The caller holds a current employment in the company. Definer: reads the login and employment tables (not forced).
CREATE FUNCTION app.teras_policy_employed_in(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NULL AND EXISTS(SELECT 1 FROM public.app_user u
  JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND e.company_id=p_company
   AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_employed_in(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_employed_in(uuid) TO ai_hr_app;
--> statement-breakpoint
-- An administrator of at least one company the version applies to.
CREATE FUNCTION app.teras_policy_admin_any(p_version uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_agent_principal() IS NULL
  AND EXISTS(SELECT 1 FROM public.teras_policy_scope s WHERE s.version_id=p_version AND s.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(s.company_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_admin_any(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_admin_any(uuid) TO ai_hr_app;
--> statement-breakpoint
-- An administrator of EVERY company the version applies to (and it applies to at least one).
CREATE FUNCTION app.teras_policy_admin_all(p_version uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_agent_principal() IS NULL
  AND EXISTS(SELECT 1 FROM public.teras_policy_scope s WHERE s.version_id=p_version AND s.tenant_id=app.current_tenant_id())
  AND NOT EXISTS(SELECT 1 FROM public.teras_policy_scope s WHERE s.version_id=p_version AND s.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(s.company_id) IS NOT TRUE)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_admin_all(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_admin_all(uuid) TO ai_hr_app;
--> statement-breakpoint
-- A login employed in a company the version applies to (an employee reader of its approved text).
CREATE FUNCTION app.teras_policy_reader(p_version uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_agent_principal() IS NULL
  AND EXISTS(SELECT 1 FROM public.teras_policy_scope s WHERE s.version_id=p_version AND s.tenant_id=app.current_tenant_id()
   AND app.teras_policy_employed_in(s.company_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_reader(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_reader(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The SHA-256 of a version's text, the digest a value and a decision are bound to.
CREATE FUNCTION app.teras_policy_body_digest(p_body text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ SELECT encode(sha256(convert_to(p_body,'UTF8')),'hex') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_body_digest(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_body_digest(text) TO ai_hr_app;
--> statement-breakpoint
-- A value's latest decision (null: undecided).
CREATE FUNCTION app.teras_policy_latest_decision(p_value uuid) RETURNS text
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.decision FROM public.teras_policy_value_confirmation c WHERE c.value_id=p_value ORDER BY c.decided_at DESC,c.id DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_latest_decision(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_latest_decision(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Whether a setting of a version's text (by its digest) is marked text only now (the latest mark counts).
CREATE FUNCTION app.teras_policy_marked_text_only(p_version uuid,p_digest text,p_setting text) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT m.marked FROM public.teras_policy_text_only m WHERE m.version_id=p_version AND m.body_digest=p_digest AND m.setting=p_setting
  ORDER BY m.marked_at DESC,m.id DESC LIMIT 1),false)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_marked_text_only(uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_marked_text_only(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Whether a login contributed anything to a version. A caller always reads its own contributions; an administrator of
-- a company the version applies to reads everyone's (the approver of a settings change administers all of them).
CREATE FUNCTION app.teras_policy_contributed(p_version uuid,p_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.teras_policy_contribution c WHERE c.version_id=p_version AND c.user_id=p_user)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_contributed(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_contributed(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Records the acting login's contribution to a version, once per kind (invoker rights: under its own insert policy).
CREATE FUNCTION app.teras_policy_record_contribution(p_tenant uuid,p_version uuid,p_kind text) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A policy contribution is a login''s' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.teras_policy_contribution c WHERE c.version_id=p_version AND c.user_id=app.current_user_id() AND c.kind=p_kind) THEN
  INSERT INTO public.teras_policy_contribution (tenant_id,version_id,user_id,kind) VALUES (p_tenant,p_version,app.current_user_id(),p_kind);
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_record_contribution(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_policy_record_contribution(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- ── Guards ──
-- A policy is written once and never changed.
CREATE FUNCTION app.teras_policy_append_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'This policy record is append-only' USING ERRCODE='42501'; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_document_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_document
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- A version: born a draft by its author; its text and date change only while a draft; sent for approval only when every
-- value read from its current text has a decision; approved only when the approvals of its current submission satisfy
-- the rule; returned to draft only by a group administrator who returned this submission; immutable once approved.
CREATE FUNCTION app.teras_policy_version_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE digest text;confirmed boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A policy version is never deleted' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.submission<>0 OR NEW.author_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A policy version starts as its author''s draft' USING ERRCODE='42501';
  END IF;
  IF NEW.based_on_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.teras_policy_version b
   WHERE b.id=NEW.based_on_version_id AND b.document_id=NEW.document_id AND b.tenant_id=NEW.tenant_id) THEN
   RAISE EXCEPTION 'A version is based on a version of the same policy' USING ERRCODE='42501';
  END IF;
  NEW.created_at:=now();NEW.updated_at:=now();
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.document_id,NEW.version,NEW.origin,NEW.based_on_version_id,NEW.author_user_id,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.document_id,OLD.version,OLD.origin,OLD.based_on_version_id,OLD.author_user_id,OLD.created_at) THEN
  RAISE EXCEPTION 'A policy version keeps its identity' USING ERRCODE='42501';
 END IF;
 IF OLD.status='approved' THEN RAISE EXCEPTION 'An approved policy version is never changed' USING ERRCODE='42501'; END IF;
 IF OLD.status='draft' AND NEW.status='draft' THEN
  IF NEW.submission<>OLD.submission THEN RAISE EXCEPTION 'A draft keeps its submissions' USING ERRCODE='42501'; END IF;
  NEW.updated_at:=now();RETURN NEW;
 END IF;
 IF (NEW.body,NEW.effective_from) IS DISTINCT FROM (OLD.body,OLD.effective_from) THEN
  RAISE EXCEPTION 'Only a draft''s text and date change' USING ERRCODE='42501';
 END IF;
 digest:=app.teras_policy_body_digest(OLD.body);
 IF OLD.status='draft' AND NEW.status='submitted' THEN
  IF NEW.submission<>OLD.submission+1 OR NEW.submitted_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A version is sent by the current login, once per submission' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.teras_policy_value v WHERE v.version_id=OLD.id AND v.body_digest=digest
   AND NOT EXISTS(SELECT 1 FROM public.teras_policy_value_confirmation c WHERE c.value_id=v.id)) THEN
   RAISE EXCEPTION 'Every value read from the text needs a decision before it is sent' USING ERRCODE='42501';
  END IF;
  -- Every enforceable setting a value was read for is confirmed, or a person marked it text only: a rejected value
  -- alone never lets the text say one thing while the system enforces another unseen.
  IF EXISTS(SELECT 1 FROM public.teras_policy_value v WHERE v.version_id=OLD.id AND v.body_digest=digest
   AND app.teras_policy_latest_decision(v.id) IS DISTINCT FROM 'confirmed'
   AND NOT EXISTS(SELECT 1 FROM public.teras_policy_value w WHERE w.version_id=OLD.id AND w.body_digest=digest AND w.setting=v.setting
    AND app.teras_policy_latest_decision(w.id)='confirmed')
   AND NOT app.teras_policy_marked_text_only(OLD.id,digest,v.setting)) THEN
   RAISE EXCEPTION 'Every enforceable setting the text states is confirmed or marked text only before it is sent' USING ERRCODE='42501';
  END IF;
  -- Whether it changes what the system enforces is derived from its confirmed values, never taken from the sender.
  confirmed:=EXISTS(SELECT 1 FROM public.teras_policy_value v WHERE v.version_id=OLD.id AND v.body_digest=digest
   AND app.teras_policy_latest_decision(v.id)='confirmed');
  IF NEW.changes_settings IS NOT NULL AND NEW.changes_settings IS DISTINCT FROM confirmed THEN
   RAISE EXCEPTION 'Whether a version changes enforced settings is derived from its confirmed values' USING ERRCODE='42501';
  END IF;
  NEW.changes_settings:=confirmed;
  NEW.submitted_at:=now();NEW.updated_at:=now();RETURN NEW;
 END IF;
 IF OLD.status='submitted' AND NEW.status='approved' THEN
  IF NEW.submission<>OLD.submission OR NEW.changes_settings IS DISTINCT FROM OLD.changes_settings
   OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
   RAISE EXCEPTION 'An approval keeps the submission' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.teras_policy_approval a WHERE a.version_id=OLD.id AND a.submission=OLD.submission
   AND a.decision='approved' AND a.approver_user_id=app.current_user_id()) THEN
   RAISE EXCEPTION 'A version is approved by the approving group administrator' USING ERRCODE='42501';
  END IF;
  -- The rule (owner, 3 November 2026): a version that changes what the system enforces needs a second, different
  -- administrator: approved by a group administrator who contributed nothing to it (not its author, an editor, a reader
  -- or decider of its values, a text-only marker or a sender). Text only: one approval.
  IF OLD.changes_settings AND NOT EXISTS(SELECT 1 FROM public.teras_policy_approval a WHERE a.version_id=OLD.id
   AND a.submission=OLD.submission AND a.decision='approved' AND a.approver_user_id<>OLD.author_user_id
   AND a.approver_user_id<>OLD.submitted_by_user_id AND NOT app.teras_policy_contributed(OLD.id,a.approver_user_id)) THEN
   RAISE EXCEPTION 'A change to enforced settings needs a second administrator''s approval' USING ERRCODE='42501';
  END IF;
  NEW.approved_at:=now();NEW.updated_at:=now();RETURN NEW;
 END IF;
 IF OLD.status='submitted' AND NEW.status='draft' THEN
  IF NEW.submission<>OLD.submission OR NOT EXISTS(SELECT 1 FROM public.teras_policy_approval a WHERE a.version_id=OLD.id
   AND a.submission=OLD.submission AND a.decision='returned' AND a.approver_user_id=app.current_user_id()) THEN
   RAISE EXCEPTION 'A version returns to draft only by its approver''s return' USING ERRCODE='42501';
  END IF;
  NEW.updated_at:=now();RETURN NEW;
 END IF;
 RAISE EXCEPTION 'That policy version change is not allowed' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_version_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_version_guard BEFORE INSERT OR UPDATE OR DELETE ON public.teras_policy_version
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_version_guard();
--> statement-breakpoint
-- A version's companies change only while it is a draft; scope rows are never updated.
CREATE FUNCTION app.teras_policy_scope_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'A policy scope row is never changed' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.teras_policy_version v WHERE v.id=target AND v.status='draft') THEN
  RAISE EXCEPTION 'Only a draft''s companies change' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_scope_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON public.teras_policy_scope
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_scope_guard();
--> statement-breakpoint
-- A value is read into a draft, from its current text, by the current login.
CREATE FUNCTION app.teras_policy_value_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.proposed_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.teras_policy_version v
  WHERE v.id=NEW.version_id AND v.status='draft' AND app.teras_policy_body_digest(v.body)=NEW.body_digest) THEN
  RAISE EXCEPTION 'A value is read from a draft''s current text' USING ERRCODE='42501';
 END IF;
 NEW.proposed_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_value_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_value_guard BEFORE INSERT ON public.teras_policy_value
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_value_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_value_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_value
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- A decision is made by the current login on a value of a draft's current text.
CREATE FUNCTION app.teras_policy_confirmation_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.decided_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.teras_policy_value x
  JOIN public.teras_policy_version v ON v.id=x.version_id
  WHERE x.id=NEW.value_id AND v.status='draft' AND app.teras_policy_body_digest(v.body)=x.body_digest) THEN
  RAISE EXCEPTION 'A decision is made on a value of a draft''s current text' USING ERRCODE='42501';
 END IF;
 NEW.decided_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_confirmation_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_confirmation_guard BEFORE INSERT ON public.teras_policy_value_confirmation
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_confirmation_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_confirmation_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_value_confirmation
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- An approval or return is the current login's, on the version's current submission while it waits; a group
-- administrator never approves a settings change they contributed to (wrote, edited, read or decided values for, marked
-- text only or sent).
CREATE FUNCTION app.teras_policy_approval_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v record;
BEGIN
 SELECT * INTO v FROM public.teras_policy_version x WHERE x.id=NEW.version_id;
 IF NOT FOUND OR v.status<>'submitted' OR NEW.submission<>v.submission OR NEW.approver_user_id IS DISTINCT FROM app.current_user_id()
  OR app.is_group_admin() IS NOT TRUE THEN
  RAISE EXCEPTION 'A group administrator decides a version that waits for approval' USING ERRCODE='42501';
 END IF;
 IF NEW.decision='approved' AND v.changes_settings AND (NEW.approver_user_id=v.author_user_id OR NEW.approver_user_id=v.submitted_by_user_id
  OR app.teras_policy_contributed(v.id,NEW.approver_user_id)) THEN
  RAISE EXCEPTION 'A change to enforced settings is approved by a different administrator' USING ERRCODE='42501';
 END IF;
 NEW.decided_at:=now();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_approval_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_approval_guard BEFORE INSERT ON public.teras_policy_approval
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_approval_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_approval_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_approval
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- An application is recorded for a CONFIRMED value of an APPROVED version, by the current login. A value that changed
-- the owner's setting (before differs from after) is recorded only for a version approved as a settings change, so a
-- text-only approval can never carry an enforced change.
CREATE FUNCTION app.teras_policy_application_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v record;latest text;
BEGIN
 SELECT * INTO v FROM public.teras_policy_version x WHERE x.id=NEW.version_id;
 IF NOT FOUND OR v.status<>'approved' OR NEW.applied_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only an approved version''s values are applied' USING ERRCODE='42501';
 END IF;
 SELECT c.decision INTO latest FROM public.teras_policy_value_confirmation c JOIN public.teras_policy_value x ON x.id=c.value_id
  WHERE c.value_id=NEW.value_id AND x.version_id=NEW.version_id AND x.body_digest=app.teras_policy_body_digest(v.body)
  ORDER BY c.decided_at DESC,c.id DESC LIMIT 1;
 IF latest IS DISTINCT FROM 'confirmed' THEN
  RAISE EXCEPTION 'Only a confirmed value is applied' USING ERRCODE='42501';
 END IF;
 IF NEW.status='applied' AND NEW.before_value IS DISTINCT FROM NEW.after_value AND v.changes_settings IS NOT TRUE THEN
  RAISE EXCEPTION 'A setting change needs a version approved as a settings change' USING ERRCODE='42501';
 END IF;
 NEW.applied_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_application_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_application_guard BEFORE INSERT ON public.teras_policy_application
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_application_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_application_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_application
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- A drift finding names a value of an approved version and the draft prepared from it.
CREATE FUNCTION app.teras_policy_drift_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.resolved_by_user_id IS DISTINCT FROM app.current_user_id()
  OR NOT EXISTS(SELECT 1 FROM public.teras_policy_version v JOIN public.teras_policy_value x ON x.version_id=v.id
   WHERE v.id=NEW.version_id AND x.id=NEW.value_id AND v.status='approved')
  OR NOT EXISTS(SELECT 1 FROM public.teras_policy_version d JOIN public.teras_policy_version v ON v.document_id=d.document_id
   WHERE d.id=NEW.prepared_version_id AND v.id=NEW.version_id AND d.status='draft') THEN
  RAISE EXCEPTION 'A drift finding names an approved value and the draft prepared from it' USING ERRCODE='42501';
 END IF;
 NEW.resolved_at:=now();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_drift_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_drift_guard BEFORE INSERT ON public.teras_policy_drift_finding
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_drift_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_drift_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_drift_finding
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- A text-only mark is made by the current login on a draft's current text.
CREATE FUNCTION app.teras_policy_text_only_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.marked_by_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.teras_policy_version v
  WHERE v.id=NEW.version_id AND v.status='draft' AND app.teras_policy_body_digest(v.body)=NEW.body_digest) THEN
  RAISE EXCEPTION 'A text-only mark is made on a draft''s current text' USING ERRCODE='42501';
 END IF;
 NEW.marked_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_text_only_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_text_only_guard BEFORE INSERT ON public.teras_policy_text_only
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_text_only_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_text_only_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_text_only
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- A contribution is recorded by the triggers below for the acting login; it is never changed or deleted.
CREATE FUNCTION app.teras_policy_contribution_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'A contribution is the acting login''s' USING ERRCODE='42501';
 END IF;
 NEW.contributed_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_contribution_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_contribution_guard BEFORE INSERT ON public.teras_policy_contribution
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_contribution_guard();
--> statement-breakpoint
CREATE TRIGGER teras_policy_contribution_append_only BEFORE UPDATE OR DELETE ON public.teras_policy_contribution
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_append_only();
--> statement-breakpoint
-- Who contributed, recorded as each change happens: the author when a version is written; an editor (other than its
-- author, already recorded) when a draft's text or date changes or its companies do; the sender when it is sent; a
-- reader of its values, a decider of one, and a text-only marker. An approval or a return is not a contribution.
CREATE FUNCTION app.teras_policy_version_contribution() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN PERFORM app.teras_policy_record_contribution(NEW.tenant_id,NEW.id,'author');
 ELSIF OLD.status='draft' AND NEW.status='draft' AND (NEW.body,NEW.effective_from) IS DISTINCT FROM (OLD.body,OLD.effective_from)
  AND NEW.author_user_id IS DISTINCT FROM app.current_user_id() THEN
  PERFORM app.teras_policy_record_contribution(NEW.tenant_id,NEW.id,'editor');
 ELSIF OLD.status='draft' AND NEW.status='submitted' THEN PERFORM app.teras_policy_record_contribution(NEW.tenant_id,NEW.id,'sender');
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_version_contribution() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_version_contribution AFTER INSERT OR UPDATE ON public.teras_policy_version
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_version_contribution();
--> statement-breakpoint
CREATE FUNCTION app.teras_policy_scope_contribution() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 target uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.teras_policy_version v WHERE v.id=target AND v.author_user_id=app.current_user_id()) THEN
  PERFORM app.teras_policy_record_contribution(tenant,target,'editor');
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_scope_contribution() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_scope_contribution AFTER INSERT OR DELETE ON public.teras_policy_scope
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_scope_contribution();
--> statement-breakpoint
CREATE FUNCTION app.teras_policy_value_contribution() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='teras_policy_value' THEN PERFORM app.teras_policy_record_contribution(NEW.tenant_id,NEW.version_id,'value_reader');
 ELSIF TG_TABLE_NAME='teras_policy_text_only' THEN PERFORM app.teras_policy_record_contribution(NEW.tenant_id,NEW.version_id,'text_only_marker');
 ELSE PERFORM app.teras_policy_record_contribution(NEW.tenant_id,(SELECT x.version_id FROM public.teras_policy_value x WHERE x.id=NEW.value_id),'value_decider');
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_policy_value_contribution() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_policy_value_contribution AFTER INSERT ON public.teras_policy_value
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_value_contribution();
--> statement-breakpoint
CREATE TRIGGER teras_policy_confirmation_contribution AFTER INSERT ON public.teras_policy_value_confirmation
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_value_contribution();
--> statement-breakpoint
CREATE TRIGGER teras_policy_text_only_contribution AFTER INSERT ON public.teras_policy_text_only
 FOR EACH ROW EXECUTE FUNCTION app.teras_policy_value_contribution();
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.teras_policy_document ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_document FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_scope ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_scope FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_value ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_value FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_value_confirmation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_value_confirmation FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_approval ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_approval FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_application ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_application FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_drift_finding ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_drift_finding FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_contribution ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_contribution FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_text_only ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_policy_text_only FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Policies: readable when one of its versions is (or by its author); written by an administrator under their login.
CREATE POLICY teras_policy_document_read ON public.teras_policy_document FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND (created_by_user_id=app.current_user_id()
  OR EXISTS(SELECT 1 FROM public.teras_policy_version v WHERE v.document_id=teras_policy_document.id)));
--> statement-breakpoint
CREATE POLICY teras_policy_document_insert ON public.teras_policy_document FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin() AND created_by_user_id=app.current_user_id());
--> statement-breakpoint
-- Versions: administrators of a company it applies to read every version; an employee of such a company reads approved
-- versions only; its author reads their own draft before its companies are set.
CREATE POLICY teras_policy_version_read ON public.teras_policy_version FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND (app.teras_policy_admin_any(id)
  OR (status='approved' AND app.teras_policy_reader(id)) OR (author_user_id=app.current_user_id() AND status<>'approved')));
--> statement-breakpoint
CREATE POLICY teras_policy_version_insert ON public.teras_policy_version FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin() AND author_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_policy_version_update ON public.teras_policy_version FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_policy_admin_all(id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_all(id));
--> statement-breakpoint
CREATE POLICY teras_policy_scope_read ON public.teras_policy_scope FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_policy_scope_insert ON public.teras_policy_scope FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND EXISTS(SELECT 1 FROM public.teras_policy_version v WHERE v.id=version_id
   AND (v.author_user_id=app.current_user_id() OR app.teras_policy_admin_all(v.id))));
--> statement-breakpoint
CREATE POLICY teras_policy_scope_delete ON public.teras_policy_scope FOR DELETE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.teras_policy_admin_all(version_id));
--> statement-breakpoint
-- Values, decisions, approvals, applications and drift findings: administrators of a company the version applies to.
CREATE POLICY teras_policy_value_read ON public.teras_policy_value FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_any(version_id));
--> statement-breakpoint
CREATE POLICY teras_policy_value_insert ON public.teras_policy_value FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_policy_admin_all(version_id)
  AND proposed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_policy_value_confirmation_read ON public.teras_policy_value_confirmation FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.teras_policy_value x WHERE x.id=value_id AND app.teras_policy_admin_any(x.version_id)));
--> statement-breakpoint
CREATE POLICY teras_policy_value_confirmation_insert ON public.teras_policy_value_confirmation FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND decided_by_user_id=app.current_user_id()
  AND EXISTS(SELECT 1 FROM public.teras_policy_value x WHERE x.id=value_id AND app.teras_policy_admin_all(x.version_id)));
--> statement-breakpoint
CREATE POLICY teras_policy_approval_read ON public.teras_policy_approval FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_any(version_id));
--> statement-breakpoint
CREATE POLICY teras_policy_approval_insert ON public.teras_policy_approval FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_group_admin() AND app.teras_policy_admin_all(version_id) AND approver_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_policy_application_read ON public.teras_policy_application FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_any(version_id));
--> statement-breakpoint
CREATE POLICY teras_policy_application_insert ON public.teras_policy_application FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_policy_admin_all(version_id)
  AND applied_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_policy_drift_finding_read ON public.teras_policy_drift_finding FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_any(version_id));
--> statement-breakpoint
CREATE POLICY teras_policy_drift_finding_insert ON public.teras_policy_drift_finding FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_policy_admin_all(version_id)
  AND resolved_by_user_id=app.current_user_id() AND (company_id IS NULL OR app.is_admin_for(company_id)));
--> statement-breakpoint
-- Contributions: an administrator of a company the version applies to reads them, and every login reads its own (so a
-- guard asking whether the acting login contributed always sees the answer). Each is written for the acting login only.
CREATE POLICY teras_policy_contribution_read ON public.teras_policy_contribution FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND (user_id=app.current_user_id() OR app.teras_policy_admin_any(version_id)));
--> statement-breakpoint
CREATE POLICY teras_policy_contribution_insert ON public.teras_policy_contribution FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_policy_text_only_read ON public.teras_policy_text_only FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.teras_policy_admin_any(version_id));
--> statement-breakpoint
CREATE POLICY teras_policy_text_only_insert ON public.teras_policy_text_only FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() IS TRUE AND app.teras_policy_admin_all(version_id)
  AND marked_by_user_id=app.current_user_id());
--> statement-breakpoint
-- ── Grants: every privilege a table must not have is revoked ──
REVOKE ALL ON public.teras_policy_document,public.teras_policy_version,public.teras_policy_scope,public.teras_policy_value,
 public.teras_policy_value_confirmation,public.teras_policy_approval,public.teras_policy_application,public.teras_policy_drift_finding,
 public.teras_policy_contribution,public.teras_policy_text_only
 FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_policy_document,public.teras_policy_value,public.teras_policy_value_confirmation,
 public.teras_policy_approval,public.teras_policy_application,public.teras_policy_drift_finding,
 public.teras_policy_contribution,public.teras_policy_text_only TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_policy_version TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON public.teras_policy_scope TO ai_hr_app;
