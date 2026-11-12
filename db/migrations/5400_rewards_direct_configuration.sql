-- Board item 60f1fdcd (docs/adr/2026-11-12-rewards-direct-configuration.md). DRAFT block 5400-5419; the integrator
-- renumbers at admission. Rewards configuration is saved directly by the accountable configuration editor: the
-- second-person confirmation of libraries, company PAT, plans and the unit set-up release is retired. Control comes
-- from the server-computed summary and reason on high-impact changes, the append-only change log below and the notice
-- to co-administrators.
--
-- Purpose-owned definers are NOT replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9). Where a purpose-owned trigger
-- function carried the independence rule (app.reward_setup_identity_guard), the trigger is re-pointed at an
-- owner function with the same identity stamping and no independence refusal; the purpose function stays as
-- installed. Three independence rules live inside purpose-owned definers the migration owner cannot replace and are
-- deliberately left as installed (the ADR records them as an owner decision): review creation by the plan activator
-- (app.reward_create_planned_unit), uploaded-award activation by the uploader (app.reward_uploaded_binding) and the
-- Group Rewards-only authority predicate app.reward_setup_allowed (CTRO and HR Admin widening).
--
-- Legacy pending items keep their stored state: 'pending' now reads as Draft and its editor may make it active in
-- one step. Each one gets a system change-log row so its history explains the change.
--
-- Rollback (manual, only if never relied upon): restore 2203/2204/2205/3701 trigger bindings, functions and the three
-- dropped CHECK constraints, then DROP the reward_config_change table and the functions created below.

-- 1. The identity CHECKs that forbade the maker from activating their own version.
DO $drop$
DECLARE found integer; c record;
BEGIN
 FOR c IN SELECT * FROM (VALUES
   ('public.reward_library_version'::regclass,'%confirmed_by = ANY (contributor_ids)%'),
   ('public.reward_pat_version'::regclass,'%confirmed_by <> created_by%'),
   ('public.reward_plan_setup'::regclass,'%approved_by = ANY (contributor_ids)%')) AS x(rel,pattern)
 LOOP
  SELECT count(*) INTO found FROM pg_catalog.pg_constraint WHERE conrelid=c.rel AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) LIKE c.pattern;
  IF found<>1 THEN RAISE EXCEPTION 'Expected one maker-checker constraint on %, found %',c.rel,found; END IF;
  EXECUTE (SELECT format('ALTER TABLE %s DROP CONSTRAINT %I',c.rel,conname) FROM pg_catalog.pg_constraint
   WHERE conrelid=c.rel AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) LIKE c.pattern);
 END LOOP;
END $drop$;
--> statement-breakpoint

-- 2. Library and PAT version rules. Confirmed versions stay immutable. Activation is its own statement on the exact
-- saved version, by the current editor, from Draft or a legacy pending version. A PAT working version (state
-- 'pending', shown as Draft) may be edited until it is made active.
CREATE OR REPLACE FUNCTION app.reward_setup_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_library_version' THEN
  IF OLD.state='confirmed' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.library_id<>OLD.library_id OR NEW.revision<>OLD.revision OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Confirmed library versions and identities are immutable'; END IF;
  IF NEW.state='confirmed' AND(OLD.state NOT IN('draft','pending') OR NEW.data IS DISTINCT FROM OLD.data OR NEW.reason<>OLD.reason OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids OR NEW.confirmed_by IS DISTINCT FROM app.current_user_id()) THEN RAISE EXCEPTION 'Make the exact saved library version active'; END IF;
  IF NEW.state<>'confirmed' THEN NEW.contributor_ids=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_ids||ARRAY[app.current_user_id()]) x);END IF;
 ELSIF TG_TABLE_NAME='reward_pat_version' THEN
  IF OLD.state='confirmed' OR NEW.company_id<>OLD.company_id OR NEW.year<>OLD.year OR NEW.revision<>OLD.revision OR NEW.created_by<>OLD.created_by OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'PAT versions are immutable; create a successor proposal'; END IF;
  IF NEW.state='confirmed' AND(NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.reason<>OLD.reason OR NEW.confirmed_by IS DISTINCT FROM app.current_user_id()) THEN RAISE EXCEPTION 'Make the exact saved PAT draft active'; END IF;
 ELSIF TG_TABLE_NAME='reward_setup_grant' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.user_id AND tenant_id=NEW.tenant_id) OR NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Setup grants must remain in their tenant';END IF;
 END IF;RETURN NEW;
END $$;
--> statement-breakpoint
DROP POLICY reward_pat_check ON public.reward_pat_version;
CREATE POLICY reward_pat_edit ON public.reward_pat_version FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage') AND state='pending')
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage') AND(state='pending' OR state='confirmed' AND confirmed_by=app.current_user_id()));
--> statement-breakpoint

-- 3. Plan setup: the editor activates the exact saved plan from Draft or legacy pending.
CREATE OR REPLACE FUNCTION app.reward_plan_setup_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF OLD.state='approved' OR NEW.tenant_id<>OLD.tenant_id OR NEW.version_id<>OLD.version_id OR NEW.group_id<>OLD.group_id OR NEW.year<>OLD.year OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Approved setup is immutable; create a shared configuration successor';END IF;
 IF NEW.state='approved' AND(OLD.state NOT IN('draft','pending') OR NEW.bindings IS DISTINCT FROM OLD.bindings OR NEW.company_ids IS DISTINCT FROM OLD.company_ids OR NEW.cycle_name<>OLD.cycle_name OR NEW.snapshot_date<>OLD.snapshot_date OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids OR NEW.approved_by IS DISTINCT FROM app.current_user_id()) THEN RAISE EXCEPTION 'Make the exact saved setup active';END IF;
 IF NEW.state<>'approved' THEN NEW.contributor_ids=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_ids||ARRAY[app.current_user_id()])x);END IF;RETURN NEW;
END $$;
--> statement-breakpoint

-- 4. Identity stamping without the independence refusal. Same PERSON snapshots, lineage and immutability as
-- 2205's app.reward_setup_identity_guard, which stays installed but unbound.
CREATE FUNCTION app.reward_config_identity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor_person uuid;source_person uuid;prior_people uuid[]:='{}';prior_version uuid;
BEGIN
 SELECT person_id INTO actor_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL;
 IF actor_person IS NULL THEN RAISE EXCEPTION 'A person-backed Rewards configuration account is required' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='reward_pat_version' THEN
  IF TG_OP='INSERT' THEN NEW.created_by_person_id:=actor_person;
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN RAISE EXCEPTION 'PAT maker identity is immutable';END IF;
   IF NEW.state='confirmed' THEN NEW.confirmed_by_person_id:=actor_person;NEW.confirmed_at:=transaction_timestamp();END IF;
  END IF;
 ELSIF TG_TABLE_NAME='reward_library_version' THEN
  IF TG_OP='INSERT' THEN NEW.created_by_person_id:=actor_person;NEW.contributor_person_ids:=ARRAY[actor_person];
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN RAISE EXCEPTION 'Library maker identity is immutable';END IF;
   IF NEW.state='confirmed' THEN NEW.confirmed_by_person_id:=actor_person;NEW.contributor_person_ids:=OLD.contributor_person_ids;
   ELSE NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_person_ids||ARRAY[actor_person])x);END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   SELECT a.person_id INTO source_person FROM reward_policy_group_version v JOIN app_user a ON a.id=v.created_by AND a.tenant_id=v.tenant_id WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id;
   IF source_person IS NULL THEN RAISE EXCEPTION 'A linked shared-plan maker identity is required';END IF;
   prior_version:=NEW.previous_plan_version_id;
   IF prior_version IS NULL THEN SELECT p.version_id INTO prior_version FROM reward_plan_setup p JOIN reward_policy_group_version v ON v.id=p.version_id AND v.tenant_id=p.tenant_id WHERE p.tenant_id=NEW.tenant_id AND p.group_id=NEW.group_id ORDER BY v.revision DESC LIMIT 1;END IF;
   IF prior_version IS NOT NULL THEN SELECT contributor_person_ids INTO prior_people FROM reward_plan_setup WHERE tenant_id=NEW.tenant_id AND version_id=prior_version;IF prior_people IS NULL THEN RAISE EXCEPTION 'Prior plan identity snapshot is unavailable';END IF;NEW.previous_plan_version_id:=prior_version;END IF;
   NEW.created_by_person_id:=actor_person;NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x)FROM unnest(prior_people||ARRAY[actor_person,source_person]||ARRAY(SELECT person_id FROM app_user WHERE tenant_id=NEW.tenant_id AND id=ANY(NEW.contributor_ids) AND person_id IS NOT NULL))x);
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id OR NEW.previous_plan_version_id IS DISTINCT FROM OLD.previous_plan_version_id THEN RAISE EXCEPTION 'Plan maker identity and lineage are immutable';END IF;
   IF NEW.state='approved' THEN NEW.approved_by_person_id:=actor_person;NEW.contributor_person_ids:=OLD.contributor_person_ids;
   ELSE NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_person_ids||ARRAY[actor_person])x);END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_config_identity_guard() FROM PUBLIC;
DROP TRIGGER reward_library_identity_guard ON public.reward_library_version;
DROP TRIGGER reward_pat_identity_guard ON public.reward_pat_version;
DROP TRIGGER reward_plan_identity_guard ON public.reward_plan_setup;
CREATE TRIGGER reward_library_identity_guard BEFORE INSERT OR UPDATE ON public.reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_identity_guard();
CREATE TRIGGER reward_pat_identity_guard BEFORE INSERT OR UPDATE ON public.reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_identity_guard();
CREATE TRIGGER reward_plan_identity_guard BEFORE INSERT OR UPDATE ON public.reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_config_identity_guard();
--> statement-breakpoint

-- 5. Unit set-up release to the BU CEO: the person who prepared the steps may release. Basis, the current-doer step
-- proofs, the expected release date and the controlled-change reason all stay.
CREATE OR REPLACE FUNCTION app.reward_preparation_check_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
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
  IF before_p->>'state' IS DISTINCT FROM 'preparing' OR after_p->'steps' IS DISTINCT FROM before_p->'steps'
   OR after_p->>'releasedBy' IS DISTINCT FROM app.current_user_id()::text
   OR after_p->>'releasedByPersonId' IS NULL OR after_p->>'releasedByPersonId' IS DISTINCT FROM (app.reward_preparation_view(NEW.unit_id)->>'personId')
   OR NOT coalesce((app.reward_preparation_view(NEW.unit_id)->>'namedDoer')::boolean,false)
   OR after_p->>'expectedRelease' IS NULL OR after_p->>'releaseBasis' IS NULL OR after_p->>'releaseBasis' !~ '^[0-9a-f]{64}$'
   OR after_p->>'releasedAt' IS NULL THEN RAISE EXCEPTION 'Current preparation release required'; END IF;
  FOREACH step IN ARRAY ARRAY['snapshot','data','excluded','senior','budget','applied'] LOOP
   proof:=after_p->'steps'->step;
   IF proof IS NULL OR proof->>'basis' IS DISTINCT FROM after_p->>'releaseBasis' OR proof->>'actorId' IS NULL THEN
    RAISE EXCEPTION 'Every current preparation step must be confirmed before release';
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
--> statement-breakpoint

-- 6. Nobody changes their own access. An immediate (no second approval) change may remove the actor's own seat but
-- may not add, re-role or lengthen a seat for the actor's login or another login of the same PERSON. Requests from
-- people outside the configuration roles keep their pending route and independent decider (0947).
CREATE FUNCTION app.reward_access_self_change_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor_person uuid;
BEGIN
 IF NEW.status='applied_no_second_approval' AND OLD.status IS DISTINCT FROM NEW.status THEN
  SELECT person_id INTO actor_person FROM public.app_user WHERE id=NEW.requested_by AND tenant_id=NEW.tenant_id;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.changes) c(value)
    JOIN public.app_user target ON target.tenant_id=NEW.tenant_id AND target.id=(c.value->'after'->>'userId')::uuid
    WHERE jsonb_typeof(c.value->'after')='object'
      AND (target.id=NEW.requested_by OR actor_person IS NOT NULL AND target.person_id=actor_person)
      AND (jsonb_typeof(c.value->'before')<>'object'
       OR c.value->'before'->>'userId' IS DISTINCT FROM c.value->'after'->>'userId'
       OR c.value->'before'->>'role' IS DISTINCT FROM c.value->'after'->>'role'
       OR coalesce(c.value->'after'->>'validTo','9999-12-31')>coalesce(c.value->'before'->>'validTo','9999-12-31')
       OR coalesce(c.value->'after'->>'validFrom','0001-01-01')<coalesce(c.value->'before'->>'validFrom','0001-01-01'))) THEN
   RAISE EXCEPTION 'You cannot add or widen your own Rewards access. Ask another Rewards administrator.' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_access_self_change_guard() FROM PUBLIC;
CREATE TRIGGER reward_access_self_change_guard BEFORE UPDATE OF status ON public.reward_access_request FOR EACH ROW EXECUTE FUNCTION app.reward_access_self_change_guard();
--> statement-breakpoint

-- Whether the current principal holds a Rewards role, for the role-permission self rule. Own current seats, setup
-- grants and whole-group grants, plus an HR Admin role assignment.
CREATE FUNCTION app.reward_actor_holds_role(wanted_role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND (
  wanted_role IN (SELECT app.reward_current_group_roles())
  OR EXISTS(SELECT 1 FROM public.reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active AND g.role=wanted_role
   AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))
  OR EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id()
   AND (m.role=wanted_role OR wanted_role='proxy_bg' AND m.role='bg' AND m.covers_user_id IS NOT NULL)
   AND m.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (m.valid_to IS NULL OR m.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))
  OR wanted_role='hr_admin' AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text='hr_admin'));
$$;
REVOKE ALL ON FUNCTION app.reward_actor_holds_role(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_actor_holds_role(text) TO ai_hr_app;
CREATE POLICY reward_role_permission_not_own_insert ON public.reward_role_permission AS RESTRICTIVE FOR INSERT TO ai_hr_app WITH CHECK(NOT app.reward_actor_holds_role(role));
CREATE POLICY reward_role_permission_not_own_update ON public.reward_role_permission AS RESTRICTIVE FOR UPDATE TO ai_hr_app USING(NOT app.reward_actor_holds_role(role)) WITH CHECK(NOT app.reward_actor_holds_role(role));
CREATE POLICY reward_role_permission_not_own_delete ON public.reward_role_permission AS RESTRICTIVE FOR DELETE TO ai_hr_app USING(NOT app.reward_actor_holds_role(role));
--> statement-breakpoint

-- 7. The Rewards configuration change log. Append-only: one row per command, written in the command's transaction
-- through the owner function below. Summaries are bounded old/new values and never carry an individual's pay;
-- rows about named reviewees also record their entries so a reader never sees a row about their own reward.
CREATE TABLE public.reward_config_change(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 area text NOT NULL CHECK(area IN('salary','bonus','pat','plan','shared','exemption','senior','upload','preparation','access','role_permission','group_role','limit')),
 action text NOT NULL CHECK(action ~ '^[a-z][a-z_-]{1,40}$'),
 item_id uuid,
 item_label text NOT NULL CHECK(length(btrim(item_label)) BETWEEN 1 AND 300),
 company_ids uuid[] NOT NULL DEFAULT '{}',
 version_ref text CHECK(version_ref IS NULL OR length(version_ref)<=80),
 actor_kind text NOT NULL DEFAULT 'user' CHECK(actor_kind IN('user','system')),
 actor_id uuid REFERENCES public.app_user(id),
 actor_person_id uuid REFERENCES public.person(id),
 at timestamptz NOT NULL DEFAULT now(),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 4000),
 high_impact boolean NOT NULL DEFAULT false,
 changed_count integer NOT NULL DEFAULT 0 CHECK(changed_count BETWEEN 0 AND 100000),
 summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=200000),
 subject_unit_id uuid REFERENCES public.reward_unit(id),
 subject_entry_ids uuid[] NOT NULL DEFAULT '{}',
 restored_from text CHECK(restored_from IS NULL OR length(restored_from)<=80),
 UNIQUE(tenant_id,id),
 CHECK((actor_kind='user')=(actor_id IS NOT NULL)),
 CHECK(cardinality(subject_entry_ids)=0 OR subject_unit_id IS NOT NULL)
);
CREATE INDEX reward_config_change_recent ON public.reward_config_change(tenant_id,at DESC,id DESC);
CREATE INDEX reward_config_change_item ON public.reward_config_change(tenant_id,item_id,at DESC) WHERE item_id IS NOT NULL;
REVOKE ALL ON public.reward_config_change FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.reward_config_change TO ai_hr_app;
--> statement-breakpoint

-- The legacy pending items, before row security is forced on the new table. Reading them as the restricted owner
-- needs the source tables' forced row security lifted for this one statement; it is restored immediately below.
ALTER TABLE public.reward_library_version NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_library NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_pat_version NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_plan_setup NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.reward_config_change(tenant_id,area,action,item_id,item_label,company_ids,version_ref,actor_kind,reason,summary)
 SELECT v.tenant_id,l.kind,'returned-to-draft',v.id,l.name||' '||l.year,'{}',v.revision::text,'system',
  'Returned to Draft: the second-person confirmation was retired (board 60f1fdcd).',jsonb_build_object('previousState','pending','state','draft','preparedBy',v.created_by)
 FROM public.reward_library_version v JOIN public.reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.state='pending'
 UNION ALL
 SELECT p.tenant_id,'pat','returned-to-draft',p.id,'PAT '||p.year,ARRAY[p.company_id],p.revision::text,'system',
  'Returned to Draft: the second-person confirmation was retired (board 60f1fdcd).',jsonb_build_object('previousState','pending','state','draft','preparedBy',p.created_by)
 FROM public.reward_pat_version p WHERE p.state='pending'
 UNION ALL
 SELECT s.tenant_id,'plan','returned-to-draft',s.version_id,s.cycle_name,s.company_ids,s.revision::text,'system',
  'Returned to Draft: the second-person confirmation was retired (board 60f1fdcd).',jsonb_build_object('previousState','pending','state','draft','preparedBy',s.created_by)
 FROM public.reward_plan_setup s WHERE s.state='pending';
ALTER TABLE public.reward_library_version FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_library FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_pat_version FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_plan_setup FORCE ROW LEVEL SECURITY;
ALTER TABLE public.reward_config_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reward_config_change FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Configuration editors see the rows for companies they configure; a group-level row needs group-level setup
-- authority, and salary/bonus rows are also visible to the library viewers. A row naming the reader's own entry
-- is never returned.
CREATE FUNCTION app.reward_config_change_visible(wanted_area text,wanted_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND (
  CASE WHEN cardinality(wanted_companies)=0 THEN app.reward_setup_allowed(NULL,'manage')
   ELSE NOT EXISTS(SELECT 1 FROM unnest(wanted_companies) c WHERE NOT app.reward_setup_allowed(c,'manage')) END
  OR wanted_area IN('salary','bonus') AND app.reward_setup_allowed(NULL,'library_view'));
$$;
REVOKE ALL ON FUNCTION app.reward_config_change_visible(text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_change_visible(text,uuid[]) TO ai_hr_app;
CREATE POLICY reward_config_change_read ON public.reward_config_change FOR SELECT TO ai_hr_app USING(
 tenant_id=app.current_tenant_id() AND app.reward_config_change_visible(area,company_ids)
 AND (subject_unit_id IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(subject_entry_ids) e WHERE NOT app.reward_private_entry_visible(subject_unit_id,e))));
CREATE POLICY reward_config_change_owner ON public.reward_config_change TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id()) WITH CHECK(tenant_id=app.current_tenant_id());
--> statement-breakpoint

-- The one writer. The actor is the current principal; the reason is required; the row must be about companies the
-- actor configures (access rows: the actor's own applied access request; whole-group roles: a group administrator).
CREATE FUNCTION app.reward_config_change_record(p_area text,p_action text,p_item uuid,p_label text,p_companies uuid[],p_version text,p_reason text,p_high_impact boolean,p_changed integer,p_summary jsonb,p_subject_unit uuid,p_subject_entries uuid[],p_restored_from text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();actor_person uuid;result uuid;companies uuid[]:=coalesce(p_companies,'{}');allowed boolean;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) THEN RAISE EXCEPTION 'Rewards configuration change log writer required' USING ERRCODE='42501'; END IF;
 SELECT person_id INTO actor_person FROM public.app_user WHERE id=actor AND tenant_id=t AND archived_at IS NULL;
 IF actor_person IS NULL THEN RAISE EXCEPTION 'A person-backed Rewards configuration account is required' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT EXISTS(SELECT 1 FROM public.company x WHERE x.id=c AND x.tenant_id=t)) THEN RAISE EXCEPTION 'Rewards configuration companies must be in this tenant' USING ERRCODE='42501'; END IF;
 IF p_area='access' THEN
  -- An access row records the actor's own access request that was applied without a second approval.
  allowed:=EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=p_item AND q.tenant_id=t AND q.requested_by=actor AND q.status='applied_no_second_approval');
 ELSIF p_area='group_role' THEN allowed:=coalesce(app.is_group_admin(),false);
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
REVOKE ALL ON FUNCTION app.reward_config_change_record(text,text,uuid,text,uuid[],text,text,boolean,integer,jsonb,uuid,uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_change_record(text,text,uuid,text,uuid[],text,text,boolean,integer,jsonb,uuid,uuid[],text) TO ai_hr_app;
--> statement-breakpoint

-- Co-administrators told about a change: current whole-group Group Rewards and CTRO holders, setup-grant holders and
-- unit Group Rewards/CTRO seats for the change's companies, never the actor's PERSON. Same dispatcher boundary as
-- app.reward_pool_notification_recipients (0689).
CREATE FUNCTION app.reward_config_change_recipients(wanted_change uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH change AS (
  SELECT c.* FROM public.reward_config_change c WHERE c.id=wanted_change AND c.tenant_id=app.current_tenant_id() AND c.actor_kind='user'
 ), holder AS (
  SELECT g.user_id FROM public.reward_group_role_grant g JOIN change c ON c.tenant_id=g.tenant_id
   WHERE g.active AND g.role IN('gr','ctro') AND app.reward_group_person_eligible(g.user_id)
  UNION
  SELECT s.user_id FROM public.reward_setup_grant s JOIN change c ON c.tenant_id=s.tenant_id
   WHERE s.active AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
    AND (s.company_id IS NULL OR s.company_id=ANY(c.company_ids))
  UNION
  SELECT m.user_id FROM public.reward_member m JOIN public.reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id AND u.deleted_at IS NULL
   JOIN change c ON c.tenant_id=m.tenant_id AND u.company_id=ANY(c.company_ids)
   WHERE m.role IN('gr','ctro') AND m.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (m.valid_to IS NULL OR m.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
 )
 SELECT DISTINCT e.id FROM holder h
  JOIN change c ON true
  JOIN public.app_user a ON a.id=h.user_id AND a.tenant_id=c.tenant_id
  JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id
 WHERE a.archived_at IS NULL AND a.person_id IS NOT NULL AND a.person_id IS DISTINCT FROM c.actor_person_id AND a.id IS DISTINCT FROM c.actor_id
  AND e.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND e.terminated_on IS NULL
  AND app.is_admin() AND (app.current_user_id() IS NULL OR app.is_group_admin());
$$;
REVOKE ALL ON FUNCTION app.reward_config_change_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_change_recipients(uuid) TO ai_hr_app;
