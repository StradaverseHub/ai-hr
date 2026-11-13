-- Board db14e49c: the Rewards Access role permission grid. Levels per cell (Full / At their step / View only / —),
-- batch saves with one reason, a version per saved batch, doer and checker for proposers, and the formerly
-- display-only rows (configuration pages, Senior plan amounts, restricted direct reports, Promotion nominations) now
-- narrow the server. Every object here is owned by the migration owner; no purpose-owned object is replaced
-- (docs/SCALE-AND-RELEASE-RULES.md rule 9). DRAFT block 5520-5539; the integrator renumbers at admission.

-- 1. The catalogue mirror of packs/rewards/access-policy-model.ts. The default is also the ceiling.
CREATE FUNCTION app.reward_level_rank(wanted_level text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE wanted_level WHEN 'full' THEN 3 WHEN 'step' THEN 2 WHEN 'view' THEN 1 ELSE 0 END
$$;
CREATE FUNCTION app.reward_role_default_level(wanted_role text,wanted_capability text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN r NOT IN('bu','bg','gr','ctro','ec','pbp','hr_admin','payroll') THEN 'none' ELSE CASE
  WHEN wanted_capability IN('access.manage','plans.manage','pat.manage','data.check','snapshot.refresh') THEN CASE WHEN r='gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('salary.view','bonus.view') THEN CASE r WHEN 'gr' THEN 'full' WHEN 'ctro' THEN 'view' ELSE 'none' END
  WHEN wanted_capability IN('senior.manage','limits.view') THEN CASE r WHEN 'gr' THEN 'full' WHEN 'ctro' THEN 'view' WHEN 'ec' THEN 'view' ELSE 'none' END
  WHEN wanted_capability='restricted.view' THEN CASE WHEN r IN('gr','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='promotions.view' THEN CASE WHEN r='gr' THEN 'view' ELSE 'none' END
  WHEN wanted_capability IN('review.view','analytics.view','approvals.view','rules.view') THEN CASE WHEN r='hr_admin' THEN 'none' ELSE 'view' END
  WHEN wanted_capability='cases.decide' THEN CASE r WHEN 'bu' THEN 'step' WHEN 'gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('figures.edit','notes.add','review.decide','review.batch') THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.raise' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.decide' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bg','ctro','ec') THEN 'step' ELSE 'none' END
  ELSE 'none' END END
 FROM (SELECT CASE WHEN wanted_role='proxy_bg' THEN 'bg' ELSE wanted_role END AS r) x
$$;
CREATE FUNCTION app.reward_role_level_options(wanted_role text,wanted_capability text) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN d='none' THEN ARRAY['none']
  WHEN wanted_capability='restricted.view' THEN ARRAY['step','view']
  WHEN d='full' AND wanted_capability IN('salary.view','bonus.view','senior.manage','limits.view') THEN ARRAY['full','view','none']
  ELSE ARRAY[d,'none'] END
 FROM (SELECT app.reward_role_default_level(wanted_role,wanted_capability) AS d) x
$$;
-- Locked cells: Group Rewards keeps Rewards Access; Submit or approve stays for every route role except the proxy;
-- governance rows and cells with a single option are fixed.
CREATE FUNCTION app.reward_role_permission_locked(wanted_role text,wanted_capability text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT wanted_capability NOT IN('review.view','promotions.view','analytics.view','approvals.view','rules.view','plans.manage','salary.view','bonus.view','pat.manage','limits.view','access.manage',
   'figures.edit','cases.decide','notes.add','review.decide','review.batch','senior.manage','restricted.view','offcycle.raise','offcycle.decide','data.check','snapshot.refresh')
  OR wanted_role NOT IN('bu','bg','proxy_bg','gr','ctro','ec','pbp','hr_admin','payroll')
  OR (wanted_role='gr' AND wanted_capability='access.manage')
  OR (wanted_capability='review.decide' AND wanted_role IN('bu','bg','gr','ctro','ec'))
  OR cardinality(app.reward_role_level_options(wanted_role,wanted_capability))<2
$$;
REVOKE ALL ON FUNCTION app.reward_level_rank(text),app.reward_role_default_level(text,text),app.reward_role_level_options(text,text),app.reward_role_permission_locked(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_level_rank(text),app.reward_role_default_level(text,text),app.reward_role_level_options(text,text),app.reward_role_permission_locked(text,text) TO ai_hr_app;
--> statement-breakpoint

-- 2. Levels on the saved cells. `allowed` stays in step (allowed = level <> 'none') for every boolean reader
-- (app.reward_capability, app.reward_preparation_audience_allowed). Legacy rows: allowed=false is 'none'; allowed=true
-- equals the default (no default changed on a row that was editable before).
DROP TRIGGER reward_role_permission_shape ON public.reward_role_permission;
ALTER TABLE public.reward_role_permission ADD COLUMN level text CHECK(level IS NULL OR level IN('full','step','view','none'));
ALTER TABLE public.reward_role_permission NO FORCE ROW LEVEL SECURITY;
UPDATE public.reward_role_permission SET level=CASE WHEN allowed THEN app.reward_role_default_level(role,capability) ELSE 'none' END WHERE level IS NULL;
ALTER TABLE public.reward_role_permission FORCE ROW LEVEL SECURITY;
CREATE FUNCTION app.reward_role_permission_level_shape() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 -- Legacy writers set only `allowed`: an UPDATE that changes allowed without a level takes it from allowed.
 IF NEW.level IS NULL OR (TG_OP='UPDATE' AND NEW.allowed IS DISTINCT FROM OLD.allowed AND NEW.level IS NOT DISTINCT FROM OLD.level) THEN
  NEW.level:=CASE WHEN NEW.allowed IS DISTINCT FROM false THEN app.reward_role_default_level(NEW.role,NEW.capability) ELSE 'none' END;
 END IF;
 IF app.reward_role_permission_locked(NEW.role,NEW.capability) OR NOT NEW.level=ANY(app.reward_role_level_options(NEW.role,NEW.capability)) THEN
  RAISE EXCEPTION 'Fixed Rewards role permission' USING ERRCODE='42501';
 END IF;
 NEW.allowed:=NEW.level<>'none';
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_role_permission_level_shape() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_role_permission_level_shape() TO ai_hr_app;
CREATE TRIGGER reward_role_permission_level_shape BEFORE INSERT OR UPDATE ON public.reward_role_permission FOR EACH ROW EXECUTE FUNCTION app.reward_role_permission_level_shape();
--> statement-breakpoint

-- 3. Effective levels. A saved level never exceeds the default.
CREATE FUNCTION app.reward_role_level(wanted_role text,wanted_capability text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT CASE WHEN p.level IS NOT NULL AND app.reward_level_rank(p.level)<app.reward_level_rank(d.level) THEN p.level ELSE d.level END
 FROM (SELECT app.reward_role_default_level(wanted_role,wanted_capability) AS level) d
 LEFT JOIN public.reward_role_permission p ON p.tenant_id=app.current_tenant_id() AND p.role=wanted_role AND p.capability=wanted_capability
$$;
-- The current principal's level for a configuration page: the widest level among the Rewards configuration roles they
-- hold (Group Rewards, CTRO, Executive Chairman). The database setup predicate stays the outer limit.
CREATE FUNCTION app.reward_actor_page_level(wanted_capability text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce((SELECT l FROM (SELECT app.reward_role_level(r,wanted_capability) AS l FROM unnest(ARRAY['gr','ctro','ec']) r WHERE app.reward_actor_holds_role(r)) x
  ORDER BY app.reward_level_rank(l) DESC LIMIT 1),'none')
$$;
-- The current principal's level on one review: the widest level among their roles on it (a BG seat covering another
-- person reads the proxy column, as app.reward_capability does).
CREATE FUNCTION app.reward_unit_level(wanted_unit uuid,wanted_capability text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce((SELECT l FROM (SELECT app.reward_role_level(CASE WHEN assigned.role='bg' AND EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=wanted_unit AND m.tenant_id=app.current_tenant_id()
    AND m.user_id=app.current_user_id() AND m.role='bg' AND m.covers_user_id IS NOT NULL AND app.reward_member_eligible(m.id)) THEN 'proxy_bg' ELSE assigned.role END,wanted_capability) AS l
  FROM app.reward_roles(wanted_unit) AS assigned(role)) x ORDER BY app.reward_level_rank(l) DESC LIMIT 1),'none')
$$;
-- Setup authority for one configuration page: the native setup predicate AND the grid level (Full = manage,
-- View only = library_view).
CREATE FUNCTION app.reward_setup_page_allowed(wanted_company uuid,wanted_page text,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(app.reward_setup_allowed(wanted_company,wanted_operation),false)
  AND app.reward_level_rank(app.reward_actor_page_level(wanted_page))>=CASE WHEN wanted_operation='manage' THEN 3 ELSE 1 END
$$;
REVOKE ALL ON FUNCTION app.reward_role_level(text,text),app.reward_actor_page_level(text),app.reward_unit_level(uuid,text),app.reward_setup_page_allowed(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_role_level(text,text),app.reward_actor_page_level(text),app.reward_unit_level(uuid,text),app.reward_setup_page_allowed(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint

-- 4. Who may change the grid. Immediate: Group Rewards with group setup authority, HR Admin (group administrator) or a
-- whole-group CTRO, never while viewing as someone. Proposer: a company-scoped Group Rewards seat holder without
-- immediate authority; their batch waits for an immediate-authority checker who is not them.
CREATE FUNCTION app.reward_role_permission_immediate() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND coalesce(app.reward_not_viewing_as(),false) AND (coalesce(app.reward_setup_allowed(NULL,'manage'),false)
  OR coalesce(app.is_group_admin(),false) OR EXISTS(SELECT 1 FROM app.reward_current_group_roles() g(role) WHERE g.role='ctro'))
$$;
CREATE FUNCTION app.reward_role_permission_seat() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id))))
$$;
CREATE FUNCTION app.reward_role_permission_reader() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.reward_role_permission_immediate() OR app.reward_role_permission_seat()
$$;
REVOKE ALL ON FUNCTION app.reward_role_permission_immediate(),app.reward_role_permission_seat(),app.reward_role_permission_reader() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_role_permission_immediate(),app.reward_role_permission_seat(),app.reward_role_permission_reader() TO ai_hr_app;
-- The 2206 write policy (Group Rewards setup authority) stays; this one admits HR Admin and whole-group CTRO. The
-- 5400 restrictive policies still refuse a role the writer holds.
CREATE POLICY reward_role_permission_immediate_write ON public.reward_role_permission FOR ALL TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.reward_role_permission_immediate())
 WITH CHECK(tenant_id=app.current_tenant_id() AND changed_by=app.current_user_id() AND app.reward_role_permission_immediate());
--> statement-breakpoint

-- 5. One version per saved batch: the whole saved matrix after the save (cells that differ from their default), the
-- per-cell changes and the reason. The latest revision is the grid's optimistic-concurrency token.
CREATE TABLE public.reward_role_permission_version(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 revision integer NOT NULL CHECK(revision>0),
 action text NOT NULL CHECK(action IN('saved','reset','restored','approved')),
 matrix jsonb NOT NULL CHECK(jsonb_typeof(matrix)='object' AND octet_length(matrix::text)<=40000),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes) BETWEEN 1 AND 400),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 saved_by uuid NOT NULL REFERENCES public.app_user(id),
 saved_at timestamptz NOT NULL DEFAULT now(),
 restored_from integer,
 request_id uuid,
 PRIMARY KEY(tenant_id,revision),
 CHECK(restored_from IS NULL OR restored_from<revision)
);
CREATE INDEX reward_role_permission_version_recent ON public.reward_role_permission_version(tenant_id,saved_at DESC);
ALTER TABLE public.reward_role_permission_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_role_permission_version FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_role_permission_version_read ON public.reward_role_permission_version FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.reward_role_permission_reader());
CREATE POLICY reward_role_permission_version_insert ON public.reward_role_permission_version FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND saved_by=app.current_user_id() AND app.reward_role_permission_immediate());
CREATE POLICY reward_role_permission_version_owner ON public.reward_role_permission_version TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
REVOKE ALL ON public.reward_role_permission_version FROM PUBLIC;
GRANT SELECT,INSERT ON public.reward_role_permission_version TO ai_hr_app;
--> statement-breakpoint

-- 6. Batches waiting for approval. The proposer cannot decide their own batch (nor another login of the same person);
-- a batch lapses when the grid changed after it was proposed.
CREATE TABLE public.reward_role_permission_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array' AND jsonb_array_length(changes) BETWEEN 1 AND 200 AND octet_length(changes::text)<=40000),
 base_revision integer NOT NULL CHECK(base_revision>=0),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 2000),
 requested_by uuid NOT NULL REFERENCES public.app_user(id),
 requested_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','applied','rejected','lapsed')),
 decided_by uuid REFERENCES public.app_user(id),
 decided_at timestamptz,
 decision_reason text CHECK(decision_reason IS NULL OR length(btrim(decision_reason))<=2000),
 applied_revision integer,
 UNIQUE(tenant_id,id),
 CHECK((status='pending')=(decided_by IS NULL AND decided_at IS NULL)),
 CHECK(decided_by IS NULL OR decided_by<>requested_by),
 CHECK((status='applied')=(applied_revision IS NOT NULL)),
 CHECK(status<>'rejected' OR length(btrim(coalesce(decision_reason,'')))>=10)
);
CREATE INDEX reward_role_permission_request_pending ON public.reward_role_permission_request(tenant_id,requested_at DESC) WHERE status='pending';
CREATE INDEX reward_role_permission_request_recent ON public.reward_role_permission_request(tenant_id,requested_at DESC);
ALTER TABLE public.reward_role_permission_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_role_permission_request FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_role_permission_request_read ON public.reward_role_permission_request FOR SELECT TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND app.reward_role_permission_reader());
CREATE POLICY reward_role_permission_request_insert ON public.reward_role_permission_request FOR INSERT TO ai_hr_app
 WITH CHECK(tenant_id=app.current_tenant_id() AND requested_by=app.current_user_id() AND status='pending' AND app.reward_role_permission_seat()
  AND NOT app.reward_role_permission_immediate() AND coalesce(app.reward_not_viewing_as(),false));
CREATE POLICY reward_role_permission_request_decide ON public.reward_role_permission_request FOR UPDATE TO ai_hr_app
 USING(tenant_id=app.current_tenant_id() AND status='pending' AND requested_by<>app.current_user_id() AND app.reward_role_permission_immediate())
 WITH CHECK(tenant_id=app.current_tenant_id() AND decided_by=app.current_user_id() AND status IN('applied','rejected','lapsed') AND app.reward_role_permission_immediate());
CREATE POLICY reward_role_permission_request_owner ON public.reward_role_permission_request TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
REVOKE ALL ON public.reward_role_permission_request FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.reward_role_permission_request TO ai_hr_app;
-- The proposed cells follow the catalogue, never touch a role the proposer holds, and a decided request is frozen.
CREATE FUNCTION app.reward_role_permission_request_shape() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.changes) c WHERE jsonb_typeof(c)<>'object' OR app.reward_role_permission_locked(c->>'role',c->>'capability')
     OR NOT coalesce(c->>'after','')=ANY(app.reward_role_level_options(c->>'role',c->>'capability'))) THEN
   RAISE EXCEPTION 'Fixed Rewards role permission' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.changes) c WHERE app.reward_actor_holds_role(c->>'role')) THEN
   RAISE EXCEPTION 'You cannot change the permission switches for a role you hold' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.status<>'pending' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.changes<>OLD.changes OR NEW.base_revision<>OLD.base_revision
   OR NEW.reason<>OLD.reason OR NEW.requested_by<>OLD.requested_by OR NEW.requested_at<>OLD.requested_at THEN
  RAISE EXCEPTION 'A decided role permission request is final' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.app_user a JOIN public.app_user b ON b.person_id=a.person_id AND b.tenant_id=a.tenant_id
   WHERE a.id=NEW.requested_by AND b.id=NEW.decided_by AND a.person_id IS NOT NULL) THEN
  RAISE EXCEPTION 'An independent checker must decide this request' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_role_permission_request_shape() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_role_permission_request_shape() TO ai_hr_app;
CREATE TRIGGER reward_role_permission_request_shape BEFORE INSERT OR UPDATE ON public.reward_role_permission_request FOR EACH ROW EXECUTE FUNCTION app.reward_role_permission_request_shape();
--> statement-breakpoint

-- The 2206 View-as defences on the new tables.
CREATE POLICY reward_view_as_insert ON public.reward_role_permission_version AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK(app.reward_not_viewing_as());
CREATE POLICY reward_view_as_insert ON public.reward_role_permission_request AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK(app.reward_not_viewing_as());
CREATE POLICY reward_view_as_update ON public.reward_role_permission_request AS RESTRICTIVE FOR UPDATE TO PUBLIC USING(app.reward_not_viewing_as()) WITH CHECK(app.reward_not_viewing_as());
CREATE TRIGGER reward_view_as_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reward_role_permission_version FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
CREATE TRIGGER reward_view_as_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.reward_role_permission_request FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
--> statement-breakpoint

-- 7. The change-log writer (owner function from 5400) also records role-permission batches by HR Admin and
-- whole-group CTRO. Every other branch is unchanged.
CREATE OR REPLACE FUNCTION app.reward_config_change_record(p_area text,p_action text,p_item uuid,p_label text,p_companies uuid[],p_version text,p_reason text,p_high_impact boolean,p_changed integer,p_summary jsonb,p_subject_unit uuid,p_subject_entries uuid[],p_restored_from text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();actor_person uuid;result uuid;companies uuid[]:=coalesce(p_companies,'{}');allowed boolean;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) THEN RAISE EXCEPTION 'Rewards configuration change log writer required' USING ERRCODE='42501'; END IF;
 -- The actor's PERSON is recorded when the login has one; an account without a person is still the actor.
 SELECT person_id INTO actor_person FROM public.app_user WHERE id=actor AND tenant_id=t AND archived_at IS NULL;
 IF EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT EXISTS(SELECT 1 FROM public.company x WHERE x.id=c AND x.tenant_id=t)) THEN RAISE EXCEPTION 'Rewards configuration companies must be in this tenant' USING ERRCODE='42501'; END IF;
 IF p_area='access' THEN
  -- An access row records the actor's own access request that was applied without a second approval.
  allowed:=EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=p_item AND q.tenant_id=t AND q.requested_by=actor AND q.status='applied_no_second_approval');
 ELSIF p_area='group_role' THEN allowed:=coalesce(app.is_group_admin(),false);
 ELSIF p_area='role_permission' AND cardinality(companies)=0 THEN allowed:=app.reward_role_permission_immediate();
 ELSIF cardinality(companies)=0 THEN allowed:=app.reward_setup_allowed(NULL,'manage');
 ELSE allowed:=NOT EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT app.reward_setup_allowed(c,'manage'));
 END IF;
 IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'Rewards configuration authority required' USING ERRCODE='42501'; END IF;
 IF p_subject_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_subject_unit AND u.tenant_id=t) THEN RAISE EXCEPTION 'Rewards review not found' USING ERRCODE='42501'; END IF;
 INSERT INTO public.reward_config_change(tenant_id,area,action,item_id,item_label,company_ids,version_ref,actor_kind,actor_id,actor_person_id,reason,high_impact,changed_count,summary,subject_unit_id,subject_entry_ids,restored_from)
 VALUES(t,p_area,p_action,p_item,btrim(p_label),companies,p_version,'user',actor,actor_person,btrim(p_reason),coalesce(p_high_impact,false),coalesce(p_changed,0),coalesce(p_summary,'{}'::jsonb),p_subject_unit,coalesce(p_subject_entries,'{}'),p_restored_from)
 RETURNING id INTO result;
 RETURN result;
END $$;
--> statement-breakpoint

-- 8. The formerly display-only rows now narrow the server. Row security stays the outer limit; these restrictive
-- policies apply to the application role only, so purpose-owned readers (payroll posting, unit preparation,
-- setup references) keep their native contracts.
-- Salary Structures and Bonus Matrices: View only reads, Full also writes.
CREATE POLICY reward_library_role_level_read ON public.reward_library AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.reward_level_rank(app.reward_actor_page_level(kind||'.view'))>=1);
CREATE POLICY reward_library_role_level_insert ON public.reward_library AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.reward_level_rank(app.reward_actor_page_level(kind||'.view'))>=3);
CREATE POLICY reward_library_role_level_update ON public.reward_library AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.reward_level_rank(app.reward_actor_page_level(kind||'.view'))>=3) WITH CHECK(app.reward_level_rank(app.reward_actor_page_level(kind||'.view'))>=3);
CREATE POLICY reward_library_version_role_level_read ON public.reward_library_version AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=reward_library_version.library_id AND l.tenant_id=reward_library_version.tenant_id));
CREATE POLICY reward_library_version_role_level_insert ON public.reward_library_version AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=reward_library_version.library_id AND l.tenant_id=reward_library_version.tenant_id AND app.reward_level_rank(app.reward_actor_page_level(l.kind||'.view'))>=3));
CREATE POLICY reward_library_version_role_level_update ON public.reward_library_version AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=reward_library_version.library_id AND l.tenant_id=reward_library_version.tenant_id AND app.reward_level_rank(app.reward_actor_page_level(l.kind||'.view'))>=3))
 WITH CHECK(EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=reward_library_version.library_id AND l.tenant_id=reward_library_version.tenant_id AND app.reward_level_rank(app.reward_actor_page_level(l.kind||'.view'))>=3));
-- PAT Inputs and the Shared Rewards Configuration plans: writes need Full. Their readers keep the native predicate
-- (released reviews read their bound versions); the pages and menus check the same level.
CREATE POLICY reward_pat_role_level_insert ON public.reward_pat_version AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.reward_level_rank(app.reward_actor_page_level('pat.manage'))>=3);
CREATE POLICY reward_pat_role_level_update ON public.reward_pat_version AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.reward_level_rank(app.reward_actor_page_level('pat.manage'))>=3) WITH CHECK(app.reward_level_rank(app.reward_actor_page_level('pat.manage'))>=3);
CREATE POLICY reward_plan_setup_role_level_insert ON public.reward_plan_setup AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.reward_level_rank(app.reward_actor_page_level('plans.manage'))>=3);
CREATE POLICY reward_plan_setup_role_level_update ON public.reward_plan_setup AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.reward_level_rank(app.reward_actor_page_level('plans.manage'))>=3) WITH CHECK(app.reward_level_rank(app.reward_actor_page_level('plans.manage'))>=3);
-- Senior plan amounts: View only reads, Full also writes (Group Rewards). The payroll post reader is unchanged.
CREATE POLICY reward_senior_award_role_level_read ON public.reward_senior_award AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=1);
CREATE POLICY reward_senior_award_role_level_insert ON public.reward_senior_award AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=3);
CREATE POLICY reward_senior_award_role_level_update ON public.reward_senior_award AS RESTRICTIVE FOR UPDATE TO ai_hr_app
 USING(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=3) WITH CHECK(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=3);
CREATE POLICY reward_senior_award_role_level_delete ON public.reward_senior_award AS RESTRICTIVE FOR DELETE TO ai_hr_app
 USING(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=3);
CREATE POLICY reward_senior_evidence_role_level_read ON public.reward_senior_evidence AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=1);
CREATE POLICY reward_senior_evidence_role_level_insert ON public.reward_senior_evidence AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK(app.reward_level_rank(app.reward_unit_level(unit_id,'senior.manage'))>=3);
