-- DRAFT: allocate a canonical journal position at the integration freeze.
-- Additive V9 storage. Existing onboarding, resignation, asset and legacy case rows are untouched.
CREATE TABLE lc_v9_config (
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id), revision integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL CHECK(data->>'version'='9'), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lc_v9_config_revision (
 tenant_id uuid NOT NULL REFERENCES tenant(id), revision integer NOT NULL,
 data jsonb NOT NULL, actor_user_id uuid REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,revision)
);
CREATE TABLE lc_v9_case (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), employment_id uuid NOT NULL REFERENCES employment(id),
 module text NOT NULL CHECK(module IN ('onb','off')), number text NOT NULL,
 revision integer NOT NULL DEFAULT 1, data jsonb NOT NULL CHECK(data->>'version'='9'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,number), UNIQUE(tenant_id,id),
 CHECK(data->>'id'=id::text), CHECK(data->>'module'=module),
 CHECK(data->'facts'->>'company'=company_id::text), CHECK(data->'facts'->>'employmentId'=employment_id::text)
);
CREATE UNIQUE INDEX lc_v9_case_open_employment ON lc_v9_case(tenant_id,employment_id,module)
 WHERE data->>'state' IN ('pending','submitted');
CREATE INDEX lc_v9_case_company ON lc_v9_case(tenant_id,company_id,module);
CREATE TABLE lc_v9_case_revision (
 tenant_id uuid NOT NULL REFERENCES tenant(id), case_id uuid NOT NULL REFERENCES lc_v9_case(id),
 company_id uuid NOT NULL REFERENCES company(id), revision integer NOT NULL, data jsonb NOT NULL,
 actor_user_id uuid REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(case_id,revision)
);
CREATE TABLE lc_v9_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 case_id uuid REFERENCES lc_v9_case(id), onboarding_case_id uuid REFERENCES lc_onboarding_case(id), company_id uuid NOT NULL REFERENCES company(id),
 document_id text, slot text NOT NULL, filename text NOT NULL, mime_type text NOT NULL,
 content bytea NOT NULL CHECK(octet_length(content)<=10485760),
 uploaded_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(case_id,onboarding_case_id)=1)
);
-- Group page readers and case writers are deliberately separate from assigned-work participation.
CREATE FUNCTION app.onboarding_v9_sections() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb; g jsonb; setting jsonb; candidate jsonb; result jsonb; k text; ordering jsonb := '{"case":["hidden","view"],"hr":["hidden","view"],"notes":["hidden","view"],"checklist":["hidden","team","all"],"equip":["hidden","view","act"],"history":["hidden","equip","full"],"actions":["none","allowed"]}';
BEGIN
 IF app.current_user_id() IS NULL OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RETURN NULL; END IF;
 SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=app.current_tenant_id();
 IF cfg->'access'->'onboarding' ? app.current_user_id()::text THEN RETURN '{"case":"view","hr":"view","notes":"view","checklist":"all","equip":"act","history":"full","actions":"allowed"}'::jsonb; END IF;
 FOR g IN SELECT * FROM jsonb_array_elements(coalesce(cfg->'groups','[]')) LOOP
  IF NOT (coalesce(cfg->'access'->'joinerViewGroups','[]') ? (g->>'id') AND g->'members' ? app.current_user_id()::text) THEN CONTINUE; END IF;
  setting:=cfg->'access'->'joinerSections'->(g->>'id');
  candidate:=CASE setting->>'preset'
   WHEN 'full' THEN '{"case":"view","hr":"view","notes":"view","checklist":"all","equip":"act","history":"full","actions":"allowed"}'::jsonb
   WHEN 'coord' THEN '{"case":"view","hr":"hidden","notes":"view","checklist":"all","equip":"act","history":"full","actions":"none"}'::jsonb
   WHEN 'approver' THEN '{"case":"hidden","hr":"hidden","notes":"hidden","checklist":"hidden","equip":"view","history":"hidden","actions":"none"}'::jsonb
   ELSE '{"case":"view","hr":"hidden","notes":"view","checklist":"team","equip":"act","history":"equip","actions":"none"}'::jsonb END;
  IF setting->>'preset'='custom' THEN candidate:=candidate||coalesce(setting->'s','{}'); END IF;
  IF result IS NULL THEN result:=candidate; ELSE
   FOR k IN SELECT jsonb_object_keys(ordering) LOOP
    IF (SELECT ordinality FROM jsonb_array_elements_text(ordering->k) WITH ORDINALITY v WHERE value=candidate->>k) > (SELECT ordinality FROM jsonb_array_elements_text(ordering->k) WITH ORDINALITY v WHERE value=result->>k) THEN result:=jsonb_set(result,ARRAY[k],candidate->k); END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN result;
END;
$$;
CREATE FUNCTION app.onboarding_v9_case_actor() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT coalesce(app.onboarding_v9_sections()->>'actions'='allowed',false) $$;
CREATE FUNCTION app.onboarding_v9_page_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$ SELECT app.onboarding_v9_sections() IS NOT NULL $$;
CREATE FUNCTION app.onboarding_v9_record_reader() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AND EXISTS(
 SELECT 1 FROM lc_onboarding_config cfg WHERE cfg.tenant_id=app.current_tenant_id() AND (
 coalesce((cfg.data->'access'->>'recordHR')::boolean,true) AND cfg.data->'access'->'onboarding' ? app.current_user_id()::text OR EXISTS(
 SELECT 1 FROM jsonb_array_elements(coalesce(cfg.data->'groups','[]')) g WHERE coalesce(cfg.data->'access'->'recordGroups','[]') ? (g->>'id') AND g->'members' ? app.current_user_id()::text)))
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_sections(),app.onboarding_v9_case_actor(),app.onboarding_v9_page_reader(),app.onboarding_v9_record_reader() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_sections(),app.onboarding_v9_case_actor(),app.onboarding_v9_page_reader(),app.onboarding_v9_record_reader() TO ai_hr_app;
CREATE POLICY onb_v9_group_read ON lc_onboarding_case FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.onboarding_v9_page_reader() OR app.onboarding_v9_record_reader()));
CREATE POLICY onb_v9_case_actions ON lc_onboarding_case FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor());
CREATE POLICY onb_v9_group_write_boundary ON lc_onboarding_case AS RESTRICTIVE FOR UPDATE USING(NOT app.onboarding_v9_page_reader() OR app.onboarding_v9_case_actor() OR app.onboarding_participant(id)) WITH CHECK(NOT app.onboarding_v9_page_reader() OR app.onboarding_v9_case_actor() OR app.onboarding_participant(id));
CREATE POLICY onb_v9_revision_append ON lc_onboarding_case_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor());
CREATE POLICY onb_v9_note_read ON lc_onboarding_note FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.onboarding_v9_sections()->>'notes'='view');
CREATE POLICY onb_v9_note_append ON lc_onboarding_note FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor() AND app.onboarding_v9_sections()->>'notes'='view' AND data->>'by'=app.current_user_id()::text);
CREATE POLICY onb_v9_note_edit ON lc_onboarding_note FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor() AND app.onboarding_v9_sections()->>'notes'='view' AND data->>'by'=app.current_user_id()::text) WITH CHECK(tenant_id=app.current_tenant_id() AND app.onboarding_v9_case_actor() AND data->>'by'=app.current_user_id()::text);
CREATE POLICY onb_v9_seen_update ON lc_onboarding_seen FOR UPDATE USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.onboarding_v9_page_reader()) WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.onboarding_v9_page_reader());
CREATE POLICY onb_v9_seen ON lc_onboarding_seen FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.onboarding_v9_page_reader());

CREATE OR REPLACE FUNCTION app.onboarding_case_labels(p_case uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH c AS (SELECT (data->'local')||(data->'source') AS f FROM lc_onboarding_case
 WHERE id=p_case AND tenant_id=app.current_tenant_id() AND (app.onboarding_participant(id) OR app.is_admin_for(company_id) OR app.onboarding_v9_page_reader() OR app.onboarding_v9_record_reader()))
 SELECT jsonb_strip_nulls(jsonb_build_object(
 'company',(SELECT legal_name FROM company,c WHERE company.tenant_id=app.current_tenant_id() AND company.id::text=c.f->>'company'),
 'businessGroup',(SELECT name FROM business_unit,c WHERE business_unit.tenant_id=app.current_tenant_id() AND business_unit.id::text=c.f->>'businessGroup'),
 'department',(SELECT name FROM department,c WHERE department.tenant_id=app.current_tenant_id() AND department.id::text=c.f->>'department'),
 'title',(SELECT title FROM position,c WHERE position.tenant_id=app.current_tenant_id() AND position.id::text=c.f->>'title'),
 'grade',(SELECT name FROM job_grade,c WHERE job_grade.tenant_id=app.current_tenant_id() AND job_grade.id::text=c.f->>'grade'),
 'supervisor',(SELECT p.full_name FROM employment e JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id,c WHERE e.tenant_id=app.current_tenant_id() AND e.id::text=c.f->>'supervisor')
 )) WHERE EXISTS(SELECT 1 FROM c)
$$;
REVOKE ALL ON FUNCTION app.onboarding_case_labels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_case_labels(uuid) TO ai_hr_app;

-- Module membership is independent of the existing company HR scope.
CREATE FUNCTION app.lc_v9_off_access(p_company uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND (
 CASE WHEN p_company IS NULL THEN app.is_admin() ELSE app.is_admin_for(p_company) END AND EXISTS(
 SELECT 1 FROM lc_onboarding_config cfg WHERE cfg.tenant_id=app.current_tenant_id() AND cfg.data->'access'->'offboarding' ? app.current_user_id()::text))
$$;
REVOKE ALL ON FUNCTION app.lc_v9_off_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_off_access(uuid) TO ai_hr_app;

ALTER TABLE lc_v9_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_v9_config_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_v9_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_v9_case_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_v9_file ENABLE ROW LEVEL SECURITY;
CREATE POLICY v9_config_read ON lc_v9_config FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND (app.is_admin() OR app.is_group_admin()));
CREATE POLICY v9_config_insert ON lc_v9_config FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY v9_config_update ON lc_v9_config FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_group_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY v9_config_revision_read ON lc_v9_config_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY v9_config_revision_append ON lc_v9_config_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY v9_case_read ON lc_v9_case FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id));
CREATE POLICY v9_case_insert ON lc_v9_case FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id));
CREATE POLICY v9_case_update ON lc_v9_case FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id));
CREATE POLICY v9_case_revision_read ON lc_v9_case_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id));
CREATE POLICY v9_case_revision_append ON lc_v9_case_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.lc_v9_off_access(company_id));
CREATE POLICY v9_file_read ON lc_v9_file FOR SELECT USING(tenant_id=app.current_tenant_id() AND (case_id IS NOT NULL AND app.lc_v9_off_access(company_id) OR onboarding_case_id IS NOT NULL AND app.is_admin_for(company_id) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())));
CREATE POLICY v9_file_append ON lc_v9_file FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND (case_id IS NOT NULL AND app.lc_v9_off_access(company_id) OR onboarding_case_id IS NOT NULL AND app.is_admin_for(company_id) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())) AND uploaded_by=app.current_user_id());
GRANT SELECT,INSERT,UPDATE ON lc_v9_config,lc_v9_case TO ai_hr_app;
GRANT SELECT,INSERT ON lc_v9_config_revision,lc_v9_case_revision,lc_v9_file TO ai_hr_app;

CREATE TABLE lc_v9_payroll_handover (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), company_id uuid NOT NULL REFERENCES company(id),
 case_id uuid NOT NULL REFERENCES lc_v9_case(id), employment_id uuid NOT NULL REFERENCES employment(id),
 data jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','reviewed','withdrawn')),
 reviewed_by uuid REFERENCES app_user(id),review_note text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lc_v9_payroll_handover ENABLE ROW LEVEL SECURITY;
CREATE POLICY v9_payroll_read ON lc_v9_payroll_handover FOR SELECT USING(tenant_id=app.current_tenant_id() AND (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id)));
CREATE POLICY v9_payroll_insert ON lc_v9_payroll_handover FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_payroll_update ON lc_v9_payroll_handover FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.is_admin_for(company_id) OR app.can_admin_payroll_for(company_id))) WITH CHECK(tenant_id=app.current_tenant_id());
GRANT SELECT,INSERT ON lc_v9_payroll_handover TO ai_hr_app;
REVOKE UPDATE,DELETE ON lc_v9_payroll_handover FROM ai_hr_app;
GRANT UPDATE(status,reviewed_by,review_note,updated_at) ON lc_v9_payroll_handover TO ai_hr_app;

-- Tenant and company integrity is enforced independently of service validation and RLS visibility.
CREATE FUNCTION app.lc_v9_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE row_data jsonb:=to_jsonb(NEW); parent lc_v9_case%ROWTYPE; native_parent lc_onboarding_case%ROWTYPE; subject employment%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='lc_v9_case' THEN
  SELECT * INTO subject FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
  IF NOT FOUND OR NEW.data->'facts'->>'personId' IS DISTINCT FROM subject.person_id::text THEN RAISE EXCEPTION 'Lifecycle subject does not belong to this company'; END IF;
  IF NEW.data->>'id' IS DISTINCT FROM NEW.id::text OR NEW.data->>'module' IS DISTINCT FROM NEW.module OR NEW.data->'facts'->>'company' IS DISTINCT FROM NEW.company_id::text OR NEW.data->'facts'->>'employmentId' IS DISTINCT FROM NEW.employment_id::text THEN RAISE EXCEPTION 'Lifecycle case subject mismatch'; END IF;
  IF NEW.data->>'version' IS DISTINCT FROM '9' OR coalesce(NEW.data->>'state','') NOT IN ('pending','submitted','cleared','cancelled') OR (NEW.data->>'revision')::integer IS DISTINCT FROM NEW.revision THEN RAISE EXCEPTION 'Invalid lifecycle state or revision'; END IF;
 ELSIF TG_TABLE_NAME='lc_v9_file' AND row_data->>'onboarding_case_id' IS NOT NULL THEN
  SELECT * INTO native_parent FROM lc_onboarding_case WHERE id=(row_data->>'onboarding_case_id')::uuid AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
  IF NOT FOUND OR row_data->>'case_id' IS NOT NULL THEN RAISE EXCEPTION 'Lifecycle file does not belong to this company'; END IF;
 ELSIF TG_TABLE_NAME IN ('lc_v9_case_revision','lc_v9_file','lc_v9_payroll_handover') THEN
  SELECT * INTO parent FROM lc_v9_case WHERE id=(row_data->>'case_id')::uuid AND tenant_id=(row_data->>'tenant_id')::uuid AND company_id=(row_data->>'company_id')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle parent does not belong to this company'; END IF;
  IF TG_TABLE_NAME='lc_v9_payroll_handover' AND row_data->>'employment_id' IS DISTINCT FROM parent.employment_id::text THEN RAISE EXCEPTION 'Payroll subject does not match this case'; END IF;
  IF TG_TABLE_NAME='lc_v9_payroll_handover' AND row_data->>'status'='reviewed' AND (row_data->>'reviewed_by' IS DISTINCT FROM app.current_user_id()::text OR length(trim(coalesce(row_data->>'review_note','')))=0) THEN RAISE EXCEPTION 'Payroll review needs the actual signed-in reviewer and a note'; END IF;
  IF TG_TABLE_NAME='lc_v9_case_revision' AND (row_data->'data'->>'id' IS DISTINCT FROM parent.id::text OR row_data->'data'->'facts'->>'company' IS DISTINCT FROM parent.company_id::text OR row_data->'data'->'facts'->>'employmentId' IS DISTINCT FROM parent.employment_id::text) THEN RAISE EXCEPTION 'Lifecycle revision subject mismatch'; END IF;
 END IF;
 IF coalesce(row_data->>'actor_user_id',row_data->>'uploaded_by',row_data->>'reviewed_by') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=coalesce(row_data->>'actor_user_id',row_data->>'uploaded_by',row_data->>'reviewed_by')::uuid AND u.tenant_id=(row_data->>'tenant_id')::uuid) THEN RAISE EXCEPTION 'Lifecycle actor does not belong to this tenant'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_integrity() FROM PUBLIC;
CREATE TRIGGER v9_case_integrity BEFORE INSERT OR UPDATE ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.lc_v9_integrity();
CREATE TRIGGER v9_revision_integrity BEFORE INSERT ON lc_v9_case_revision FOR EACH ROW EXECUTE FUNCTION app.lc_v9_integrity();
CREATE TRIGGER v9_config_revision_integrity BEFORE INSERT ON lc_v9_config_revision FOR EACH ROW EXECUTE FUNCTION app.lc_v9_integrity();
CREATE TRIGGER v9_file_integrity BEFORE INSERT ON lc_v9_file FOR EACH ROW EXECUTE FUNCTION app.lc_v9_integrity();
CREATE TRIGGER v9_payroll_integrity BEFORE INSERT OR UPDATE ON lc_v9_payroll_handover FOR EACH ROW EXECUTE FUNCTION app.lc_v9_integrity();

-- Task participation does not grant access to the private case, Personnel changes or final figures.
CREATE FUNCTION app.lc_v9_work(p_id uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH authorized AS (
 SELECT c.*,app.current_user_id()::text AS uid,
 EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.person_id=e.person_id AND u.archived_at IS NULL) AS own
 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND (p_id IS NULL OR c.id=p_id)
 ), projections AS (
 SELECT a.*,coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements(a.data->'tasks') t
 WHERE (t->>'assignee'=a.uid OR a.own AND t->>'by'='employee')), '[]'::jsonb) AS tasks,
 coalesce((SELECT jsonb_agg(i) FROM jsonb_array_elements(a.data->'items') i WHERE i->>'assignee'=a.uid),'[]'::jsonb) AS items,
 CASE WHEN a.own THEN coalesce((SELECT jsonb_agg(d) FROM jsonb_array_elements(a.data->'documents') d
 WHERE d->>'status' IN ('sent','opened','completed','signed','acknowledged','countersign')),'[]'::jsonb) ELSE '[]'::jsonb END AS documents
 FROM authorized a
 )
 SELECT jsonb_build_object('id',id,'number',number,'module',module,'revision',revision,'state',data->>'state',
 'facts',data->'facts','tasks',tasks,'items',items,'documents',documents,'own',own)
 FROM projections WHERE own OR jsonb_array_length(tasks)>0 OR jsonb_array_length(items)>0
$$;
REVOKE ALL ON FUNCTION app.lc_v9_work(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_work(uuid) TO ai_hr_app;

CREATE FUNCTION app.lc_v9_signature_valid(signature jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE value text:=signature->>'value'; image bytea; width bigint; height bigint;
BEGIN
 IF jsonb_typeof(signature) IS DISTINCT FROM 'object' OR signature->'consent' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(signature->'value') IS DISTINCT FROM 'string' OR length(trim(coalesce(value,'')))=0 THEN RETURN false; END IF;
 IF signature->>'method'='typed' THEN RETURN length(value)<=200 AND value !~ '[[:cntrl:]]'; END IF;
 IF coalesce(signature->>'method','')<>'drawn' OR length(value)>500000 OR value !~ '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$' THEN RETURN false; END IF;
 image:=decode(split_part(value,',',2),'base64');
 IF octet_length(image)<24 OR encode(substring(image from 1 for 16),'hex')<>'89504e470d0a1a0a0000000d49484452' THEN RETURN false; END IF;
 width:=get_byte(image,16)::bigint*16777216+get_byte(image,17)::bigint*65536+get_byte(image,18)::bigint*256+get_byte(image,19);
 height:=get_byte(image,20)::bigint*16777216+get_byte(image,21)::bigint*65536+get_byte(image,22)::bigint*256+get_byte(image,23);
 RETURN width BETWEEN 1 AND 2048 AND height BETWEEN 1 AND 1024 AND width*height<=2097152;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_signature_valid(jsonb) FROM PUBLIC;

CREATE FUNCTION app.lc_v9_self_document(p_id uuid,p_revision integer,p_document text,p_values jsonb,p_signature jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_v9_case%ROWTYPE; native_case lc_onboarding_case%ROWTYPE; native_private jsonb; is_native boolean:=false; d jsonb; f jsonb; t jsonb; cfg jsonb; actor_name text;
 key text; value jsonb; vals jsonb; next_docs jsonb:='[]'::jsonb; next_tasks jsonb:='[]'::jsonb;
 next_pm jsonb; signing boolean:=p_signature IS NOT NULL; next_status text; changes jsonb; own_user uuid:=app.current_user_id();
BEGIN
 IF own_user IS NULL OR app.login_blocked(own_user) OR p_values IS NULL OR jsonb_typeof(p_values)<>'object' OR octet_length(p_values::text)>1048576 THEN RAISE EXCEPTION 'Invalid document command'; END IF;
 SELECT x.* INTO c FROM lc_v9_case x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
 WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND THEN
  SELECT x.* INTO native_case FROM lc_onboarding_case x
  JOIN employment e ON e.id=x.employment_id AND e.person_id::text=x.data->>'personId' AND e.tenant_id=x.tenant_id AND e.company_id=x.company_id
  JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
  WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document not available'; END IF;
  SELECT data INTO native_private FROM lc_onboarding_private WHERE case_id=native_case.id AND tenant_id=native_case.tenant_id FOR UPDATE;
  IF native_private->'lifecycleV9' IS NULL OR native_private->'lifecycleV9Subject'->>'employmentId' IS DISTINCT FROM native_case.employment_id::text OR native_private->'lifecycleV9Subject'->>'personId' IS DISTINCT FROM native_case.data->>'personId' THEN RAISE EXCEPTION 'Document not available'; END IF;
  is_native:=true; c.id:=native_case.id; c.tenant_id:=native_case.tenant_id; c.company_id:=native_case.company_id; c.employment_id:=native_case.employment_id; c.revision:=native_case.revision;
  c.data:=(native_private->'lifecycleV9')||jsonb_build_object('state',native_case.data->>'state','tasks',native_case.data->'tasks','sourceRevision',native_case.data->>'sourceVersion');
 END IF;
 IF c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Document not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT x INTO d FROM jsonb_array_elements(c.data->'documents') x WHERE x->>'id'=p_document AND x->>'status' IN ('sent','opened');
 IF d IS NULL THEN RAISE EXCEPTION 'Document is not open for completion'; END IF;
 SELECT x INTO cfg FROM lc_v9_config conf,jsonb_array_elements(conf.data->'templates') x WHERE conf.tenant_id=c.tenant_id AND x->>'id'=d->>'templateId';
 IF coalesce(d->>'templateType',cfg->>'type')='Attachment' THEN RAISE EXCEPTION 'Attachments are read-only PDFs'; END IF;
 vals:=coalesce(d->'values','{}'::jsonb);
 FOR key,value IN SELECT * FROM jsonb_each(p_values) LOOP
  SELECT x INTO f FROM jsonb_array_elements(d->'fields') x WHERE x->>'id'=key AND x->>'owner'='employee';
  IF f IS NULL OR jsonb_typeof(value)<>'string' OR length(value#>>'{}')>20000 THEN RAISE EXCEPTION 'This field cannot be changed'; END IF;
  IF f->>'type'='select' AND value#>>'{}'<>'' AND NOT (f->'options' ? (value#>>'{}')) THEN RAISE EXCEPTION 'Choose a valid option'; END IF;
  IF value#>>'{}'<>'' THEN
   IF f->>'type'='date' AND ((value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' OR to_char((value#>>'{}')::date,'YYYY-MM-DD')<>value#>>'{}') THEN RAISE EXCEPTION 'Enter a valid date'; END IF;
   IF f->>'type'='checkbox' AND value#>>'{}' NOT IN ('true','false') THEN RAISE EXCEPTION 'Choose a valid checkbox value'; END IF;
   IF f->>'type'='number' AND value#>>'{}' !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN RAISE EXCEPTION 'Enter a valid number'; END IF;
   IF f->>'type'='email' AND value#>>'{}' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' THEN RAISE EXCEPTION 'Enter a valid email'; END IF;
   IF f->>'type'='table' THEN
    changes:=(value#>>'{}')::jsonb;
    IF jsonb_typeof(changes)<>'array' OR jsonb_array_length(changes)>50 THEN RAISE EXCEPTION 'Enter valid table rows'; END IF;
    FOR t IN SELECT * FROM jsonb_array_elements(changes) LOOP
     IF jsonb_typeof(t)<>'array' OR jsonb_array_length(t)<>jsonb_array_length(coalesce(f->'columns','[]'::jsonb)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(t) cell WHERE jsonb_typeof(cell)<>'string' OR length(cell#>>'{}')>1000) THEN RAISE EXCEPTION 'Enter valid table cells'; END IF;
    END LOOP;
   END IF;
  END IF;
  vals:=jsonb_set(vals,ARRAY[key],value,true);
 END LOOP;
 d:=jsonb_set(d,'{values}',vals);
 SELECT coalesce(p.full_name,'Employee') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=own_user AND u.tenant_id=c.tenant_id;
 next_pm:=coalesce(c.data->'pmChanges','[]'::jsonb);
 IF signing THEN
  IF NOT app.lc_v9_signature_valid(p_signature) OR octet_length(p_signature::text)>524288 THEN RAISE EXCEPTION 'Confirm consent and provide your signature'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'blocks') b CROSS JOIN LATERAL regexp_matches(coalesce(b->>'text',''),'\{([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)\}','g') AS token(parts) WHERE coalesce(vals->>(parts[1]),d->'mergeValues'->>(parts[1]),'')='') THEN RAISE EXCEPTION 'Complete missing document fields before signing'; END IF;
  FOR f IN SELECT * FROM jsonb_array_elements(d->'fields') LOOP
   IF coalesce((f->>'required')::boolean,false) AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR vals->>(f->'when'->>'field')=f->'when'->>'value') AND (length(trim(coalesce(vals->>(f->>'id'),'')))=0 OR f->>'type'='checkbox' AND vals->>(f->>'id')<>'true' OR f->>'type'='table' AND vals->>(f->>'id')='[]') THEN RAISE EXCEPTION 'Complete required fields before signing'; END IF;
   IF f->>'owner'='employee' AND f->>'pmKey' IS NOT NULL AND (f->'when' IS NULL OR f->'when'='null'::jsonb OR vals->>(f->'when'->>'field')=f->'when'->>'value') AND coalesce(vals->>(f->>'id'),'')<>coalesce(d->'mergeValues'->>(f->>'pmKey'),'')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(next_pm) x WHERE x->>'documentId'=p_document AND x->>'field'=f->>'pmKey') THEN
    next_pm:=next_pm||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'documentId',p_document,'field',f->>'pmKey','before',coalesce(d->'mergeValues'->>(f->>'pmKey'),''),'after',coalesce(vals->>(f->>'id'),''),'status','proposed','sourceRevision',c.data->>'sourceRevision'));
   END IF;
  END LOOP;
  SELECT x INTO cfg FROM lc_v9_config conf,jsonb_array_elements(conf.data->'templates') x WHERE conf.tenant_id=c.tenant_id AND x->>'id'=d->>'templateId';
  IF cfg IS NULL THEN RAISE EXCEPTION 'Template not available'; END IF;
  next_status:=CASE WHEN coalesce(d->>'hrStep',cfg->>'hrStep')='after' THEN 'countersign' WHEN coalesce(d->>'employeeAck',cfg->>'employeeAck')='true' THEN 'acknowledged' ELSE 'signed' END;
  d:=d||jsonb_build_object('status',next_status,'employeeSignature',jsonb_build_object('by',jsonb_build_object('id',own_user,'name',actor_name),'at',now(),'method',p_signature->>'method','value',p_signature->>'value','consent',true));
 END IF;
 FOR changes IN SELECT * FROM jsonb_array_elements(c.data->'documents') LOOP next_docs:=next_docs||jsonb_build_array(CASE WHEN changes->>'id'=p_document THEN d ELSE changes END); END LOOP;
 FOR t IN SELECT * FROM jsonb_array_elements(c.data->'tasks') LOOP
  IF signing AND next_status IN ('signed','acknowledged') AND t->>'documentTemplate'=d->>'templateId' AND t->>'documentAction' IN ('signed','completed') THEN t:=t||jsonb_build_object('status','done')||CASE WHEN is_native THEN jsonb_build_object('completedAt',now(),'completedBy',own_user) ELSE '{}'::jsonb END; END IF;
  next_tasks:=next_tasks||jsonb_build_array(t);
 END LOOP;
 changes:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',own_user,'name',actor_name),'action',CASE WHEN signing THEN 'document.signed' ELSE 'document.saved' END,'detail',d->>'name');
 IF is_native THEN
  INSERT INTO lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,native_case.data);
  INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,native_private);
  UPDATE lc_onboarding_case SET revision=c.revision+1,updated_at=now(),data=native_case.data||jsonb_build_object('tasks',next_tasks,'history',coalesce(native_case.data->'history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'at',now(),'by',own_user,'name',actor_name,'action',CASE WHEN signing THEN 'document.signed' ELSE 'document.saved' END,'detail',d->>'name'))) WHERE id=c.id AND tenant_id=c.tenant_id;
  UPDATE lc_onboarding_private SET data=jsonb_set(native_private,'{lifecycleV9}',(native_private->'lifecycleV9')||jsonb_build_object('documents',next_docs,'pmChanges',next_pm,'log',coalesce(c.data->'log','[]'::jsonb)||jsonb_build_array(changes))) WHERE case_id=c.id AND tenant_id=c.tenant_id;
 ELSE
  INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,own_user);
  UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'documents',next_docs,'tasks',next_tasks,'pmChanges',next_pm,'log',(c.data->'log')||jsonb_build_array(changes)) WHERE id=c.id;
 END IF;
 RETURN c.employment_id;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_self_document(uuid,integer,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_self_document(uuid,integer,text,jsonb,jsonb) TO ai_hr_app;

-- Assigned employees and managers can change only their own normal checklist task.
CREATE FUNCTION app.lc_v9_self_task(p_id uuid,p_revision integer,p_task text,p_status text,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_v9_case%ROWTYPE; target jsonb; task jsonb; tasks jsonb:='[]'::jsonb;
 own_user uuid:=app.current_user_id(); own_employee boolean; actor_name text; entry jsonb;
BEGIN
 IF own_user IS NULL OR app.login_blocked(own_user) OR coalesce(p_status,'') NOT IN ('todo','progress','done') OR length(coalesce(p_reason,''))>4000 THEN RAISE EXCEPTION 'Task not available'; END IF;
 SELECT x.* INTO c FROM lc_v9_case x WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Task not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND u.id=own_user AND u.archived_at IS NULL) INTO own_employee;
 SELECT x INTO target FROM jsonb_array_elements(c.data->'tasks') x WHERE x->>'id'=p_task;
 IF target IS NULL OR NOT(coalesce(target->>'assignee' = own_user::text,false) OR own_employee AND target->>'by'='employee') THEN RAISE EXCEPTION 'Task not available'; END IF;
 IF coalesce(target->>'opensOn','')<>'' AND (target->>'opensOn')::date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'This task is not open yet'; END IF;
 IF target->>'documentTemplate' IS NOT NULL AND p_status='done' THEN RAISE EXCEPTION 'Complete the linked document to finish this task'; END IF;
 SELECT coalesce(p.full_name,'User') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=own_user AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL;
 IF actor_name IS NULL THEN RAISE EXCEPTION 'Task not available'; END IF;
 FOR task IN SELECT * FROM jsonb_array_elements(c.data->'tasks') LOOP
  tasks:=tasks||jsonb_build_array(CASE WHEN task->>'id'=p_task THEN task||jsonb_build_object('status',p_status,'reason',trim(coalesce(p_reason,''))) ELSE task END);
 END LOOP;
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,own_user);
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',own_user,'name',actor_name),'action','task.updated','detail',(target->>'name')||': '||p_status);
 UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'tasks',tasks,'log',(c.data->'log')||jsonb_build_array(entry)) WHERE id=c.id;
 RETURN c.employment_id;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_self_task(uuid,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_self_task(uuid,integer,text,text,text) TO ai_hr_app;

-- Definition deletion uses current and historical instances from both canonical case owners.
-- This helper exposes only identifiers, never answers, signatures, email text or Personnel facts.
CREATE FUNCTION app.lc_v9_usage_instances()
RETURNS TABLE(parent_id uuid,document_id text,template_id text,version_text text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH instances AS (
  SELECT c.id AS parent_id,d.value AS document FROM lc_v9_case c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d WHERE c.tenant_id=app.current_tenant_id()
  UNION ALL SELECT c.case_id,d.value FROM lc_v9_case_revision c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'documents','[]'::jsonb)) d WHERE c.tenant_id=app.current_tenant_id()
  UNION ALL SELECT p.case_id,d.value FROM lc_onboarding_private p CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d WHERE p.tenant_id=app.current_tenant_id()
  UNION ALL SELECT p.case_id,d.value FROM lc_onboarding_private_revision p CROSS JOIN LATERAL jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d WHERE p.tenant_id=app.current_tenant_id()
 )
 SELECT parent_id,document->>'id',document->>'templateId',document->>'version' FROM instances
$$;
REVOKE ALL ON FUNCTION app.lc_v9_usage_instances() FROM PUBLIC;

CREATE FUNCTION app.lc_v9_document_usage()
RETURNS TABLE(template_id text,version integer,documents integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.is_group_admin() OR app.login_blocked(app.current_user_id()) THEN RAISE EXCEPTION 'Group administration access is required'; END IF;
 IF EXISTS(SELECT 1 FROM app.lc_v9_usage_instances() i WHERE coalesce(i.document_id,'')='' OR coalesce(i.template_id,'')='' OR coalesce(i.version_text,'')!~'^[1-9][0-9]{0,8}$') THEN
  RAISE EXCEPTION 'Lifecycle document history needs review before deleting definitions';
 END IF;
 RETURN QUERY SELECT i.template_id,i.version_text::integer,count(DISTINCT(i.parent_id,i.document_id))::integer
  FROM app.lc_v9_usage_instances() i GROUP BY i.template_id,i.version_text;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_document_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_document_usage() TO ai_hr_app;

-- Group-admin aggregates preserve queued messages and frozen workflow references without exposing bodies.
CREATE FUNCTION app.lc_v9_definition_usage()
RETURNS TABLE(kind text,definition_id text,messages integer,runs integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.is_group_admin() OR app.login_blocked(app.current_user_id()) THEN RAISE EXCEPTION 'Group administration access is required'; END IF;
 RETURN QUERY WITH records AS (
  SELECT c.id AS parent_id,c.data FROM lc_v9_case c WHERE c.tenant_id=app.current_tenant_id()
  UNION ALL SELECT c.case_id,c.data FROM lc_v9_case_revision c WHERE c.tenant_id=app.current_tenant_id()
  UNION ALL SELECT p.case_id,p.data->'lifecycleV9' FROM lc_onboarding_private p WHERE p.tenant_id=app.current_tenant_id()
  UNION ALL SELECT p.case_id,p.data->'lifecycleV9' FROM lc_onboarding_private_revision p WHERE p.tenant_id=app.current_tenant_id()
 ), refs AS (
  SELECT 'email'::text AS kind,m.value->>'templateId' AS definition_id,c.parent_id,m.value->>'id' AS record_id,'message'::text AS source
   FROM records c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'mails','[]'::jsonb)) m WHERE m.value->>'templateId' IS NOT NULL
  UNION ALL SELECT CASE WHEN s.value->>'type'='email' THEN 'email' ELSE 'document' END,s.value->>'template',c.parent_id,r.value->>'id','run'
   FROM records c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'runs','[]'::jsonb)) r
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.value->'definition'->'steps','[]'::jsonb)) s
   WHERE s.value->>'type' IN ('doc','waitSign','email') AND coalesce(s.value->>'template','')<>''
 ) SELECT f.kind,f.definition_id,(count(DISTINCT(f.parent_id,f.record_id)) FILTER(WHERE source='message'))::integer,
  (count(DISTINCT(f.parent_id,f.record_id)) FILTER(WHERE source='run'))::integer FROM refs f GROUP BY f.kind,f.definition_id;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_definition_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_definition_usage() TO ai_hr_app;

-- Source V9 openLoad counts native joiner group tasks and claimed equipment work globally.
-- Offboarding uses this shared owner projection plus its temporary new-case load; existing
-- leaver work is deliberately not added to the source algorithm. Only aggregate counts leave SQL.
CREATE OR REPLACE FUNCTION app.onboarding_assignment_loads()
RETURNS TABLE(user_id uuid,task_load bigint,last_auto text,pending_approvals bigint,lifetime_approvals bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH permitted AS (
 SELECT app.is_admin() OR app.onboarding_page_access() OR app.is_group_admin() OR EXISTS(
 SELECT 1 FROM lc_onboarding_config cfg,jsonb_array_elements(cfg.data->'groups') g
 WHERE cfg.tenant_id=app.current_tenant_id() AND (g->'members') ? app.current_user_id()::text) AS ok
 ), cs AS (SELECT c.data FROM lc_onboarding_case c,permitted WHERE c.tenant_id=app.current_tenant_id() AND permitted.ok),
 tasks AS (SELECT c.data->>'state' AS case_state,t FROM cs c,jsonb_array_elements(c.data->'tasks') t),
 claimed_items AS (SELECT i FROM cs c,jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i WHERE c.data->>'state'='submitted' AND r->>'cancelledAt' IS NULL AND i->>'removed'='false' AND i->>'state' NOT IN ('ready','handed')),
 past_tasks AS (SELECT t FROM cs c,jsonb_array_elements(coalesce(c.data->'taskHistory','[]'::jsonb)) h,jsonb_array_elements(h) t),
 auto_history AS (SELECT a FROM (SELECT t FROM tasks UNION ALL SELECT t FROM past_tasks) x,jsonb_array_elements(coalesce(t->'autoAssignments','[]'::jsonb)) a),
 steps AS (SELECT c.data->>'state' AS case_state,r,i,s FROM cs c,jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i,jsonb_array_elements(i->'steps') s WHERE s->>'type' IN ('group','routing')),
 assigned AS (SELECT a FROM steps,jsonb_array_elements(coalesce(s->'assignments','[]'::jsonb)) a)
 SELECT u.id,
 (SELECT count(*) FROM tasks WHERE case_state='submitted' AND t->>'by'='group' AND t->>'assignee'=u.id::text AND t->>'status'<>'done') + (SELECT count(*) FROM claimed_items WHERE i->>'claim'=u.id::text),
 (SELECT max(a->>'at') FROM auto_history WHERE a->>'user'=u.id::text),
 (SELECT count(*) FROM steps WHERE case_state='submitted' AND r->>'cancelledAt' IS NULL AND i->>'removed'='false' AND i->>'approval'='pending' AND s->>'status'='pending' AND s->>'user'=u.id::text),
 (SELECT count(*) FROM assigned WHERE a->>'user'=u.id::text)
 FROM app_user u,permitted WHERE u.tenant_id=app.current_tenant_id() AND permitted.ok AND NOT app.login_blocked(u.id)
$$;
REVOKE ALL ON FUNCTION app.onboarding_assignment_loads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_assignment_loads() TO ai_hr_app;

-- HR case assignment shares the existing availability-only Leave projection.
CREATE OR REPLACE FUNCTION app.onboarding_unavailable(p_dates date[]) RETURNS TABLE(user_id uuid,on_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH members AS (
 SELECT DISTINCT (jsonb_array_elements_text(g->'members'))::uuid AS id
 FROM lc_onboarding_config c,jsonb_array_elements(c.data->'groups') g
 WHERE c.tenant_id=app.current_tenant_id() AND (app.is_admin() OR app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin() OR app.onboarding_group_member(g->>'id'))
 ), dates AS (SELECT DISTINCT unnest(p_dates) d LIMIT 400)
 SELECT DISTINCT u.id,dates.d FROM members m JOIN app_user u ON u.id=m.id AND u.tenant_id=app.current_tenant_id()
 JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN leave_request lr ON lr.employment_id=e.id AND lr.tenant_id=e.tenant_id
 CROSS JOIN dates
 WHERE (
 EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id AND ld.leave_date=dates.d AND ld.status='approved')
 OR (lr.status='approved' AND dates.d BETWEEN lr.start_date AND lr.end_date
 AND NOT EXISTS(SELECT 1 FROM leave_request_date ld WHERE ld.leave_request_id=lr.id)))
$$;
REVOKE ALL ON FUNCTION app.onboarding_unavailable(date[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_unavailable(date[]) TO ai_hr_app;

-- Native group deletion checks opaque references without exposing offboarding cases or communication content.
CREATE OR REPLACE FUNCTION app.onboarding_v9_group_references() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH permitted AS (
  SELECT app.current_tenant_id() AS tenant_id WHERE app.current_user_id() IS NOT NULL
  AND NOT app.login_blocked(app.current_user_id())
  AND (app.is_group_admin() OR EXISTS(SELECT 1 FROM lc_onboarding_config n WHERE n.tenant_id=app.current_tenant_id() AND n.data->'access'->'onboarding' ? app.current_user_id()::text))
 ), cfg AS (SELECT c.data FROM lc_v9_config c JOIN permitted p ON p.tenant_id=c.tenant_id),
 roles AS (
  SELECT jsonb_array_elements_text(coalesce(e->'cc','[]'::jsonb)) AS role FROM cfg,jsonb_array_elements(data->'emails') e
  UNION ALL
  SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(s->'to')='array' THEN s->'to' WHEN s ? 'to' THEN jsonb_build_array(s->'to') ELSE '[]'::jsonb END || coalesce(s->'cc','[]'::jsonb)) FROM cfg,jsonb_array_elements(data->'workflows') w,jsonb_array_elements(w->'steps') s
 ), refs AS (
  SELECT data->>'peopleOpsGroup' AS id FROM cfg
  UNION ALL SELECT t->>'group' FROM cfg,jsonb_array_elements(data->'checklists') cl,jsonb_array_elements(cl->'tasks') t
  UNION ALL SELECT substring(role FROM 7) FROM roles WHERE role LIKE 'group:%'
  UNION ALL SELECT t->>'group' FROM lc_v9_case c JOIN permitted p ON p.tenant_id=c.tenant_id,jsonb_array_elements(coalesce(c.data->'tasks','[]'::jsonb)||coalesce(c.data->'items','[]'::jsonb)) t
   WHERE c.module='off' AND c.data->>'state' IN ('pending','submitted') AND t->>'status' NOT IN ('done','notNeeded')
 ) SELECT coalesce(array_agg(DISTINCT id ORDER BY id) FILTER(WHERE nullif(id,'') IS NOT NULL),ARRAY[]::text[]) FROM refs
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_group_references() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_group_references() TO ai_hr_app;

-- Only shared checklist definitions cross this projection; document bodies and case data stay private.
CREATE OR REPLACE FUNCTION app.onboarding_v9_checklists() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('revision',c.revision,'caseFields',c.data->'caseForms'->'onb','at',to_char(coalesce((SELECT min(r.created_at) FROM lc_v9_config_revision r WHERE r.tenant_id=c.tenant_id),c.updated_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'owner',(
   SELECT r.actor_user_id FROM lc_v9_config_revision r WHERE r.tenant_id=c.tenant_id AND r.actor_user_id IS NOT NULL ORDER BY r.revision LIMIT 1
 ),'checklists',coalesce((SELECT jsonb_agg(x ORDER BY ord) FROM jsonb_array_elements(c.data->'checklists') WITH ORDINALITY AS d(x,ord) WHERE x->>'module'='onb'),'[]'::jsonb))
 FROM lc_v9_config c WHERE c.tenant_id=app.current_tenant_id() AND (
 (app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL))
 OR (app.current_user_id() IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper))))
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_checklists() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_checklists() TO ai_hr_app;

-- Module editors may use ordinary case fields without gaining HR-private source or answer access.
CREATE OR REPLACE FUNCTION app.onboarding_v9_case_values(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_onboarding_case%ROWTYPE; p jsonb; cfg jsonb; result jsonb; hr boolean;
BEGIN
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) OR NOT app.onboarding_v9_page_reader() THEN RETURN NULL; END IF;
 SELECT * INTO c FROM lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id(); IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT data INTO p FROM lc_onboarding_private WHERE case_id=c.id AND tenant_id=c.tenant_id;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=c.tenant_id;
 hr:=app.is_admin_for(c.company_id) AND app.onboarding_v9_sections()->>'hr'='view';
 SELECT jsonb_build_object('caseValues',coalesce(jsonb_object_agg(a.key,a.value) FILTER(WHERE hr OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'caseForms'->'onb','[]'::jsonb)) f WHERE f->>'key'=a.key AND coalesce((f->>'hrOnly')::boolean,false)=false)),'{}'::jsonb)) INTO result FROM jsonb_each(coalesce(p->'caseValues','{}'::jsonb)) a;
 IF p ? 'caseContactEmail' AND (hr OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'caseForms'->'onb','[]'::jsonb)) f WHERE f->>'key'='email' AND f->>'hrOnly'='true')) THEN result:=result||jsonb_build_object('caseContactEmail',p->'caseContactEmail'); END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_case_values(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_case_values(uuid) TO ai_hr_app;

CREATE OR REPLACE FUNCTION app.onboarding_v9_save_case_values(p_case uuid,p_revision integer,p_patch jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_onboarding_case%ROWTYPE; prior jsonb; cfg jsonb; answers jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) OR NOT app.onboarding_v9_case_actor() OR app.onboarding_v9_sections()->>'case'<>'view' THEN RAISE EXCEPTION 'Onboarding case actions are required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0));
 SELECT * INTO c FROM lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR c.revision<>p_revision OR c.data->>'state' NOT IN ('pending','submitted') OR NOT EXISTS(SELECT 1 FROM lc_onboarding_case written WHERE written.id=c.id AND written.xmin::text::bigint=(txid_current()%4294967296)) THEN RAISE EXCEPTION 'This case changed'; END IF;
 IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN ('caseValues','caseContactEmail')) THEN RAISE EXCEPTION 'Invalid case field patch'; END IF;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=c.tenant_id;
 answers:=coalesce(p_patch->'caseValues','{}'::jsonb);
 IF jsonb_typeof(answers) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_each(answers))>100 OR EXISTS(SELECT 1 FROM jsonb_each(answers) a WHERE jsonb_typeof(a.value)<>'string' OR length(a.value#>>'{}')>10000 OR a.key IN ('name','empNo','joinInput','position','dept','company','group','supervisor','ta','hireType','replacing','email','floor','costCentre','icNo','passportNo','notes','__proto__','constructor','prototype') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'caseForms'->'onb','[]'::jsonb)) f WHERE f->>'key'=a.key AND coalesce((f->>'hrOnly')::boolean,false)=false)) THEN RAISE EXCEPTION 'This case field requires HR access or is unavailable'; END IF;
 IF p_patch ? 'caseContactEmail' AND (jsonb_typeof(p_patch->'caseContactEmail')<>'string' OR length(p_patch->>'caseContactEmail')>254 OR (p_patch->>'caseContactEmail')<>'' AND (p_patch->>'caseContactEmail') !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(cfg->'caseForms'->'onb','[]'::jsonb)) f WHERE f->>'key'='email' AND f->>'hrOnly'='true')) THEN RAISE EXCEPTION 'This case contact is unavailable'; END IF;
 SELECT data INTO prior FROM lc_onboarding_private WHERE case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;
 IF prior IS NOT NULL THEN INSERT INTO lc_onboarding_private_revision(case_id,revision,tenant_id,company_id,data) VALUES(c.id,c.revision-1,c.tenant_id,c.company_id,prior) ON CONFLICT DO NOTHING; END IF;
 prior:=coalesce(prior,jsonb_build_object('source','{}'::jsonb,'local','{}'::jsonb));
 prior:=jsonb_set(prior,'{caseValues}',coalesce(prior->'caseValues','{}'::jsonb)||answers,true);
 IF p_patch ? 'caseContactEmail' THEN prior:=jsonb_set(prior,'{caseContactEmail}',p_patch->'caseContactEmail',true); END IF;
 INSERT INTO lc_onboarding_private(case_id,tenant_id,company_id,data) VALUES(c.id,c.tenant_id,c.company_id,prior) ON CONFLICT(case_id) DO UPDATE SET data=EXCLUDED.data;
END;
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_save_case_values(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_save_case_values(uuid,integer,jsonb) TO ai_hr_app;

-- A linked employee sees released native documents and their own tasks, never HR-private proposals or drafts.
CREATE OR REPLACE FUNCTION app.onboarding_v9_work() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',c.id,'number',c.data->>'number','module','onb','revision',c.revision,'state',CASE WHEN c.data->>'state'='pending' THEN 'pending' ELSE c.data->>'state' END,
 'facts',jsonb_build_object('name',coalesce(c.data->'source'->>'fullName',c.data->'local'->>'fullName',''),'joinDate',coalesce(c.data->'source'->>'joinDate',c.data->'local'->>'joinDate',''),'lastDay','','company',c.company_id,'employmentId',c.employment_id,'personId',e.person_id,'employeeUserId',u.id),
 'tasks',coalesce((SELECT jsonb_agg(t||jsonb_build_object('by',CASE WHEN t->>'by'='joiner' THEN 'employee' ELSE t->>'by' END,'assignmentFailure',t->'failure','reason','')) FROM jsonb_array_elements(c.data->'tasks') t WHERE t->>'by'='joiner' OR t->>'assignee'=u.id::text),'[]'::jsonb),
 'equipment',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i->>'id','name',i->>'name','kind',i->>'type','state',i->>'state','approval',i->>'approval','handedAt',r->'handedAt','receipt',i->'employeeReceipt')) FROM jsonb_array_elements(c.data->'requisitions') r,jsonb_array_elements(r->'items') i WHERE r->>'cancelledAt' IS NULL AND coalesce((i->>'removed')::boolean,false)=false AND i->>'approval' NOT IN ('rejected','withdrawn')),'[]'::jsonb),
 'items','[]'::jsonb,'documents',coalesce((SELECT jsonb_agg(d) FROM jsonb_array_elements(coalesce(p.data->'lifecycleV9'->'documents','[]'::jsonb)) d WHERE d->>'status' IN ('sent','opened','completed','signed','acknowledged','countersign')),'[]'::jsonb),'own',true)
 FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
 JOIN employment e ON e.id=c.employment_id AND e.person_id::text=c.data->>'personId' AND e.tenant_id=c.tenant_id AND e.company_id=c.company_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL
 WHERE c.tenant_id=app.current_tenant_id() AND NOT app.login_blocked(u.id) AND p.data ? 'lifecycleV9' AND p.data->'lifecycleV9Subject'->>'employmentId'=e.id::text AND p.data->'lifecycleV9Subject'->>'personId'=e.person_id::text
 ORDER BY c.created_at,c.id
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_work() TO ai_hr_app;

-- Shared catalogue deletion sees opaque V9 references, never private case content.
CREATE OR REPLACE FUNCTION app.onboarding_v9_catalogue_references() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH permitted AS (
  SELECT app.current_tenant_id() AS tenant_id WHERE app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id())
  AND (app.is_group_admin() OR EXISTS(SELECT 1 FROM lc_onboarding_config n WHERE n.tenant_id=app.current_tenant_id() AND n.data->'access'->'onboarding' ? app.current_user_id()::text))
 ), refs AS (
  SELECT jsonb_array_elements_text(coalesce(c.data->'returnSelections','[]'::jsonb)) AS id FROM lc_v9_case c JOIN permitted p ON p.tenant_id=c.tenant_id WHERE c.module='off' AND c.data->>'state'='pending'
  UNION ALL SELECT i->>'sourceCatalogueId' FROM lc_v9_case c JOIN permitted p ON p.tenant_id=c.tenant_id,jsonb_array_elements(c.data->'items') i WHERE c.module='off'
 ) SELECT coalesce(array_agg(DISTINCT id ORDER BY id) FILTER(WHERE nullif(id,'') IS NOT NULL),ARRAY[]::text[]) FROM refs
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_catalogue_references() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_catalogue_references() TO ai_hr_app;

-- Narrow self receipt: only the linked employee, current revision and an actually handed item.
CREATE OR REPLACE FUNCTION app.onboarding_v9_receipt(p_id uuid,p_revision integer,p_item text,p_status text,p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_onboarding_case%ROWTYPE; prior jsonb; req jsonb; item jsonb; target jsonb; reqs jsonb:='[]'::jsonb; items jsonb; entry jsonb; actor_name text; uid uuid:=app.current_user_id(); found_item boolean:=false;
BEGIN
 IF uid IS NULL OR app.login_blocked(uid) OR p_status IS NULL OR p_status NOT IN ('received','problem') OR p_note IS NULL OR length(p_note)>4000 OR (p_status='problem' AND length(trim(p_note))=0) THEN RAISE EXCEPTION 'Equipment receipt not available'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('audit-chain:' || app.current_tenant_id()::text));
 PERFORM pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text || ':onboarding',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('lifecycle-v9:' || app.current_tenant_id()::text,0));
 SELECT x.* INTO c FROM lc_onboarding_case x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id AND e.company_id=x.company_id AND e.person_id::text=x.data->>'personId'
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=uid AND u.archived_at IS NULL
 WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND OR c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Equipment receipt not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT data INTO prior FROM lc_onboarding_private WHERE case_id=c.id AND tenant_id=c.tenant_id FOR UPDATE;
 IF prior->'lifecycleV9' IS NULL OR prior->'lifecycleV9Subject'->>'employmentId' IS DISTINCT FROM c.employment_id::text OR prior->'lifecycleV9Subject'->>'personId' IS DISTINCT FROM c.data->>'personId' THEN RAISE EXCEPTION 'Equipment receipt not available'; END IF;
 FOR req IN SELECT * FROM jsonb_array_elements(c.data->'requisitions') LOOP
  items:='[]'::jsonb;
  FOR item IN SELECT * FROM jsonb_array_elements(req->'items') LOOP
   IF item->>'id'=p_item THEN
    IF found_item OR req->>'cancelledAt' IS NOT NULL OR req->>'handedAt' IS NULL OR item->>'state'<>'handed' OR coalesce((item->>'removed')::boolean,false) OR item->>'approval' IN ('rejected','withdrawn','pending') OR item->'recovery' IS NOT NULL OR item->'employeeReceipt'->>'status'='received' THEN RAISE EXCEPTION 'Equipment receipt not available'; END IF;
    found_item:=true;target:=item;
    item:=item||jsonb_build_object('employeeReceipt',jsonb_build_object('status',p_status,'at',now(),'by',uid,'note',trim(p_note)));
   END IF;
   items:=items||jsonb_build_array(item);
  END LOOP;
  reqs:=reqs||jsonb_build_array(req||jsonb_build_object('items',items));
 END LOOP;
 IF NOT found_item THEN RAISE EXCEPTION 'Equipment receipt not available'; END IF;
 SELECT coalesce(p.full_name,'User') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=uid AND u.tenant_id=c.tenant_id AND u.archived_at IS NULL;
 entry:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'by',uid,'name',actor_name,'action','equipment.'||p_status,'detail',target->>'name');
 INSERT INTO lc_onboarding_case_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data);
 INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(c.tenant_id,c.id,c.company_id,c.revision,prior);
 UPDATE lc_onboarding_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('requisitions',reqs,'history',coalesce(c.data->'history','[]'::jsonb)||jsonb_build_array(entry)) WHERE id=c.id AND tenant_id=c.tenant_id;
 -- Preserve the paired private snapshot and all document/signature/proposal owners unchanged.
 UPDATE lc_onboarding_private SET data=prior WHERE case_id=c.id AND tenant_id=c.tenant_id;
 RETURN c.employment_id;
END;
$$;
REVOKE ALL ON FUNCTION app.onboarding_v9_receipt(uuid,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_v9_receipt(uuid,integer,text,text,text) TO ai_hr_app;

-- Read-only shell metadata for existing Onboarding module users. No offboarding settings,
-- company signers, recipient addresses, templates, salary policy or case/private content.
CREATE OR REPLACE FUNCTION app.lc_v9_onboarding_shell() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('version',9,'revision',v.revision,'groupsRevision',n.revision,'groups',n.data->'groups',
 'peopleOpsGroup',v.data->'peopleOpsGroup','checklists',coalesce((SELECT jsonb_agg(c) FROM jsonb_array_elements(v.data->'checklists') c WHERE c->>'module'='onb'),'[]'::jsonb),
 'templates','[]'::jsonb,'emails','[]'::jsonb,'workflows','[]'::jsonb,'bpRules','[]'::jsonb)
 FROM lc_v9_config v JOIN lc_onboarding_config n ON n.tenant_id=v.tenant_id WHERE v.tenant_id=app.current_tenant_id()
 AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND (app.onboarding_v9_page_reader() OR app.onboarding_v9_record_reader())
$$;
REVOKE ALL ON FUNCTION app.lc_v9_onboarding_shell() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_onboarding_shell() TO ai_hr_app;
