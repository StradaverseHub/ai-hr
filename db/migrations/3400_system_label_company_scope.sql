-- Existing IDs and values remain untouched and global. Scope governs NEW choices, not historical facts.
ALTER TABLE profile_option ADD COLUMN scope_company_ids uuid[];
ALTER TABLE job_grade ADD COLUMN scope_company_ids uuid[];
ALTER TABLE grade_group ADD COLUMN scope_company_ids uuid[];
--> statement-breakpoint
CREATE FUNCTION app.system_label_scope_applies(ids uuid[],company uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT ids IS NULL OR (company IS NOT NULL AND company=ANY(ids));
$$;
CREATE FUNCTION app.system_label_scope_read(ids uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ids IS NULL OR EXISTS(SELECT 1 FROM unnest(ids) c(id) WHERE app.is_admin_for(c.id)
  OR EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=c.id AND app.is_self_person(e.person_id)));
$$;
CREATE FUNCTION app.system_label_scope_admin(ids uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ids IS NULL OR (cardinality(ids)>0 AND NOT EXISTS(SELECT 1 FROM unnest(ids) c(id) WHERE c.id IS NULL OR NOT EXISTS(
  SELECT 1 FROM public.company co WHERE co.id=c.id AND co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.is_admin_for(co.id))));
$$;
REVOKE ALL ON FUNCTION app.system_label_scope_applies(uuid[],uuid),app.system_label_scope_read(uuid[]),app.system_label_scope_admin(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.system_label_scope_applies(uuid[],uuid),app.system_label_scope_read(uuid[]),app.system_label_scope_admin(uuid[]) TO ai_hr_app;
-- Existing bounded readers still need the restrictive policy predicate. Their table grants and native
-- tenant/actor guards remain unchanged; no write helper or PUBLIC execution is granted.
GRANT EXECUTE ON FUNCTION app.system_label_scope_read(uuid[]) TO ai_hr_architecture_grade_guard,ai_hr_draft_discard_port,ai_hr_reward_setup_reader,ai_hr_reward_upload_reader,ai_hr_rewards_post_reader;
--> statement-breakpoint
-- Restrictive policies supplement existing tenant/actor policies; they never grant access by themselves.
CREATE POLICY label_scope_read ON profile_option AS RESTRICTIVE FOR SELECT USING(app.system_label_scope_read(scope_company_ids));
CREATE POLICY label_scope_read ON job_grade AS RESTRICTIVE FOR SELECT USING(app.system_label_scope_read(scope_company_ids));
CREATE POLICY label_scope_read ON grade_group AS RESTRICTIVE FOR SELECT USING(app.system_label_scope_read(scope_company_ids));
CREATE POLICY label_scope_read ON grade_group_member AS RESTRICTIVE FOR SELECT USING(EXISTS(SELECT 1 FROM grade_group g WHERE g.id=grade_group_id AND g.tenant_id=grade_group_member.tenant_id));
CREATE POLICY label_scope_insert ON profile_option AS RESTRICTIVE FOR INSERT WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_insert ON job_grade AS RESTRICTIVE FOR INSERT WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_insert ON grade_group AS RESTRICTIVE FOR INSERT WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_update ON profile_option AS RESTRICTIVE FOR UPDATE USING(app.system_label_scope_admin(scope_company_ids)) WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_update ON job_grade AS RESTRICTIVE FOR UPDATE USING(app.system_label_scope_admin(scope_company_ids)) WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_update ON grade_group AS RESTRICTIVE FOR UPDATE USING(app.system_label_scope_admin(scope_company_ids)) WITH CHECK(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_delete ON profile_option AS RESTRICTIVE FOR DELETE USING(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_delete ON job_grade AS RESTRICTIVE FOR DELETE USING(app.system_label_scope_admin(scope_company_ids));
CREATE POLICY label_scope_delete ON grade_group AS RESTRICTIVE FOR DELETE USING(app.system_label_scope_admin(scope_company_ids));
--> statement-breakpoint
CREATE FUNCTION app.system_label_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.scope_company_ids IS NOT NULL AND (cardinality(NEW.scope_company_ids)=0 OR array_position(NEW.scope_company_ids,NULL) IS NOT NULL OR EXISTS(
  SELECT 1 FROM unnest(NEW.scope_company_ids) c(id) WHERE NOT EXISTS(SELECT 1 FROM public.company co WHERE co.id=c.id AND co.tenant_id=NEW.tenant_id AND co.archived_at IS NULL))) THEN
  RAISE EXCEPTION 'Label companies must identify active companies in the same tenant' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.scope_company_ids IS DISTINCT FROM OLD.scope_company_ids THEN
  RAISE EXCEPTION 'Existing label assignment cannot change through a generic label edit' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER label_scope_guard BEFORE INSERT OR UPDATE ON profile_option FOR EACH ROW EXECUTE FUNCTION app.system_label_scope_guard();
CREATE TRIGGER label_scope_guard BEFORE INSERT OR UPDATE ON job_grade FOR EACH ROW EXECUTE FUNCTION app.system_label_scope_guard();
CREATE TRIGGER label_scope_guard BEFORE INSERT OR UPDATE ON grade_group FOR EACH ROW EXECUTE FUNCTION app.system_label_scope_guard();
--> statement-breakpoint
-- A person without one unambiguous visible company may pick only global values.
CREATE FUNCTION app.system_label_person_company(p_person uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT co.id FROM public.company co WHERE co.id=nullif(current_setting('app.system_label_operation_company',true),'')::uuid AND co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL
  AND (app.is_admin_for(co.id) OR EXISTS(SELECT 1 FROM public.employment own_e WHERE own_e.tenant_id=co.tenant_id AND own_e.person_id=p_person AND own_e.company_id=co.id AND app.is_self_person(own_e.person_id) AND app.can_see_employment(own_e.id)))
  AND (NOT EXISTS(SELECT 1 FROM public.employment any_e WHERE any_e.tenant_id=co.tenant_id AND any_e.person_id=p_person)
   OR EXISTS(SELECT 1 FROM public.employment subject_e WHERE subject_e.tenant_id=co.tenant_id AND subject_e.person_id=p_person AND subject_e.company_id=co.id))),
 CASE WHEN count(DISTINCT e.company_id)=1 THEN (array_agg(DISTINCT e.company_id))[1] END) FROM public.employment e
 WHERE e.tenant_id=app.current_tenant_id() AND e.person_id=p_person AND app.can_see_employment(e.id)
 AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
$$;
CREATE FUNCTION app.system_label_value_scope_allowed(category text,value text,company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=$1 AND p.value=$2 AND NOT app.system_label_scope_applies(p.scope_company_ids,$3));
$$;
-- Preserve the existing validator signature, free-text fallback and unchanged legacy tolerance.
-- Company-specific callers use the overload below; context-free callers can choose only global values.
CREATE OR REPLACE FUNCTION app.profile_option_value_allowed(p_category text,p_value text,p_legacy text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_value IS NULL OR p_value='' OR p_value IS NOT DISTINCT FROM p_legacy
 OR NOT EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category)
 OR EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category AND p.value=p_value AND p.is_active AND app.system_label_scope_applies(p.scope_company_ids,nullif(current_setting('app.system_label_operation_company',true),'')::uuid));
$$;
CREATE FUNCTION app.profile_option_value_allowed(p_category text,p_value text,p_legacy text,p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_value IS NULL OR p_value='' OR p_value IS NOT DISTINCT FROM p_legacy
 OR NOT EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category)
 OR EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=p_category AND p.value=p_value AND p.is_active AND app.system_label_scope_applies(p.scope_company_ids,p_company));
$$;
REVOKE ALL ON FUNCTION app.system_label_person_company(uuid),app.system_label_value_scope_allowed(text,text,uuid),app.profile_option_value_allowed(text,text,text,uuid),app.system_label_scope_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.system_label_person_company(uuid),app.system_label_value_scope_allowed(text,text,uuid),app.profile_option_value_allowed(text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- All writers (including raw SQL/imports) share these guards. Unchanged historical values are tolerated.
CREATE FUNCTION app.system_label_selection_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb:=to_jsonb(NEW); o jsonb:='{}'; company uuid; field text; category text; mapping jsonb; grade_scope uuid[]; group_scope uuid[];
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  -- Owner-run migration/seed operations have no request tenant; ordinary RLS still owns tenant checks.
  IF app.current_tenant_id() IS NOT NULL THEN RAISE EXCEPTION 'Label selection tenant mismatch' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_OP='UPDATE' THEN o:=to_jsonb(OLD); END IF;
 company:=nullif(n->>'company_id','')::uuid;
 IF company IS NULL AND n->>'employment_id' IS NOT NULL THEN
  SELECT e.company_id INTO company FROM public.employment e WHERE e.id=(n->>'employment_id')::uuid AND e.tenant_id=NEW.tenant_id;
 END IF;
 IF company IS NULL AND n->>'person_id' IS NOT NULL THEN company:=app.system_label_person_company((n->>'person_id')::uuid); END IF;
 IF TG_TABLE_NAME='person' THEN company:=app.system_label_person_company(NEW.id); END IF;
 mapping:=CASE TG_TABLE_NAME
 WHEN 'employment' THEN '{"org_division":"division","org_branch":"branch","org_region":"region","org_line":"line","org_section":"section","org_team":"team","org_base":"base","employment_category":"category"}'::jsonb
 WHEN 'person' THEN '{"salutation":"salutation","religion":"religion","race":"race","nationality":"nationality","state":"state","country":"country","permanent_state":"state","permanent_country":"country","correspondence_state":"state","correspondence_country":"country"}'::jsonb
 WHEN 'location' THEN '{"branch":"branch"}'::jsonb
 WHEN 'person_emergency_contact' THEN '{"relationship":"relationship"}'::jsonb
 WHEN 'employee_dependent' THEN '{"relationship":"dependentRelationship","study_country":"country"}'::jsonb
 WHEN 'employee_qualification' THEN '{"qualification":"qualificationLevel"}'::jsonb ELSE '{}'::jsonb END;
 FOR field,category IN SELECT * FROM jsonb_each_text(mapping) LOOP
  IF nullif(n->>field,'') IS NOT NULL AND ((n->field) IS DISTINCT FROM (o->field) OR n->'company_id' IS DISTINCT FROM o->'company_id') AND NOT app.system_label_value_scope_allowed(category,n->>field,company) THEN
   RAISE EXCEPTION 'Selected label is not available for this company' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF TG_TABLE_NAME<>'grade_group_member' AND n->>'grade_id' IS NOT NULL AND (n->'grade_id' IS DISTINCT FROM o->'grade_id' OR n->'company_id' IS DISTINCT FROM o->'company_id') THEN
  SELECT g.scope_company_ids INTO grade_scope FROM public.job_grade g WHERE g.id=(n->>'grade_id')::uuid AND g.tenant_id=NEW.tenant_id;
  IF NOT app.system_label_scope_applies(grade_scope,company) THEN RAISE EXCEPTION 'Grade is not available for this company' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='grade_group_member' THEN
  SELECT g.scope_company_ids INTO grade_scope FROM public.job_grade g WHERE g.id=NEW.grade_id AND g.tenant_id=NEW.tenant_id;
  SELECT g.scope_company_ids INTO group_scope FROM public.grade_group g WHERE g.id=NEW.grade_group_id AND g.tenant_id=NEW.tenant_id;
  IF grade_scope IS NOT NULL AND (group_scope IS NULL OR NOT grade_scope @> group_scope) THEN RAISE EXCEPTION 'Grade must apply to every company in its group' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='leave_approval_policy' AND n->>'grade_group_id' IS NOT NULL AND (n->'grade_group_id' IS DISTINCT FROM o->'grade_group_id' OR n->'company_id' IS DISTINCT FROM o->'company_id') THEN
  SELECT g.scope_company_ids INTO group_scope FROM public.grade_group g WHERE g.id=(n->>'grade_group_id')::uuid AND g.tenant_id=NEW.tenant_id;
  IF NOT app.system_label_scope_applies(group_scope,company) THEN RAISE EXCEPTION 'Grade group is not available for this company' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.system_label_selection_guard() FROM PUBLIC;
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON employment FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON person FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON person_emergency_contact FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON employee_dependent FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON employee_qualification FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON grade_group_member FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON leave_approval_policy FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON claim_policy FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON claim_mileage_rate FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
--> statement-breakpoint
-- Existence only: hidden label values, names, assignments and owning companies are never returned.
CREATE FUNCTION app.system_label_catalog_conflicts(p_rows jsonb) RETURNS TABLE(row_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r->>'key' FROM jsonb_array_elements(p_rows) r WHERE app.is_admin() AND jsonb_array_length(p_rows)<=7000 AND (
  ((r->>'kind')='grades' AND EXISTS(SELECT 1 FROM public.job_grade g WHERE g.tenant_id=app.current_tenant_id() AND g.code=r->>'code'))
  OR ((r->>'kind')='grade_groups' AND EXISTS(SELECT 1 FROM public.grade_group g WHERE g.tenant_id=app.current_tenant_id() AND lower(g.name)=lower(r->>'code')))
  OR EXISTS(SELECT 1 FROM public.profile_option p WHERE p.tenant_id=app.current_tenant_id() AND p.category=r->>'kind' AND p.value=r->>'code'));
$$;
REVOKE ALL ON FUNCTION app.system_label_catalog_conflicts(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.system_label_catalog_conflicts(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY label_scope_insert ON grade_group_member AS RESTRICTIVE FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM grade_group g WHERE g.id=grade_group_id AND g.tenant_id=grade_group_member.tenant_id AND app.system_label_scope_admin(g.scope_company_ids)));
CREATE POLICY label_scope_update ON grade_group_member AS RESTRICTIVE FOR UPDATE USING(EXISTS(SELECT 1 FROM grade_group g WHERE g.id=grade_group_id AND g.tenant_id=grade_group_member.tenant_id AND app.system_label_scope_admin(g.scope_company_ids))) WITH CHECK(EXISTS(SELECT 1 FROM grade_group g WHERE g.id=grade_group_id AND g.tenant_id=grade_group_member.tenant_id AND app.system_label_scope_admin(g.scope_company_ids)));
CREATE POLICY label_scope_delete ON grade_group_member AS RESTRICTIVE FOR DELETE USING(EXISTS(SELECT 1 FROM grade_group g WHERE g.id=grade_group_id AND g.tenant_id=grade_group_member.tenant_id AND app.system_label_scope_admin(g.scope_company_ids)));

--> statement-breakpoint
CREATE TRIGGER label_selection_guard BEFORE INSERT OR UPDATE ON location FOR EACH ROW EXECUTE FUNCTION app.system_label_selection_guard();
-- One company identifier, available only through an already-authorized employment/maintenance read.
CREATE FUNCTION app.system_label_employment_company(p_employment uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.company_id FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
 AND (app.can_see_employment(e.id) OR app.access_workforce_editor(e.id) IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION app.system_label_employment_company(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.system_label_employment_company(uuid) TO ai_hr_app;
