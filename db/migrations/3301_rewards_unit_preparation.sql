-- a24cb308: governance remains the preparation owner. Existing exposed reviews keep legacy
-- visibility, without inventing a checker or confirmations. New annual reviews require release.
ALTER TABLE public.reward_unit ADD COLUMN preparation_required boolean NOT NULL DEFAULT false;
ALTER TABLE public.reward_unit ALTER COLUMN preparation_required SET DEFAULT true;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_reader') THEN
  CREATE ROLE ai_hr_reward_preparation_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)) THEN
  RAISE EXCEPTION 'Unsafe preparation reader';
 END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_reward_preparation_reader;
GRANT SELECT(id,tenant_id,kind,deleted_at,preparation_required,company_id,business_unit_id) ON public.reward_unit TO ai_hr_reward_preparation_reader;
GRANT SELECT(unit_id,tenant_id,state) ON public.reward_governance TO ai_hr_reward_preparation_reader;
CREATE POLICY reward_preparation_unit_read ON public.reward_unit FOR SELECT TO ai_hr_reward_preparation_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_preparation_governance_read ON public.reward_governance FOR SELECT TO ai_hr_reward_preparation_reader USING(tenant_id=app.current_tenant_id());
GRANT SELECT(unit_id,tenant_id,salary_version_id,bonus_version_id) ON public.reward_unit_setup TO ai_hr_reward_preparation_reader;
GRANT SELECT(id,tenant_id,library_id,revision,state) ON public.reward_library_version TO ai_hr_reward_preparation_reader;
GRANT SELECT(id,tenant_id,name) ON public.reward_library TO ai_hr_reward_preparation_reader;
GRANT EXECUTE ON FUNCTION app.reward_policy_unit_origin(uuid) TO ai_hr_reward_preparation_reader;
CREATE POLICY reward_preparation_setup_read ON public.reward_unit_setup FOR SELECT TO ai_hr_reward_preparation_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_preparation_version_read ON public.reward_library_version FOR SELECT TO ai_hr_reward_preparation_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_preparation_library_read ON public.reward_library FOR SELECT TO ai_hr_reward_preparation_reader USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- Preserve the current native role source (including dated proxies and group grants) privately.
-- Replacing reward_roles in place retains its OID, so pre-existing bounded readers inherit withholding.
DO $$ DECLARE definition text; original_owner name; BEGIN
 SELECT pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner) INTO definition,original_owner
 FROM pg_proc p WHERE p.oid='app.reward_roles(uuid)'::regprocedure;
 IF position('reward_roles_preparation_audience' in definition)>0 THEN RAISE EXCEPTION 'Preparation audience already installed'; END IF;
 definition:=replace(definition,'app.reward_roles(', 'app.reward_roles_preparation_audience(');
 EXECUTE definition;
 EXECUTE format('ALTER FUNCTION app.reward_roles_preparation_audience(uuid) OWNER TO %I',original_owner);
 REVOKE ALL ON FUNCTION app.reward_roles_preparation_audience(uuid) FROM PUBLIC,ai_hr_app;
 EXECUTE format('GRANT EXECUTE ON FUNCTION app.reward_roles_preparation_audience(uuid) TO %I',original_owner);
 GRANT EXECUTE ON FUNCTION app.reward_roles_preparation_audience(uuid) TO ai_hr_reward_preparation_reader;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.reward_preparation_released(p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit u LEFT JOIN public.reward_governance g
 ON g.unit_id=u.id AND g.tenant_id=u.tenant_id WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id()
 AND u.deleted_at IS NULL AND (u.kind<>'annual' OR NOT u.preparation_required OR g.state->'preparation'->>'state'='released'))
$$;
ALTER FUNCTION app.reward_preparation_released(uuid) OWNER TO ai_hr_reward_preparation_reader;
REVOKE ALL ON FUNCTION app.reward_preparation_released(uuid) FROM PUBLIC,ai_hr_app;
DO $$ DECLARE original_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO original_owner FROM pg_proc WHERE oid='app.reward_roles(uuid)'::regprocedure;
 EXECUTE format('GRANT EXECUTE ON FUNCTION app.reward_preparation_released(uuid) TO %I',original_owner);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 SELECT role FROM app.reward_roles_preparation_audience(wanted_unit) AS assigned(role)
 WHERE role IN('gr','ctro','ec') OR app.reward_preparation_released(wanted_unit)
$$;
-- Creator/admin metadata visibility must not expose the policy of a still-preparing review.
CREATE POLICY reward_preparation_unit_withholding ON public.reward_unit AS RESTRICTIVE FOR SELECT TO ai_hr_app
 USING(kind<>'annual' OR NOT preparation_required OR EXISTS(SELECT 1 FROM app.reward_roles(id)));
--> statement-breakpoint
-- Small personnel/audit projection under the existing native source owner. It admits only a
-- currently assigned preparation audience and returns no employment/pay fields or other events.
CREATE FUNCTION app.reward_preparation_context(p_unit uuid,p_preparation jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE roles text[]; actor_person uuid; g jsonb:=p_preparation; actors jsonb; history jsonb;
BEGIN
 roles:=ARRAY(SELECT app.reward_roles_preparation_audience(p_unit));
 IF cardinality(roles)=0 THEN RETURN NULL; END IF;
 SELECT person_id INTO actor_person FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 IF roles && ARRAY['gr','ctro','ec'] THEN
  SELECT coalesce(jsonb_object_agg(p.id::text,p.full_name),'{}'::jsonb) INTO actors FROM public.person p
   WHERE p.tenant_id=app.current_tenant_id() AND p.id IN(SELECT (value->>'actorPersonId')::uuid FROM jsonb_each(coalesce(g->'steps','{}'::jsonb)));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',h.id,'kind',h.kind,'reason',h.reason,'actorName',p.full_name,'at',h.at) ORDER BY h.at DESC,h.id DESC),'[]'::jsonb) INTO history
  FROM (SELECT id,kind,reason,actor_id,created_at AS at FROM public.reward_governance_history
    WHERE unit_id=p_unit AND tenant_id=app.current_tenant_id() AND kind LIKE 'preparation-%'
    UNION ALL SELECT id,'preparation-invalidated','source-changed',actor_id,occurred_at FROM public.domain_event
    WHERE aggregate_id=p_unit AND tenant_id=app.current_tenant_id() AND aggregate_type='reward-unit' AND event_type='reward-unit.preparation-invalidated') h
  LEFT JOIN public.app_user a ON a.id=h.actor_id AND a.tenant_id=app.current_tenant_id()
  LEFT JOIN public.person p ON p.id=a.person_id AND p.tenant_id=a.tenant_id;
 END IF;
 RETURN jsonb_build_object('personId',actor_person,'actorNames',coalesce(actors,'{}'::jsonb),'history',coalesce(history,'[]'::jsonb));
END $$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_roles_preparation_audience(uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_preparation_context(uuid,jsonb) OWNER TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_context(uuid,jsonb) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_preparation_context(uuid,jsonb) TO ai_hr_reward_preparation_reader;
--> statement-breakpoint
-- A waiting notice preserves the existing native page matrix, live role overrides and dated
-- personal exceptions, even though ordinary reward_unit RLS intentionally withholds the raw row.
CREATE FUNCTION app.reward_preparation_audience_allowed(p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM app.reward_roles_preparation_audience(u.id) AS assigned(role)
  WHERE app.reward_role_native_capability(assigned.role,'review.view') AND (
   coalesce((SELECT allowed FROM public.reward_role_permission p WHERE p.tenant_id=u.tenant_id
    AND p.role=CASE WHEN assigned.role='bg' AND EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=u.id AND m.tenant_id=u.tenant_id
     AND m.user_id=app.current_user_id() AND m.role='bg' AND m.covers_user_id IS NOT NULL AND app.reward_member_eligible_internal(m.id)) THEN 'proxy_bg' ELSE assigned.role END
    AND p.capability='review.view'),true)
   OR EXISTS(SELECT 1 FROM public.reward_page_grant g WHERE g.tenant_id=u.tenant_id AND g.company_id=u.company_id
    AND g.user_id=app.current_user_id() AND g.capability='review.view' AND g.active
    AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)))))
$$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_roles_preparation_audience(uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_preparation_audience_allowed(uuid) OWNER TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_audience_allowed(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_preparation_audience_allowed(uuid) TO ai_hr_reward_preparation_reader;
--> statement-breakpoint
CREATE FUNCTION app.reward_preparation_view(p_unit uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
DECLARE u record; g jsonb; full_state jsonb; roles text[]; privileged boolean; actors jsonb; actor_person uuid; independent boolean; bindings jsonb; origin jsonb; history jsonb; identity jsonb;
BEGIN
 roles:=ARRAY(SELECT app.reward_roles_preparation_audience(p_unit));
 IF cardinality(roles)=0 OR NOT app.reward_preparation_audience_allowed(p_unit) THEN RETURN NULL; END IF;
 SELECT id,kind,preparation_required INTO u FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT state INTO full_state FROM public.reward_governance WHERE unit_id=p_unit AND tenant_id=app.current_tenant_id();
 g:=full_state->'preparation';
 privileged:=roles && ARRAY['gr','ctro','ec'];
 identity:=app.reward_preparation_context(p_unit,g);actor_person:=(identity->>'personId')::uuid;
 actors:=identity->'actorNames';history:=identity->'history';
 independent:=actor_person IS NOT NULL AND 'gr'=ANY(roles) AND NOT EXISTS(SELECT 1
 FROM jsonb_each(coalesce(g->'steps','{}'::jsonb)) proof
 WHERE proof.value->>'actorPersonId' IS NULL OR (proof.value->>'actorPersonId')::uuid=actor_person);
 IF privileged THEN
  SELECT jsonb_build_object('salary',jsonb_build_object('name',sl.name,'version',sv.revision,'confirmed',sv.state='confirmed'),
   'bonus',jsonb_build_object('name',bl.name,'version',bv.revision,'confirmed',bv.state='confirmed')) INTO bindings
  FROM public.reward_unit_setup us JOIN public.reward_library_version sv ON sv.id=us.salary_version_id AND sv.tenant_id=us.tenant_id
  JOIN public.reward_library sl ON sl.id=sv.library_id AND sl.tenant_id=sv.tenant_id
  JOIN public.reward_library_version bv ON bv.id=us.bonus_version_id AND bv.tenant_id=us.tenant_id
  JOIN public.reward_library bl ON bl.id=bv.library_id AND bl.tenant_id=bv.tenant_id
  WHERE us.unit_id=p_unit AND us.tenant_id=app.current_tenant_id();
  origin:=app.reward_policy_unit_origin(p_unit);

 END IF;
 RETURN jsonb_build_object('unitId',u.id,'required',u.kind='annual' AND u.preparation_required,
  'released',app.reward_preparation_released(p_unit),'setupVisible',privileged,'isGr','gr'=ANY(roles),
  'expectedRelease',g->'expectedRelease','preparation',CASE WHEN privileged THEN g ELSE NULL END,
  'personId',actor_person,'namedDoer',actor_person IS NOT NULL AND 'gr'=ANY(roles),'independentChecker',independent,
  'history',CASE WHEN privileged THEN coalesce(history,'[]'::jsonb) ELSE '[]'::jsonb END,
  'applied',CASE WHEN privileged THEN bindings ELSE NULL END,'origin',CASE WHEN privileged THEN origin ELSE NULL END,
  'stateForSetup',CASE WHEN privileged THEN (full_state-'awards')||jsonb_build_object('awards','{}'::jsonb) ELSE NULL END,
  'actorNames',CASE WHEN privileged THEN coalesce(actors,'{}'::jsonb) ELSE '{}'::jsonb END);
END $$;
ALTER FUNCTION app.reward_preparation_view(uuid) OWNER TO ai_hr_reward_preparation_reader;
REVOKE ALL ON FUNCTION app.reward_preparation_view(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_preparation_view(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_preparation_compatibility_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.acting_as_owner() AND ((TG_OP='INSERT' AND NEW.kind='annual' AND NOT NEW.preparation_required)
  OR (TG_OP='UPDATE' AND OLD.preparation_required AND NOT NEW.preparation_required)) THEN
  RAISE EXCEPTION 'New annual reviews require independently checked preparation';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_compatibility_guard() FROM PUBLIC;
CREATE TRIGGER reward_preparation_compatibility_guard BEFORE INSERT OR UPDATE OF preparation_required ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_preparation_compatibility_guard();
--> statement-breakpoint
CREATE FUNCTION app.reward_preparation_check_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE before_state jsonb; before_p jsonb; after_p jsonb:=NEW.state->'preparation'; step text; proof jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN before_state:=OLD.state;
 ELSE SELECT state INTO before_state FROM public.reward_governance WHERE unit_id=NEW.unit_id AND tenant_id=NEW.tenant_id FOR UPDATE; END IF;
 before_p:=before_state->'preparation';
 IF after_p IS NOT DISTINCT FROM before_p THEN
  IF before_p->>'state'='released' AND (NEW.state-'preparation') IS DISTINCT FROM (before_state-'preparation') THEN
   RAISE EXCEPTION 'Request a controlled change before editing released unit set-up';
  END IF;
  RETURN NEW;
 END IF;
 IF after_p IS NULL OR after_p->>'version' IS DISTINCT FROM '1' OR after_p->>'state' IS NULL OR after_p->>'state' NOT IN('preparing','released') THEN
  RAISE EXCEPTION 'A valid preparation state is required';
 END IF;
 IF after_p->>'state'='released' THEN
  IF NOT coalesce((app.reward_preparation_view(NEW.unit_id)->>'independentChecker')::boolean,false) THEN
   RAISE EXCEPTION 'A different Group Rewards person must check the preparation';
  END IF;
  IF before_p->>'state' IS DISTINCT FROM 'preparing' OR after_p->'steps' IS DISTINCT FROM before_p->'steps'
   OR after_p->>'releasedBy' IS DISTINCT FROM app.current_user_id()::text
   OR after_p->>'releasedByPersonId' IS NULL OR after_p->>'releasedByPersonId' IS DISTINCT FROM (app.reward_preparation_view(NEW.unit_id)->>'personId')
   OR after_p->>'expectedRelease' IS NULL OR after_p->>'releaseBasis' IS NULL OR after_p->>'releaseBasis' !~ '^[0-9a-f]{64}$'
   OR after_p->>'releasedAt' IS NULL THEN RAISE EXCEPTION 'Independent current preparation release required'; END IF;
  FOREACH step IN ARRAY ARRAY['snapshot','data','excluded','senior','budget','applied'] LOOP
   proof:=after_p->'steps'->step;
   IF proof IS NULL OR proof->>'basis' IS DISTINCT FROM after_p->>'releaseBasis'
    OR proof->>'actorId' IS NULL OR proof->>'actorId'=app.current_user_id()::text THEN
    RAISE EXCEPTION 'Every current preparation step needs a different doer from the release checker';
   END IF;
  END LOOP;
 ELSIF before_p->>'state'='released' AND length(trim(coalesce(after_p->>'changeReason','')))<10 THEN
  RAISE EXCEPTION 'A reason is required to reopen released preparation';
 END IF;
 FOREACH step IN ARRAY ARRAY['snapshot','data','excluded','senior','budget','applied'] LOOP
  proof:=after_p->'steps'->step;
  IF proof IS NOT NULL AND proof IS DISTINCT FROM before_p->'steps'->step
   AND (proof->>'actorId' IS DISTINCT FROM app.current_user_id()::text
    OR proof->>'actorPersonId' IS NULL OR proof->>'actorPersonId' IS DISTINCT FROM (app.reward_preparation_view(NEW.unit_id)->>'personId') OR proof->>'basis' IS NULL OR proof->>'basis' !~ '^[0-9a-f]{64}$') THEN
   RAISE EXCEPTION 'The current doer must confirm the preparation evidence';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_check_guard() FROM PUBLIC;
CREATE TRIGGER reward_preparation_check_guard BEFORE INSERT OR UPDATE OF state ON public.reward_governance
 FOR EACH ROW EXECUTE FUNCTION app.reward_preparation_check_guard();
--> statement-breakpoint
-- Native confidentiality/source owners may change facts without a set-up form. Withdraw release
-- atomically and clear the approval digest; never leave old checklist evidence authorizing new facts.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_invalidator') THEN
  CREATE ROLE ai_hr_reward_preparation_invalidator NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_preparation_invalidator' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)) THEN RAISE EXCEPTION 'Unsafe preparation invalidator'; END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_reward_preparation_invalidator;
GRANT EXECUTE ON FUNCTION app.reward_preparation_view(uuid) TO ai_hr_reward_preparation_invalidator;
GRANT EXECUTE ON FUNCTION app.teras_loop_attribution() TO ai_hr_reward_preparation_invalidator;
GRANT SELECT(id,tenant_id,status,kind,deleted_at,preparation_required),UPDATE(approved_digest,updated_at) ON public.reward_unit TO ai_hr_reward_preparation_invalidator;
GRANT SELECT(unit_id,tenant_id,state),UPDATE(state,updated_at) ON public.reward_governance TO ai_hr_reward_preparation_invalidator;
GRANT INSERT(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) ON public.domain_event TO ai_hr_reward_preparation_invalidator;
DO $$ DECLARE sequence_name text; BEGIN
 sequence_name:=pg_get_serial_sequence('public.domain_event','sequence');
 IF sequence_name IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO ai_hr_reward_preparation_invalidator',sequence_name); END IF;
END $$;
CREATE POLICY reward_preparation_invalidate_unit ON public.reward_unit FOR ALL TO ai_hr_reward_preparation_invalidator
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY reward_preparation_invalidate_state ON public.reward_governance FOR ALL TO ai_hr_reward_preparation_invalidator
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY reward_preparation_invalidate_event ON public.domain_event FOR INSERT TO ai_hr_reward_preparation_invalidator
 WITH CHECK(tenant_id=app.current_tenant_id() AND aggregate_type='reward-unit' AND event_type='reward-unit.preparation-invalidated'
 AND actor_id IS NOT DISTINCT FROM app.current_user_id() AND actor_type::text=CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END);
CREATE FUNCTION app.reward_preparation_source_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
DECLARE u record; g jsonb; changed_unit uuid; changed_tenant uuid; subject uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.source IS NOT DISTINCT FROM OLD.source AND NEW.facts IS NOT DISTINCT FROM OLD.facts THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN changed_unit:=OLD.unit_id;changed_tenant:=OLD.tenant_id;subject:=OLD.employment_id;
 ELSE changed_unit:=NEW.unit_id;changed_tenant:=NEW.tenant_id;subject:=NEW.employment_id; END IF;
 SELECT id,status,preparation_required INTO u FROM public.reward_unit WHERE id=changed_unit AND tenant_id=changed_tenant AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT u.preparation_required OR u.status IN('posted','withdrawn','rejected') THEN RETURN NULL; END IF;
 SELECT state INTO g FROM public.reward_governance WHERE unit_id=changed_unit AND tenant_id=changed_tenant FOR UPDATE;
 IF g->'preparation'->>'state' IS DISTINCT FROM 'released' THEN RETURN NULL; END IF;
 g:=jsonb_set(g,'{preparation}',(g->'preparation')||jsonb_build_object('state','preparing','steps','{}'::jsonb,
  'releasedBy',NULL,'releasedByPersonId',NULL,'releasedAt',NULL,'releaseBasis',NULL,'changeReason','Source evidence or classification changed after release'));
 UPDATE public.reward_governance SET state=g,updated_at=now() WHERE unit_id=changed_unit AND tenant_id=changed_tenant;
 UPDATE public.reward_unit SET approved_digest=NULL,updated_at=now() WHERE id=changed_unit AND tenant_id=changed_tenant;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(changed_tenant,'reward-unit',changed_unit,'reward-unit.preparation-invalidated',
  (CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)::public.actor_type,app.current_user_id(),subject,jsonb_build_object('to',u.status,'reason','source-changed'));
 RETURN NULL;
END $$;
ALTER FUNCTION app.reward_preparation_source_changed() OWNER TO ai_hr_reward_preparation_invalidator;
REVOKE ALL ON FUNCTION app.reward_preparation_source_changed() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER reward_preparation_source_changed AFTER INSERT OR UPDATE OF source,facts OR DELETE ON public.reward_entry
 FOR EACH ROW EXECUTE FUNCTION app.reward_preparation_source_changed();

--> statement-breakpoint
-- Inspection seats remain visible during preparation, but no seat may advance an unchecked review.
CREATE FUNCTION app.reward_preparation_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.kind<>'annual' OR NOT NEW.preparation_required OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 IF NEW.status IN('withdrawn','rejected') OR coalesce((app.reward_preparation_view(NEW.id)->>'released')::boolean,false) THEN RETURN NEW; END IF;
 IF NEW.status='draft' AND OLD.status NOT IN('posted','withdrawn','rejected') THEN
  IF 'gr'=ANY(ARRAY(SELECT app.reward_roles(NEW.id))) AND EXISTS(
   SELECT 1 FROM public.reward_governance_history h WHERE h.unit_id=NEW.id AND h.tenant_id=NEW.tenant_id
   AND h.kind='preparation-reopen' AND h.actor_id=app.current_user_id() AND length(trim(h.reason))>=10
   AND h.xmin=pg_current_xact_id()::xid) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A current reasoned Group Rewards change is required to restart preparation';
 END IF;
 IF NOT coalesce((app.reward_preparation_view(NEW.id)->>'released')::boolean,false) THEN
  RAISE EXCEPTION 'Preparation must be independently checked and released before a review decision';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_decision_guard() FROM PUBLIC;
CREATE TRIGGER reward_preparation_decision_guard BEFORE UPDATE OF status ON public.reward_unit
 FOR EACH ROW EXECUTE FUNCTION app.reward_preparation_decision_guard();
--> statement-breakpoint
-- Preparing reviewers need a discoverable notice, while reward_unit/entry RLS withholds financial data.
CREATE FUNCTION app.reward_preparation_notices() RETURNS TABLE("unitId" uuid,"companyId" uuid,company text,unit text,cycle text,"expectedRelease" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE candidate record; notice jsonb;
BEGIN
 FOR candidate IN SELECT u.id,u.company_id,c.legal_name,b.name AS unit_name,cy.name AS cycle_name
  FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id
  JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
  JOIN public.reward_cycle cy ON cy.id=u.cycle_id AND cy.tenant_id=u.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND u.kind='annual' AND u.preparation_required
  ORDER BY c.legal_name,b.name,cy.name,u.id
 LOOP
  notice:=app.reward_preparation_view(candidate.id);
  IF notice IS NOT NULL AND NOT (notice->>'released')::boolean AND NOT (notice->>'setupVisible')::boolean THEN
   "unitId":=candidate.id;"companyId":=candidate.company_id;company:=candidate.legal_name;unit:=candidate.unit_name;cycle:=candidate.cycle_name;"expectedRelease":=notice->>'expectedRelease';RETURN NEXT;
  END IF;
 END LOOP;
END $$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_roles_preparation_audience(uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_preparation_notices() OWNER TO %I',native_owner);
 EXECUTE format('GRANT EXECUTE ON FUNCTION app.reward_preparation_view(uuid) TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_notices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_preparation_notices() TO ai_hr_app;

--> statement-breakpoint
-- Preparation changes may return an approval-stage review to draft. Resolve the recorded stage's
-- CURRENT eligible holders without the normal routed-notice requirement r.status=wanted_stage.
CREATE FUNCTION app.reward_preparation_notification_recipients(wanted_unit uuid,wanted_stage text,wanted_released boolean) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT DISTINCT e.id FROM public.reward_unit r
 JOIN public.app_user u ON u.tenant_id=r.tenant_id AND u.person_id IS NOT NULL
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=r.tenant_id
 CROSS JOIN (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today) d
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL
 AND app.is_admin() AND (app.current_user_id() IS NULL OR app.reward_admin(r.company_id))
 AND app.reward_preparation_released(r.id)=wanted_released
 AND wanted_stage IN('draft','bg','gr','ctro','ec','approved')
 AND u.archived_at IS NULL AND NOT app.login_blocked_on(u.id,d.today)
 AND e.hired_on<=d.today AND e.blacklisted_at IS NULL
 AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR d.today<=least(e.resignation_date,e.last_working_date,e.terminated_on))
 AND (EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=r.tenant_id AND m.unit_id=r.id AND m.user_id=u.id
  AND m.role=CASE WHEN wanted_stage='draft' THEN 'bu' WHEN wanted_stage='approved' THEN 'payroll' ELSE wanted_stage END
  AND (e.company_id=r.company_id OR m.role IN('gr','ctro','ec')) AND app.reward_member_eligible_internal(m.id))
 OR EXISTS(SELECT 1 FROM public.reward_group_role_grant g WHERE g.tenant_id=r.tenant_id AND g.user_id=u.id
  AND g.role=wanted_stage AND g.active AND app.reward_group_person_eligible(g.user_id)))
$$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_roles_preparation_audience(uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_preparation_notification_recipients(uuid,text,boolean) OWNER TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_preparation_notification_recipients(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_preparation_notification_recipients(uuid,text,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Access maintenance needs review identity and routing state, never financial policy or entries.
-- Retain its original native scope owner while raw preparing reviews remain withheld.
CREATE FUNCTION app.reward_maintenance_units(p_unit uuid,p_admin_only boolean DEFAULT false)
RETURNS TABLE(id uuid,tenant_id uuid,company_id uuid,business_unit_id uuid,cycle_id uuid,kind text,status text,revision integer,deleted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 SELECT u.id,u.tenant_id,u.company_id,u.business_unit_id,u.cycle_id,u.kind::text,u.status::text,u.revision,u.deleted_at
 FROM public.reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND(p_unit IS NULL OR u.id=p_unit)
 AND((u.deleted_at IS NULL AND app.reward_access_scope(u.id)) OR(p_admin_only AND app.reward_admin(u.company_id)))
 AND(NOT p_admin_only OR app.reward_admin(u.company_id))
$$;
CREATE FUNCTION app.reward_maintenance_delete(p_unit uuid,p_revision integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
DECLARE u public.reward_unit; refusal text;
BEGIN
 SELECT * INTO u FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','missing'); END IF;
 IF NOT app.reward_admin(u.company_id) THEN RETURN jsonb_build_object('error','scope'); END IF;
 IF u.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('alreadyDeleted',true); END IF;
 IF u.revision<>p_revision THEN RETURN jsonb_build_object('error','changed'); END IF;
 refusal:=app.reward_deletion_reason(u.id);
 IF refusal IS NOT NULL THEN RETURN jsonb_build_object('error','used'); END IF;
 UPDATE public.reward_unit SET deleted_at=now(),deleted_by=app.current_user_id(),revision=revision+1,updated_at=now() WHERE id=u.id AND tenant_id=u.tenant_id;
 RETURN jsonb_build_object('alreadyDeleted',false,'cycleId',u.cycle_id,'revision',u.revision+1);
END $$;
DO $$ DECLARE native_owner name; BEGIN
 SELECT pg_get_userbyid(proowner) INTO native_owner FROM pg_proc WHERE oid='app.reward_roles_preparation_audience(uuid)'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.reward_maintenance_units(uuid,boolean) OWNER TO %I',native_owner);
 EXECUTE format('ALTER FUNCTION app.reward_maintenance_delete(uuid,integer) OWNER TO %I',native_owner);
END $$;
REVOKE ALL ON FUNCTION app.reward_maintenance_units(uuid,boolean),app.reward_maintenance_delete(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_maintenance_units(uuid,boolean),app.reward_maintenance_delete(uuid,integer) TO ai_hr_app;
