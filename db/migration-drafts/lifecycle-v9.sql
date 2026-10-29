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
 case_id uuid NOT NULL REFERENCES lc_v9_case(id), company_id uuid NOT NULL REFERENCES company(id),
 document_id text, slot text NOT NULL, filename text NOT NULL, mime_type text NOT NULL,
 content bytea NOT NULL CHECK(octet_length(content)<=10485760),
 uploaded_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE POLICY v9_case_read ON lc_v9_case FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_case_insert ON lc_v9_case FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_case_update ON lc_v9_case FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_case_revision_read ON lc_v9_case_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_case_revision_append ON lc_v9_case_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_file_read ON lc_v9_file FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY v9_file_append ON lc_v9_file FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND uploaded_by=app.current_user_id());
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
DECLARE row_data jsonb:=to_jsonb(NEW); parent lc_v9_case%ROWTYPE; subject employment%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='lc_v9_case' THEN
  SELECT * INTO subject FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
  IF NOT FOUND OR NEW.data->'facts'->>'personId' IS DISTINCT FROM subject.person_id::text THEN RAISE EXCEPTION 'Lifecycle subject does not belong to this company'; END IF;
  IF NEW.data->>'id' IS DISTINCT FROM NEW.id::text OR NEW.data->>'module' IS DISTINCT FROM NEW.module OR NEW.data->'facts'->>'company' IS DISTINCT FROM NEW.company_id::text OR NEW.data->'facts'->>'employmentId' IS DISTINCT FROM NEW.employment_id::text THEN RAISE EXCEPTION 'Lifecycle case subject mismatch'; END IF;
  IF NEW.data->>'version' IS DISTINCT FROM '9' OR coalesce(NEW.data->>'state','') NOT IN ('pending','submitted','cleared','cancelled') OR (NEW.data->>'revision')::integer IS DISTINCT FROM NEW.revision THEN RAISE EXCEPTION 'Invalid lifecycle state or revision'; END IF;
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

CREATE FUNCTION app.lc_v9_self_document(p_id uuid,p_revision integer,p_document text,p_values jsonb,p_signature jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_v9_case%ROWTYPE; d jsonb; f jsonb; t jsonb; cfg jsonb; actor_name text;
 key text; value jsonb; vals jsonb; next_docs jsonb:='[]'::jsonb; next_tasks jsonb:='[]'::jsonb;
 next_pm jsonb; signing boolean:=p_signature IS NOT NULL; next_status text; changes jsonb; own_user uuid:=app.current_user_id();
BEGIN
 IF own_user IS NULL OR app.login_blocked(own_user) OR p_values IS NULL OR jsonb_typeof(p_values)<>'object' OR octet_length(p_values::text)>1048576 THEN RAISE EXCEPTION 'Invalid document command'; END IF;
 SELECT x.* INTO c FROM lc_v9_case x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.id=own_user AND u.archived_at IS NULL
 WHERE x.id=p_id AND x.tenant_id=app.current_tenant_id() FOR UPDATE OF x;
 IF NOT FOUND OR c.data->>'state'<>'submitted' THEN RAISE EXCEPTION 'Document not available'; END IF;
 IF c.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'This case changed. Refresh before trying again.'; END IF;
 SELECT x INTO d FROM jsonb_array_elements(c.data->'documents') x WHERE x->>'id'=p_document AND x->>'status' IN ('sent','opened');
 IF d IS NULL THEN RAISE EXCEPTION 'Document is not open for completion'; END IF;
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
  IF coalesce(p_signature->>'method','') NOT IN ('typed','drawn') OR coalesce(p_signature->>'consent','')<>'true' OR length(trim(coalesce(p_signature->>'value','')))=0 OR octet_length(p_signature::text)>524288 THEN RAISE EXCEPTION 'Confirm consent and provide your signature'; END IF;
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
  IF signing AND next_status IN ('signed','acknowledged') AND t->>'documentTemplate'=d->>'templateId' AND t->>'documentAction' IN ('signed','completed') THEN t:=t||jsonb_build_object('status','done'); END IF;
  next_tasks:=next_tasks||jsonb_build_array(t);
 END LOOP;
 INSERT INTO lc_v9_case_revision(tenant_id,case_id,company_id,revision,data,actor_user_id) VALUES(c.tenant_id,c.id,c.company_id,c.revision,c.data,own_user);
 changes:=jsonb_build_object('id',gen_random_uuid(),'at',now(),'actor',jsonb_build_object('id',own_user,'name',actor_name),'action',CASE WHEN signing THEN 'document.signed' ELSE 'document.saved' END,'detail',d->>'name');
 UPDATE lc_v9_case SET revision=c.revision+1,updated_at=now(),data=c.data||jsonb_build_object('revision',c.revision+1,'documents',next_docs,'tasks',next_tasks,'pmChanges',next_pm,'log',(c.data->'log')||jsonb_build_array(changes)) WHERE id=c.id;
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
