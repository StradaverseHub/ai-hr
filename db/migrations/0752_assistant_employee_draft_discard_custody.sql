-- Coordinator-allocated UNAPPLIED DEVELOPMENT0752_assistant_employee_draft_discard_custody / idx731 / version7 / when1793330000089.
-- Root owns copy/journal. No CREATE ROLE/provisioning or installation authority; child prerequisite required.
DO $preflight$
DECLARE child oid; app_role oid; owner_role oid; attrs record; app_attrs record; migration_super boolean;
BEGIN
 SELECT oid INTO child FROM pg_catalog.pg_roles WHERE rolname='ai_hr_draft_discard_port';
 SELECT oid INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT relowner INTO owner_role FROM pg_catalog.pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 IF current_user<>pg_catalog.pg_get_userbyid(owner_role) THEN RAISE EXCEPTION 'draft-discard: exact ledger owner required';END IF;
 IF child IS NULL OR app_role IS NULL THEN RAISE EXCEPTION 'draft-discard: operator role prerequisite missing';END IF;
 SELECT * INTO attrs FROM pg_catalog.pg_roles WHERE oid=child;
 SELECT * INTO app_attrs FROM pg_catalog.pg_roles WHERE oid=app_role;
 SELECT rolsuper INTO migration_super FROM pg_catalog.pg_roles WHERE rolname=current_user;
 IF NOT app_attrs.rolcanlogin OR app_attrs.rolsuper OR app_attrs.rolbypassrls OR app_attrs.rolcreaterole
  OR app_attrs.rolcreatedb OR app_attrs.rolreplication THEN RAISE EXCEPTION 'draft-discard: app role attributes';END IF;
 IF NOT attrs.rolinherit OR attrs.rolcanlogin OR attrs.rolsuper OR attrs.rolbypassrls OR attrs.rolcreaterole OR attrs.rolcreatedb OR attrs.rolreplication
  OR child=owner_role OR pg_catalog.pg_has_role(child,owner_role,'MEMBER') OR pg_catalog.pg_has_role(app_role,child,'MEMBER')
  OR NOT pg_catalog.pg_has_role(child,app_role,'USAGE') OR pg_catalog.pg_has_role(child,app_role,'SET')
  -- Disposable hosted SUPER migration owner cannot reproduce negative pg_has_role semantics.
  -- Only these two migration-owner checks are skipped; all real app/child/owner/RLS gates remain.
  OR (NOT migration_super AND (NOT pg_catalog.pg_has_role(current_user,child,'SET') OR pg_catalog.pg_has_role(current_user,child,'USAGE'))) THEN
  RAISE EXCEPTION 'draft-discard: incompatible role graph';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=app_role AND member=child AND inherit_option AND NOT set_option AND NOT admin_option)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=child AND roleid<>app_role)
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='app' AND (pg_catalog.has_schema_privilege('ai_hr_app',oid,'CREATE') OR pg_catalog.has_schema_privilege(child,oid,'CREATE'))) THEN
  RAISE EXCEPTION 'draft-discard: role/schema privilege prerequisite';END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE oid IN('public.employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) AND (relowner=child OR relowner=app_role OR pg_catalog.pg_has_role(child,relowner,'MEMBER') OR pg_catalog.pg_has_role(app_role,relowner,'MEMBER') OR NOT relrowsecurity)) THEN
  RAISE EXCEPTION 'draft-discard: RLS owner prerequisite';END IF;
END $preflight$;
--> statement-breakpoint
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.draft.discard','employees','approve','personnel','employees.draft.discard');
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN draft_discard_source jsonb,
 ADD COLUMN draft_discard_source_xmin text,
 ADD COLUMN draft_discard_source_ctid tid,
 ADD COLUMN draft_discard_delete_witness jsonb,
 ADD COLUMN draft_discard_delete_xid xid8,
 ADD COLUMN draft_discard_capture_xid xid8;
--> statement-breakpoint
-- Short independent closure; do not duplicate historical CHECK trees. Let sibling hybrid attempts
-- reach the 23514 constraint, rather than a new-kind guard raising a different SQLSTATE.
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_draft_discard_private_columns CHECK (coalesce(
 CASE WHEN action_kind='employees.draft.discard' THEN
  (draft_discard_source IS NULL AND draft_discard_source_xmin IS NULL AND draft_discard_source_ctid IS NULL
   AND draft_discard_delete_witness IS NULL AND draft_discard_delete_xid IS NULL AND draft_discard_capture_xid IS NULL)
  OR (state IN('awaiting_confirmation','completed') AND pg_catalog.jsonb_typeof(draft_discard_source)='object'
   AND draft_discard_capture_xid IS NOT NULL
   AND draft_discard_source ?& ARRAY['rowDigest','sourceDigest','counterKind','counterBefore','counterXmin','configId','number','code','authorIsActor']
   AND draft_discard_source-ARRAY['rowDigest','sourceDigest','counterKind','counterBefore','counterXmin','configId','number','code','authorIsActor']='{}'::jsonb
   AND pg_catalog.jsonb_typeof(draft_discard_source->'rowDigest')='string' AND pg_catalog.jsonb_typeof(draft_discard_source->'sourceDigest')='string'
   AND pg_catalog.jsonb_typeof(draft_discard_source->'authorIsActor')='boolean'
   AND draft_discard_source->>'counterKind' IN('none','configured','legacy')
   AND pg_catalog.jsonb_typeof(draft_discard_source->'counterBefore') IN('object','null')
   AND pg_catalog.jsonb_typeof(draft_discard_source->'counterXmin') IN('string','null')
   AND pg_catalog.jsonb_typeof(draft_discard_source->'configId') IN('string','null')
   AND pg_catalog.jsonb_typeof(draft_discard_source->'number') IN('number','null')
   AND pg_catalog.jsonb_typeof(draft_discard_source->'code') IN('string','null')
   AND (state<>'completed' OR draft_discard_delete_witness IS NOT NULL)
   AND draft_discard_source_xmin ~ '^[0-9]+$'
   AND draft_discard_source_ctid IS NOT NULL
   AND draft_discard_source->>'rowDigest' ~ '^[a-f0-9]{64}$'
   AND draft_discard_source->>'sourceDigest' ~ '^[a-f0-9]{64}$'
   AND ((draft_discard_delete_witness IS NULL AND draft_discard_delete_xid IS NULL)
    OR (pg_catalog.jsonb_typeof(draft_discard_delete_witness)='object' AND draft_discard_delete_xid IS NOT NULL
     AND draft_discard_delete_witness ?& ARRAY['rowDigest','admittedAt']
     AND draft_discard_delete_witness-ARRAY['rowDigest','admittedAt']='{}'::jsonb
     AND pg_catalog.jsonb_typeof(draft_discard_delete_witness->'admittedAt')='string'
     AND draft_discard_delete_witness->>'admittedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
     AND draft_discard_delete_witness->>'rowDigest'=draft_discard_source->>'rowDigest')))
 ELSE draft_discard_source IS NULL AND draft_discard_source_xmin IS NULL AND draft_discard_source_ctid IS NULL
  AND draft_discard_delete_witness IS NULL AND draft_discard_delete_xid IS NULL AND draft_discard_capture_xid IS NULL END,false));
--> statement-breakpoint
DO $constraints$
DECLARE previous text; item record; found integer; actor_name text;
BEGIN
 SELECT pg_catalog.pg_get_expr(conbin,conrelid) INTO previous FROM pg_catalog.pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname='assistant_review_kind_columns';
 IF previous IS NULL THEN RAISE EXCEPTION 'draft-discard: missing kind constraint';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind=''employees.draft.discard'' THEN leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL ELSE ('||previous||') END)';
 SELECT pg_catalog.count(*),pg_catalog.min(conname) INTO found,actor_name FROM pg_catalog.pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND pg_catalog.pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%' AND pg_catalog.pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF found<>1 THEN RAISE EXCEPTION 'draft-discard: ambiguous actor constraint';END IF;
 FOR item IN SELECT * FROM (VALUES
  (actor_name,'employment_id IS NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
  ('assistant_review_decision_columns','decision_subject_person_id IS NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt','receipt_subject_kind=''employee_draft'' AND receipt_subject_id IS NOT NULL AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) x(name,expression) LOOP
  SELECT pg_catalog.pg_get_expr(conbin,conrelid) INTO previous FROM pg_catalog.pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION 'draft-discard: missing constraint %',item.name;END IF;
  EXECUTE pg_catalog.format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE pg_catalog.format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''employees.draft.discard'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $constraints$;
--> statement-breakpoint
DO $indexes$
DECLARE generic text; assigned text;
BEGIN
 SELECT pg_catalog.pg_get_expr(indpred,indrelid) INTO generic FROM pg_catalog.pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_catalog.pg_get_expr(indpred,indrelid) INTO assigned FROM pg_catalog.pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic IS NULL OR assigned IS NULL THEN RAISE EXCEPTION 'draft-discard: missing pending indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic||') AND action_kind<>''employees.draft.discard''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned||') OR (action_kind=''employees.draft.discard'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $indexes$;
--> statement-breakpoint
-- Pure serializer; no authority changes, no timezone SET affecting CURRENT_DATE/native policy.
CREATE FUNCTION app._draft_discard_row_digest(d public.employee_draft,p_xmin text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array('native-employee-draft-row:v1',pg_catalog.jsonb_build_array(
 d.id,d.tenant_id,d.company_id,d.created_by_person_id,d.label,d.data,d.current_step,
 d.reserved_employee_code,pg_catalog.to_char(d.reserved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 d.reserved_config_id,d.reserved_number,pg_catalog.to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 pg_catalog.to_char(d.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),p_xmin))::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION app._draft_discard_row_digest(public.employee_draft,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app._draft_discard_row_digest(public.employee_draft,text) TO ai_hr_draft_discard_port;
--> statement-breakpoint
-- Cheap gate BEFORE JSON serialization: reject compressed data and numeric JSONB (binary exponents
-- can expand disproportionally). Source handoff only; this is never a native GUI DELETE predicate.
CREATE FUNCTION app._draft_discard_source_snapshot(p_draft uuid,p_company uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE d public.employee_draft%ROWTYPE; rev text; physical tid; row_hash text; company_name text;
 counter_json jsonb; counter_rev text; counter_kind text:='none'; digest text; private jsonb;
BEGIN
 IF current_user<>'ai_hr_draft_discard_port' OR NOT pg_catalog.row_security_active('public.employee_draft'::regclass)
  OR NOT app.principal_snapshot_current() OR app.is_admin() IS NOT TRUE OR p_company IS NULL THEN
  RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 -- The outer source owner joins canonical Lifecycle before this source lock.
 PERFORM app.access_workforce_write_lock();
 IF NOT ((SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.employee_draft'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  IS NOT DISTINCT FROM ARRAY['company_id','created_at','created_by_person_id','current_step','data','id','label','reserved_at','reserved_config_id','reserved_employee_code','reserved_number','tenant_id','updated_at']::text[]) THEN RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 -- Project only metadata/storage guards first; never move a large data value to the receiver.
 SELECT x.xmin::text,x.ctid INTO rev,physical FROM public.employee_draft x
 WHERE x.id=p_draft AND x.tenant_id=app.current_tenant_id() AND x.company_id=p_company
 FOR UPDATE OF x NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.employee_draft x WHERE x.id=p_draft AND (
  pg_catalog.pg_column_compression(x.data) IS NOT NULL OR pg_catalog.pg_column_size(x.data)>65536
  OR pg_catalog.pg_column_compression(x.label) IS NOT NULL OR pg_catalog.pg_column_size(x.label)>8000
  OR pg_catalog.pg_column_compression(x.reserved_employee_code) IS NOT NULL OR coalesce(pg_catalog.pg_column_size(x.reserved_employee_code),0)>2048)) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 -- The uncompressed binary datum is now bounded. No numeric leaf is serialized; timestamps are UTC.
 IF EXISTS(SELECT 1 FROM public.employee_draft x WHERE x.id=p_draft AND pg_catalog.jsonb_path_exists(x.data,'strict $.** ? (@.type() == "number")')) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 SELECT x.* INTO d FROM public.employee_draft x WHERE x.id=p_draft;
 IF d.company_id IS DISTINCT FROM p_company OR pg_catalog.length(d.label)>2000 OR coalesce(pg_catalog.length(d.reserved_employee_code),0)>512
  OR d.reserved_number IS NOT NULL AND coalesce(d.reserved_employee_code,'')='' THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 IF EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=d.tenant_id AND
  (pg_catalog.pg_column_compression(c.legal_name) IS NOT NULL OR pg_catalog.pg_column_size(c.legal_name)>8000)) THEN
  RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
 SELECT c.legal_name INTO company_name FROM public.company c WHERE c.id=p_company AND c.tenant_id=d.tenant_id;
 IF company_name IS NULL OR pg_catalog.length(company_name)>2000 THEN RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 row_hash:=app._draft_discard_row_digest(d,rev);
 IF coalesce(d.reserved_employee_code,'')<>'' AND d.reserved_number IS NOT NULL THEN
  IF d.reserved_config_id IS NOT NULL THEN
   counter_kind:='configured';
   PERFORM 1 FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id FOR UPDATE OF c NOWAIT;
   IF EXISTS(SELECT 1 FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id AND (
    pg_catalog.pg_column_compression(c.template_name) IS NOT NULL OR coalesce(pg_catalog.pg_column_size(c.template_name),0)>8000
    OR pg_catalog.pg_column_compression(c.prefix) IS NOT NULL OR pg_catalog.pg_column_size(c.prefix)>8000
    OR pg_catalog.pg_column_compression(c.suffix) IS NOT NULL OR pg_catalog.pg_column_size(c.suffix)>8000
    OR pg_catalog.pg_column_compression(c.status) IS NOT NULL OR pg_catalog.pg_column_size(c.status)>8000)) THEN
    RAISE EXCEPTION 'Draft source out of bounds' USING ERRCODE='54000';END IF;
   SELECT (pg_catalog.to_jsonb(c)-'created_at'-'updated_at')||pg_catalog.jsonb_build_object(
    'created_at',pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updated_at',pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),c.xmin::text
   INTO counter_json,counter_rev FROM public.employee_id_config c WHERE c.id=d.reserved_config_id AND c.tenant_id=d.tenant_id FOR UPDATE OF c NOWAIT;
  ELSE
   counter_kind:='legacy';
   SELECT pg_catalog.to_jsonb(c),c.xmin::text INTO counter_json,counter_rev FROM public.tenant_counter c
   WHERE c.tenant_id=d.tenant_id AND c.kind='employee_code' FOR UPDATE OF c NOWAIT;
  END IF;
 END IF;
 private:=pg_catalog.jsonb_build_object('rowDigest',row_hash,'counterKind',counter_kind,'counterBefore',counter_json,
  'counterXmin',counter_rev,'configId',d.reserved_config_id,'number',d.reserved_number,'code',d.reserved_employee_code,
  'authorIsActor',coalesce(d.created_by_person_id IS NOT NULL AND d.created_by_person_id=(SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=d.tenant_id),false));
 digest:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array('draft-discard-source:v1',row_hash,rev,physical::text,
  private,p_company,company_name)::text,'UTF8')),'hex');
 private:=private||pg_catalog.jsonb_build_object('sourceDigest',digest);
 RETURN pg_catalog.jsonb_build_object('draftId',d.id,'companyId',p_company,'companyName',company_name,'label',d.label,
  'reservedEmployeeCode',d.reserved_employee_code,'reservedNumber',d.reserved_number,'sourceDigest',digest,
  'nativeRowDigest',row_hash,'xmin',rev,'ctid',physical::text,
  'counterBeforeDigest',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(counter_kind,counter_json,counter_rev)::text,'UTF8')),'hex'),
  'private',private);
END $$;
REVOKE ALL ON FUNCTION app._draft_discard_source_snapshot(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO ai_hr_draft_discard_port;
GRANT SELECT(action_kind,id,tenant_id,user_id,person_id,company_id,receipt_subject_kind,receipt_subject_id,state,expires_at,
 draft_discard_source,draft_discard_source_xmin,draft_discard_source_ctid,draft_discard_delete_witness,draft_discard_delete_xid,draft_discard_capture_xid)
 ON app.assistant_own_leave_review TO ai_hr_draft_discard_port;
GRANT UPDATE(draft_discard_delete_witness,draft_discard_delete_xid) ON app.assistant_own_leave_review TO ai_hr_draft_discard_port;
--> statement-breakpoint
CREATE POLICY draft_discard_port_read ON app.assistant_own_leave_review FOR SELECT TO ai_hr_draft_discard_port USING (
 action_kind='employees.draft.discard' AND receipt_subject_kind='employee_draft' AND tenant_id=app.current_tenant_id()
 AND user_id=app.current_user_id() AND state='awaiting_confirmation' AND app.is_admin() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
 AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id));
CREATE POLICY draft_discard_port_stamp ON app.assistant_own_leave_review FOR UPDATE TO ai_hr_draft_discard_port USING (
 action_kind='employees.draft.discard' AND receipt_subject_kind='employee_draft' AND tenant_id=app.current_tenant_id()
 AND user_id=app.current_user_id() AND state='awaiting_confirmation' AND draft_discard_capture_xid=pg_catalog.pg_current_xact_id() AND draft_discard_delete_witness IS NULL
 AND draft_discard_delete_xid IS NULL AND app.is_admin() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
 AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id))
WITH CHECK (
 action_kind='employees.draft.discard' AND receipt_subject_kind='employee_draft' AND tenant_id=app.current_tenant_id()
 AND user_id=app.current_user_id() AND state='awaiting_confirmation' AND draft_discard_capture_xid=pg_catalog.pg_current_xact_id() AND draft_discard_delete_witness IS NOT NULL
 AND draft_discard_delete_xid=pg_catalog.pg_current_xact_id()
 AND draft_discard_delete_witness->>'rowDigest'=draft_discard_source->>'rowDigest'
 AND app.is_admin() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
 AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND a.person_id IS NOT DISTINCT FROM assistant_own_leave_review.person_id));
--> statement-breakpoint
CREATE FUNCTION app.native_employee_draft_discard_delete(p_draft uuid) RETURNS TABLE(id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE candidate record; selected_id uuid; source jsonb; rev text; physical tid; company uuid;
 deleted record; count integer:=0; admitted timestamptz:=pg_catalog.clock_timestamp(); shape_ok boolean;
BEGIN
 IF current_user<>'ai_hr_draft_discard_port' OR NOT pg_catalog.row_security_active('public.employee_draft'::regclass)
  OR NOT pg_catalog.row_security_active('app.assistant_own_leave_review'::regclass) THEN
  RAISE EXCEPTION 'Draft delete role unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 -- Read-only nomination. Ordinary GUI has no current-TX arm and never enters Assistant's
 -- no-linked-case narrowing; the native lifecycle sync/release/audit course stays unchanged.
 SELECT r.company_id INTO company FROM app.assistant_own_leave_review r
 WHERE r.action_kind='employees.draft.discard' AND r.receipt_subject_kind='employee_draft'
  AND r.receipt_subject_id=p_draft AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
  AND r.state='awaiting_confirmation' AND r.expires_at>admitted AND r.draft_discard_capture_xid=pg_catalog.pg_current_xact_id()
  AND r.draft_discard_source IS NOT NULL AND r.draft_discard_delete_witness IS NULL;
 IF FOUND THEN
  IF app.onboarding_draft_discard_absence_context(p_draft,company,
   (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id())) IS NOT TRUE THEN
   RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
 END IF;
 FOR candidate IN SELECT r.id,r.company_id,r.draft_discard_source,r.draft_discard_source_xmin,r.draft_discard_source_ctid
 FROM app.assistant_own_leave_review r WHERE r.action_kind='employees.draft.discard' AND r.receipt_subject_kind='employee_draft'
  AND r.receipt_subject_id=p_draft AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
  AND r.state='awaiting_confirmation' AND r.expires_at>admitted AND r.draft_discard_capture_xid=pg_catalog.pg_current_xact_id() AND r.draft_discard_source IS NOT NULL
  AND r.draft_discard_delete_witness IS NULL AND app.is_admin()
 ORDER BY r.id FOR UPDATE OF r NOWAIT LOOP
  count:=count+1;IF count>1 THEN RAISE EXCEPTION 'Draft delete candidate ambiguous' USING ERRCODE='42501';END IF;
  selected_id:=candidate.id;source:=candidate.draft_discard_source;rev:=candidate.draft_discard_source_xmin;
  physical:=candidate.draft_discard_source_ctid;company:=candidate.company_id;
 END LOOP;
 shape_ok:=(SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.employee_draft'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  IS NOT DISTINCT FROM ARRAY['company_id','created_at','created_by_person_id','current_step','data','id','label','reserved_at','reserved_config_id','reserved_employee_code','reserved_number','tenant_id','updated_at']::text[];
 -- Lazy CASE is INSIDE actual DELETE RETURNING, before whole-row/hash expression evaluation.
 -- No d.* projection or OLD.data materialization when no exact bounded prepared version matches.
 DELETE FROM public.employee_draft d WHERE d.id=p_draft
 RETURNING d.id,d.tenant_id,d.company_id,d.xmin::text AS old_xmin,d.ctid AS old_ctid,
  CASE WHEN shape_ok AND selected_id IS NOT NULL AND d.company_id IS NOT DISTINCT FROM company
   AND d.xmin::text=rev AND d.ctid=physical
   THEN app._draft_discard_row_digest(d,d.xmin::text) ELSE NULL END AS row_digest INTO deleted;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft delete not found' USING ERRCODE='P0002';END IF;
 IF selected_id IS NOT NULL AND deleted.row_digest=source->>'rowDigest' THEN
  UPDATE app.assistant_own_leave_review r SET draft_discard_delete_witness=pg_catalog.jsonb_build_object('rowDigest',deleted.row_digest,
   'admittedAt',pg_catalog.to_char(admitted AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
   draft_discard_delete_xid=pg_catalog.pg_current_xact_id()
  WHERE r.id=selected_id AND r.tenant_id=deleted.tenant_id AND r.user_id=app.current_user_id()
   AND r.state='awaiting_confirmation' AND r.expires_at>admitted AND r.draft_discard_capture_xid=pg_catalog.pg_current_xact_id() AND r.draft_discard_source=source
   AND r.draft_discard_source_xmin=rev AND r.draft_discard_source_ctid=physical
   AND r.draft_discard_delete_witness IS NULL AND r.draft_discard_delete_xid IS NULL;
 END IF;
 RETURN QUERY SELECT deleted.id::uuid;
END $$;
REVOKE ALL ON FUNCTION app.native_employee_draft_discard_delete(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Invoker guard sees the actual child role on the stamping UPDATE. Other kinds deliberately pass
-- through to the independent five-NULL constraint (23514). No owner privileges inherited by child.
CREATE FUNCTION app._draft_discard_private_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_name name; stable boolean; old_empty boolean; new_empty boolean; allowed boolean:=false;
BEGIN
 IF NEW.action_kind<>'employees.draft.discard' AND (TG_OP='INSERT' OR OLD.action_kind<>'employees.draft.discard') THEN RETURN NEW;END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.draft_discard_delete_witness IS NOT NULL OR NEW.draft_discard_delete_xid IS NOT NULL THEN
   RAISE EXCEPTION 'Initial deletion witness forbidden' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 stable:=ROW(NEW.action_kind,NEW.id,NEW.tenant_id,NEW.user_id,NEW.person_id,NEW.company_id,NEW.receipt_subject_kind,NEW.receipt_subject_id)
  IS NOT DISTINCT FROM ROW(OLD.action_kind,OLD.id,OLD.tenant_id,OLD.user_id,OLD.person_id,OLD.company_id,OLD.receipt_subject_kind,OLD.receipt_subject_id);
 old_empty:=OLD.draft_discard_delete_witness IS NULL AND OLD.draft_discard_delete_xid IS NULL;
 new_empty:=NEW.draft_discard_delete_witness IS NULL AND NEW.draft_discard_delete_xid IS NULL;
 -- Child branch exits BEFORE any protected-owner/erasure lookup; it has no private intent privilege.
 IF current_user='ai_hr_draft_discard_port' THEN
  IF NOT old_empty OR new_empty OR NOT stable OR OLD.state<>'awaiting_confirmation' OR NEW.state<>OLD.state
   OR ROW(NEW.draft_discard_source,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid,NEW.draft_discard_capture_xid)
    IS DISTINCT FROM ROW(OLD.draft_discard_source,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid,OLD.draft_discard_capture_xid)
   OR NEW.draft_discard_delete_xid<>pg_catalog.pg_current_xact_id()
   OR NEW.draft_discard_delete_witness->>'rowDigest' IS DISTINCT FROM OLD.draft_discard_source->>'rowDigest'
   OR (NEW.draft_discard_delete_witness->>'admittedAt')::timestamptz>=OLD.expires_at THEN
   RAISE EXCEPTION 'Deletion witness unavailable' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 -- Procedural ownership gate before queries to protected privacy tables. Dynamic table owner, not GUC.
 SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO owner_name FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID;
 IF current_user<>owner_name THEN RAISE EXCEPTION 'Deletion witness owner unavailable' USING ERRCODE='42501';END IF;
 IF NOT stable THEN RAISE EXCEPTION 'Deletion witness binding immutable' USING ERRCODE='42501';END IF;
 IF NEW.state IN('discarded','expired','refused') THEN
  NEW.draft_discard_source:=NULL;NEW.draft_discard_source_xmin:=NULL;NEW.draft_discard_source_ctid:=NULL;
  NEW.draft_discard_delete_witness:=NULL;NEW.draft_discard_delete_xid:=NULL;NEW.draft_discard_capture_xid:=NULL;
  RETURN NEW;
 END IF;
 IF OLD.state='completed' AND NEW.state='completed'
  AND NEW.draft_discard_source IS NULL AND NEW.draft_discard_source_xmin IS NULL AND NEW.draft_discard_source_ctid IS NULL
  AND NEW.draft_discard_delete_witness IS NULL AND NEW.draft_discard_delete_xid IS NULL AND NEW.draft_discard_capture_xid IS NULL THEN
  SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i
   WHERE i.xact_id=pg_catalog.pg_current_xact_id() AND i.tenant_id=OLD.tenant_id AND i.user_id=app.current_user_id()
    AND i.person_id=OLD.person_id AND OLD.id=ANY(i.review_ids)) INTO allowed;
  IF allowed THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Deletion proof erasure unavailable' USING ERRCODE='42501';
 END IF;
 -- Closed source/prepare owner alone may arm an unstamped, unchanged private source tuple.
 -- The only public writer executing this branch first takes canonical helper and actual snapshot.
 IF old_empty AND new_empty AND OLD.state='awaiting_confirmation' AND NEW.state=OLD.state
  AND ROW(NEW.draft_discard_source,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid)
   IS NOT DISTINCT FROM ROW(OLD.draft_discard_source,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid)
  AND NEW.draft_discard_capture_xid=pg_catalog.pg_current_xact_id() THEN RETURN NEW;END IF;
 -- Even a no-op UPDATE would replace a child witness xmin: never permit pending stamped rewrites.
 IF NOT old_empty AND NEW.state='awaiting_confirmation' THEN RAISE EXCEPTION 'Pending witness immutable' USING ERRCODE='42501';END IF;
 IF ROW(NEW.draft_discard_source,NEW.draft_discard_source_xmin,NEW.draft_discard_source_ctid,NEW.draft_discard_delete_witness,NEW.draft_discard_delete_xid,NEW.draft_discard_capture_xid)
  IS DISTINCT FROM ROW(OLD.draft_discard_source,OLD.draft_discard_source_xmin,OLD.draft_discard_source_ctid,OLD.draft_discard_delete_witness,OLD.draft_discard_delete_xid,OLD.draft_discard_capture_xid) THEN
  RAISE EXCEPTION 'Deletion source immutable' USING ERRCODE='42501';END IF;
 IF NEW.state='completed' AND OLD.state='awaiting_confirmation' AND (old_empty OR new_empty) THEN
  RAISE EXCEPTION 'Deletion witness missing' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._draft_discard_private_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_draft_discard_private_guard BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review
FOR EACH ROW EXECUTE FUNCTION app._draft_discard_private_guard();
--> statement-breakpoint
-- Existing privacy owner captures original actor-PERSON associations even after relink, including
-- completed/bodyless receipts. Preserve canonical body-cleared count and deferred actual audit.
CREATE FUNCTION app._draft_discard_erasure_hook() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' OR TG_RELID<>'app.assistant_review_erasure_intent'::regclass
  OR NEW.xact_id<>pg_catalog.pg_current_xact_id() OR NEW.tenant_id<>app.current_tenant_id()
  OR NEW.user_id<>app.current_user_id() THEN RAISE EXCEPTION 'Draft proof erasure unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_own_leave_review r SET draft_discard_source=NULL,draft_discard_source_xmin=NULL,
  draft_discard_source_ctid=NULL,draft_discard_delete_witness=NULL,draft_discard_delete_xid=NULL,draft_discard_capture_xid=NULL
 WHERE r.id=ANY(NEW.review_ids) AND r.tenant_id=NEW.tenant_id AND r.person_id=NEW.person_id
  AND r.action_kind='employees.draft.discard';
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._draft_discard_erasure_hook() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_draft_discard_erasure AFTER INSERT ON app.assistant_review_erasure_intent
FOR EACH ROW EXECUTE FUNCTION app._draft_discard_erasure_hook();
--> statement-breakpoint
CREATE INDEX assistant_review_pending_draft_cleanup ON app.assistant_own_leave_review(tenant_id,receipt_subject_id,id)
WHERE receipt_subject_kind='employee_draft' AND action_kind IN('employees.draft.activate','employees.draft.discard') AND state='awaiting_confirmation';
--> statement-breakpoint
CREATE FUNCTION app._assistant_employee_draft_delete_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record; changed integer; owned boolean;
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID<>'public.employee_draft'::regclass THEN
  RAISE EXCEPTION 'Draft review cleanup unavailable' USING ERRCODE='42501';END IF;
 IF app.access_workforce_storage_owner() THEN
  SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('access-configuration:'||OLD.tenant_id::text,0)) INTO owned;
  IF NOT owned THEN RAISE EXCEPTION 'Draft review cleanup busy' USING ERRCODE='55P03';END IF;
 ELSE
  IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Draft review cleanup unavailable' USING ERRCODE='42501';END IF;
  PERFORM app.access_workforce_write_lock();
 END IF;
 -- Incremental ordered cursor, no aggregate ID array, cap, or skipped locked row.
 FOR candidate IN SELECT r.id FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.receipt_subject_kind='employee_draft' AND r.receipt_subject_id=OLD.id
   AND r.action_kind IN('employees.draft.activate','employees.draft.discard') AND r.state='awaiting_confirmation'
  ORDER BY r.id FOR UPDATE OF r NOWAIT LOOP
  PERFORM 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=candidate.id FOR UPDATE OF c NOWAIT;
  UPDATE app.assistant_own_leave_review r SET state=CASE WHEN pg_catalog.clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,
   intent_digest=NULL,reviewed_digest=NULL WHERE r.id=candidate.id AND r.tenant_id=OLD.tenant_id AND r.state='awaiting_confirmation';
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'Draft review cleanup changed' USING ERRCODE='40001';END IF;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=candidate.id;
  IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=candidate.id) THEN
   RAISE EXCEPTION 'Draft body retirement incomplete' USING ERRCODE='42501';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.tenant_id=OLD.tenant_id
  AND r.receipt_subject_kind='employee_draft' AND r.receipt_subject_id=OLD.id
  AND r.action_kind IN('employees.draft.activate','employees.draft.discard') AND r.state='awaiting_confirmation') THEN
  RAISE EXCEPTION 'Draft review cleanup incomplete' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._assistant_employee_draft_delete_cleanup() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_employee_draft_delete_cleanup AFTER DELETE ON public.employee_draft
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app._assistant_employee_draft_delete_cleanup();
--> statement-breakpoint
CREATE FUNCTION app._draft_discard_outcome(p_source jsonb,p_event jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT pg_catalog.jsonb_build_object('kind',CASE WHEN coalesce(p_source->>'code','')='' THEN 'no_reservation'
  WHEN p_source->>'number' IS NULL THEN 'unreserved_code'
  WHEN p_event->'released'='true'::jsonb THEN 'released_tip' ELSE 'retained_gap' END,
  'reservedEmployeeCode',nullif(p_source->>'code',''))
$$;
REVOKE ALL ON FUNCTION app._draft_discard_outcome(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._draft_discard_stored(p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT pg_catalog.jsonb_build_object('metadata',pg_catalog.jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
  'binding',pg_catalog.jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',NULL,
  'companyId',r.company_id,'draftId',r.receipt_subject_id),'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,
  'state',r.state,'createdAt',pg_catalog.to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',pg_catalog.to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN
   pg_catalog.jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
  'eventId',r.receipt_event_id,'nativeOutcome',CASE WHEN r.state='completed' AND r.draft_discard_source IS NOT NULL
   THEN app._draft_discard_outcome(r.draft_discard_source,d.payload) ELSE NULL END)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 LEFT JOIN public.domain_event d ON d.id=r.receipt_event_id AND d.tenant_id=r.tenant_id
 WHERE r.id=p_id AND r.action_kind='employees.draft.discard'
$$;
REVOKE ALL ON FUNCTION app._draft_discard_stored(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Schema-owner proof verifier. Top-XID requirements apply only at completion; recovery deliberately
-- does not freeze a historical counter that later legitimate numbering may advance.
CREATE FUNCTION app._draft_discard_verify(p_id uuid,p_event uuid,p_current boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE; event public.domain_event%ROWTYPE; row_xmin xid;
 current_counter jsonb; counter_xmin xid; expected jsonb; released boolean; kind text; before jsonb;
BEGIN
 SELECT a.* INTO r FROM app.assistant_own_leave_review a WHERE a.id=p_id;
 SELECT a.xmin INTO row_xmin FROM app.assistant_own_leave_review a WHERE a.id=p_id;
 IF NOT FOUND OR r.action_kind<>'employees.draft.discard' OR r.draft_discard_source IS NULL
  OR r.draft_discard_delete_witness IS NULL OR r.draft_discard_delete_xid IS NULL
  OR r.draft_discard_capture_xid IS DISTINCT FROM r.draft_discard_delete_xid
  OR r.draft_discard_delete_witness->>'rowDigest' IS DISTINCT FROM r.draft_discard_source->>'rowDigest'
  OR (p_current AND (row_xmin<>pg_catalog.pg_current_xact_id()::xid OR r.draft_discard_delete_xid<>pg_catalog.pg_current_xact_id()))
  OR EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.id=r.receipt_subject_id AND d.tenant_id=r.tenant_id) THEN RETURN false;END IF;
 SELECT d.* INTO event FROM public.domain_event d WHERE d.id=p_event AND d.tenant_id=r.tenant_id
  AND d.aggregate_type='employee-draft' AND d.aggregate_id=r.receipt_subject_id AND d.event_type='employee-draft.discarded'
  AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id IS NULL
  AND (NOT p_current OR d.xmin=pg_catalog.pg_current_xact_id()::xid);
 IF NOT FOUND THEN RETURN false;END IF;
 kind:=r.draft_discard_source->>'counterKind';before:=r.draft_discard_source->'counterBefore';
 released:=coalesce(r.draft_discard_source->>'code','')<>'' AND r.draft_discard_source->>'number' IS NOT NULL
  AND before<>'null'::jsonb AND CASE WHEN kind='configured' THEN (before->>'current_running_number')::bigint=(r.draft_discard_source->>'number')::bigint
   WHEN kind='legacy' THEN (before->>'value')::bigint=(r.draft_discard_source->>'number')::bigint ELSE false END;
 released:=coalesce(released,false);
 expected:=CASE WHEN coalesce(r.draft_discard_source->>'code','')='' THEN '{}'::jsonb ELSE
  pg_catalog.jsonb_build_object('reservedEmployeeCode',r.draft_discard_source->>'code','released',released) END;
 IF event.payload IS DISTINCT FROM expected THEN RETURN false;END IF;
 IF NOT p_current THEN RETURN true;END IF;
 IF kind='configured' THEN
  SELECT (pg_catalog.to_jsonb(c)-'created_at'-'updated_at')||pg_catalog.jsonb_build_object(
   'created_at',pg_catalog.to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'updated_at',pg_catalog.to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),c.xmin
  INTO current_counter,counter_xmin FROM public.employee_id_config c WHERE c.id=(r.draft_discard_source->>'configId')::uuid AND c.tenant_id=r.tenant_id;
 ELSIF kind='legacy' THEN
  SELECT pg_catalog.to_jsonb(c),c.xmin INTO current_counter,counter_xmin FROM public.tenant_counter c WHERE c.tenant_id=r.tenant_id AND c.kind='employee_code';
 ELSE RETURN true;END IF;
 IF before='null'::jsonb THEN RETURN current_counter IS NULL;END IF;
 expected:=before;
 IF released AND kind='configured' THEN
  expected:=before||pg_catalog.jsonb_build_object('current_running_number',(before->>'current_running_number')::bigint-(before->>'increment')::bigint,
   'updated_at',pg_catalog.to_char(pg_catalog.transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 ELSIF released THEN expected:=before||pg_catalog.jsonb_build_object('value',(before->>'value')::bigint-1);END IF;
 RETURN current_counter IS NOT DISTINCT FROM expected AND CASE WHEN released THEN counter_xmin=pg_catalog.pg_current_xact_id()::xid
  ELSE counter_xmin::text=r.draft_discard_source->>'counterXmin' END;
END $$;
REVOKE ALL ON FUNCTION app._draft_discard_verify(uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_employee_draft_discard_command(
 p_operation text,p_id uuid DEFAULT NULL,p_person uuid DEFAULT NULL,p_company uuid DEFAULT NULL,p_draft uuid DEFAULT NULL,
 p_intent text DEFAULT NULL,p_reviewed text DEFAULT NULL,p_kid text DEFAULT NULL,p_wrapped text DEFAULT NULL,
 p_ciphertext text DEFAULT NULL,p_source text DEFAULT NULL,p_event uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE; t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
 at_time timestamptz:=pg_catalog.clock_timestamp(); snapshot jsonb; ids jsonb; nominated_author uuid; pending record;
BEGIN
 PERFORM app._assistant_multi_cycle_run_review_identity(NULL,false);
 IF app.is_admin() IS NOT TRUE OR p_operation IS NULL OR p_operation NOT IN('source','prepare','subject','read','index','discard','complete') THEN
  RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
 IF p_operation IN('source','prepare') THEN
  PERFORM app._assistant_multi_cycle_run_review_identity(p_person);
  IF p_company IS NULL OR p_draft IS NULL THEN RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
  IF app.onboarding_draft_discard_absence_context(p_draft,p_company,p_person) IS NOT TRUE THEN
   RAISE EXCEPTION 'Draft discard unavailable' USING ERRCODE='42501';END IF;
  snapshot:=app._draft_discard_source_snapshot(p_draft,p_company);
  IF p_operation='source' THEN
   FOR pending IN SELECT a.id FROM app.assistant_own_leave_review a
    WHERE a.action_kind='employees.draft.discard' AND a.receipt_subject_kind='employee_draft'
     AND a.tenant_id=t AND a.user_id=u AND a.person_id IS NOT DISTINCT FROM p_person
     AND a.company_id=p_company AND a.receipt_subject_id=p_draft AND a.state='awaiting_confirmation'
     AND a.expires_at>at_time AND a.draft_discard_source=snapshot->'private'
     AND a.draft_discard_source_xmin=snapshot->>'xmin' AND a.draft_discard_source_ctid=(snapshot->>'ctid')::tid
     AND a.draft_discard_delete_witness IS NULL
    ORDER BY a.id FOR UPDATE OF a NOWAIT LOOP
    UPDATE app.assistant_own_leave_review SET draft_discard_capture_xid=pg_catalog.pg_current_xact_id()
     WHERE id=pending.id AND draft_discard_capture_xid IS DISTINCT FROM pg_catalog.pg_current_xact_id();
   END LOOP;
   RETURN snapshot-'private';
  END IF;
  IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_catalog.pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person)
   OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_catalog.pg_current_xact_id() AND i.tenant_id=t AND i.person_id=p_person) THEN
   RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
  IF p_id IS NULL OR p_intent IS NULL OR p_intent!~'^[a-f0-9]{64}$' OR p_reviewed IS NULL OR p_reviewed!~'^[a-f0-9]{64}$'
   OR p_source IS DISTINCT FROM snapshot->>'sourceDigest' OR p_kid IS NULL OR p_kid!~'^[a-f0-9]{16}$'
   OR p_wrapped IS NULL OR pg_catalog.length(p_wrapped) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR pg_catalog.octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
   RAISE EXCEPTION 'Draft discard review input unavailable' USING ERRCODE='22023';END IF;
  IF (SELECT pg_catalog.count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5
   OR (SELECT pg_catalog.count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN
   RAISE EXCEPTION 'Draft discard review capacity unavailable' USING ERRCODE='54000';END IF;
  INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,
   receipt_subject_kind,receipt_subject_id,intent_digest,reviewed_digest,state,created_at,expires_at,
   draft_discard_source,draft_discard_source_xmin,draft_discard_source_ctid,draft_discard_capture_xid)
  VALUES('employees.draft.discard',p_id,t,u,p_person,NULL,p_company,'employee_draft',p_draft,p_intent,p_reviewed,
   'awaiting_confirmation',at_time,at_time+interval '10 minutes',snapshot->'private',snapshot->>'xmin',(snapshot->>'ctid')::tid,pg_catalog.pg_current_xact_id());
  INSERT INTO app.assistant_own_leave_review_content(action_id,kid,wrapped_dek,ciphertext) VALUES(p_id,p_kid,p_wrapped,p_ciphertext);
  RETURN app._draft_discard_stored(p_id);
 END IF;
 IF p_operation='index' THEN
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('action',a.action_kind,'contractVersion',1,'actionId',a.id,'state',a.state,
   'createdAt',pg_catalog.to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'expiresAt',pg_catalog.to_char(a.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY a.created_at DESC,a.id DESC),'[]'::jsonb)
  INTO ids FROM (SELECT x.* FROM app.assistant_own_leave_review x WHERE x.action_kind='employees.draft.discard'
   AND x.tenant_id=t AND x.user_id=u AND x.person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=u AND tenant_id=t)
   AND (x.draft_discard_source IS NULL AND x.state IN('discarded','expired','refused')
    OR x.draft_discard_source IS NOT NULL AND app.access_workforce_draft(x.company_id,
     CASE WHEN x.draft_discard_source->'authorIsActor'='true'::jsonb THEN x.person_id ELSE NULL END,'edit'))
   ORDER BY x.created_at DESC,x.id DESC LIMIT 25) a;
  RETURN ids;
 END IF;
 IF p_operation='subject' THEN
  SELECT a.* INTO r FROM app.assistant_own_leave_review a WHERE a.id=p_id AND a.tenant_id=t AND a.user_id=u
   AND a.action_kind='employees.draft.discard';
 ELSE
  SELECT a.* INTO r FROM app.assistant_own_leave_review a WHERE a.id=p_id AND a.tenant_id=t AND a.user_id=u
   AND a.action_kind='employees.draft.discard' FOR UPDATE OF a NOWAIT;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_multi_cycle_run_review_identity(r.person_id);
 IF r.draft_discard_source IS NOT NULL THEN
  nominated_author:=CASE WHEN r.draft_discard_source->'authorIsActor'='true'::jsonb THEN r.person_id ELSE NULL END;
  IF app.access_workforce_draft(r.company_id,nominated_author,'edit') IS NOT TRUE
   OR app.access_workforce_draft(r.company_id,nominated_author,'read') IS NOT TRUE THEN
   RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state NOT IN('discarded','expired','refused') THEN
  RAISE EXCEPTION 'Draft discard proof unavailable' USING ERRCODE='42501';
 END IF;
 IF p_operation='subject' THEN RETURN pg_catalog.jsonb_build_object('draftId',r.receipt_subject_id,'companyId',r.company_id,'state',r.state);END IF;
 IF p_operation='complete' THEN
  IF r.state='completed' THEN
   IF r.receipt_event_id IS DISTINCT FROM p_event OR NOT app._draft_discard_verify(r.id,r.receipt_event_id,false) THEN
    RAISE EXCEPTION 'Draft discard proof unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND at_time<r.expires_at THEN
   -- Crucially no UPDATE before current tuple xmin verification. Private stamp's child xmin is evidence.
   IF r.reviewed_digest IS DISTINCT FROM p_reviewed OR p_event IS NULL
    OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id)
    OR NOT app._draft_discard_verify(r.id,p_event,true) THEN
    RAISE EXCEPTION 'Draft discard proof unavailable' USING ERRCODE='42501';END IF;
   UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,receipt_event_id=p_event WHERE id=r.id;
   DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  ELSE RAISE EXCEPTION 'Draft discard deadline unavailable' USING ERRCODE='42501';END IF;
 ELSIF p_operation='discard' THEN
  IF r.state='completed' THEN RAISE EXCEPTION 'Draft discard review unavailable' USING ERRCODE='42501';END IF;
  IF r.state='awaiting_confirmation' THEN
   UPDATE app.assistant_own_leave_review SET state=CASE WHEN at_time>=expires_at THEN 'expired' ELSE 'discarded' END,
    intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
   DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  END IF;
 ELSIF p_operation='read' THEN
  IF r.state='completed' THEN
   IF NOT app._draft_discard_verify(r.id,r.receipt_event_id,false) THEN RAISE EXCEPTION 'Draft discard proof unavailable' USING ERRCODE='42501';END IF;
  ELSIF r.state='awaiting_confirmation' AND at_time>=r.expires_at THEN
   UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
   DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  END IF;
 END IF;
 RETURN app._draft_discard_stored(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_employee_draft_discard_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_employee_draft_discard_command(text,uuid,uuid,uuid,uuid,text,text,text,text,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Transfer only after the operator-provisioned INHERIT FALSE/SET TRUE owner membership exists.
-- No role creation. Restoration captures the actual prior effective role, including 'none'.
DO $transfer$
DECLARE prior text:=pg_catalog.current_setting('role'); schema_owner name; target text:='ai_hr_draft_discard_port';
BEGIN
 SELECT pg_catalog.pg_get_userbyid(relowner) INTO schema_owner FROM pg_catalog.pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA app TO %I',target);
 ALTER FUNCTION app._draft_discard_source_snapshot(uuid,uuid) OWNER TO ai_hr_draft_discard_port;
 ALTER FUNCTION app.native_employee_draft_discard_delete(uuid) OWNER TO ai_hr_draft_discard_port;
 EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA app FROM %I',target);
 PERFORM pg_catalog.set_config('role',target,true);
 EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION app._draft_discard_source_snapshot(uuid,uuid) TO %I',schema_owner);
 GRANT EXECUTE ON FUNCTION app.native_employee_draft_discard_delete(uuid) TO ai_hr_app;
 PERFORM pg_catalog.set_config('role',prior,true);
END $transfer$;
--> statement-breakpoint
-- Add only this native outcome kind to each existing closed owner; dynamic selected-kind bounds
-- remain intact. General source target capture already accepts a real pending review, adds actor
-- PERSON when present, and does not invent an employee for a company-only draft action.
DO $outcome_readers$
DECLARE target regprocedure; definition text; marker text; replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM pg_catalog.unnest(ARRAY[
  'app.native_outcome_review_completed(text,uuid)',
  'app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)',
  'app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_catalog.pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';
   replacement:=marker||' WHEN ''employees.draft.discard'' THEN r.receipt_event_id';
  ELSE marker:='''employees.qualification.maintain''';replacement:=marker||',''employees.draft.discard''';END IF;
  IF (pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,marker,'')))/pg_catalog.length(marker)<>1 THEN
   RAISE EXCEPTION 'draft-discard: unexpected native outcome owner %',target;END IF;
  definition:=pg_catalog.replace(definition,marker,replacement);
  IF target='app.native_outcome_completed_review_choices(jsonb)'::regprocedure THEN
   definition:=pg_catalog.regexp_replace(definition,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT pg_catalog.count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   definition:=pg_catalog.regexp_replace(definition,'LIMIT [0-9]+','LIMIT (SELECT pg_catalog.count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE definition;
 END LOOP;
END $outcome_readers$;
--> statement-breakpoint
-- Normal deferred COMMIT rechecks proof after the immediate handler returns. Forced IMMEDIATE
-- checks only their evaluation point; no global counter/event trigger or future-write guarantee.
-- Later transactions use historical verification and may legitimately advance numbering again.
CREATE FUNCTION app._draft_discard_completion_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass THEN
  RAISE EXCEPTION 'Draft completion guard unavailable' USING ERRCODE='42501';END IF;
 IF NEW.action_kind<>'employees.draft.discard' THEN RETURN NULL;END IF;
 SELECT a.* INTO r FROM app.assistant_own_leave_review a WHERE a.id=NEW.id AND a.tenant_id=NEW.tenant_id;
 IF NOT FOUND OR r.state<>'completed' OR r.draft_discard_source IS NULL THEN RETURN NULL;END IF;
 IF NOT app._draft_discard_verify(r.id,r.receipt_event_id,r.draft_discard_delete_xid=pg_catalog.pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Draft completion proof changed' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._draft_discard_completion_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_draft_discard_completed AFTER INSERT OR UPDATE ON app.assistant_own_leave_review
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW.action_kind='employees.draft.discard' AND NEW.state='completed')
EXECUTE FUNCTION app._draft_discard_completion_guard();
