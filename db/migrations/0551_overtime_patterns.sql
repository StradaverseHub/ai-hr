-- fcc2ea42, centrally reserved idx551/when1791900000031. Journal belongs to integration.
-- New OT-only owner. No Attendance, Schedule Group, Payroll amount or TOIL balance is rewritten.
CREATE TABLE overtime_pattern_epoch(tenant_id uuid PRIMARY KEY REFERENCES tenant(id),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
--> statement-breakpoint
CREATE TABLE overtime_pattern(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(kind IN('formula','legacy')),code text,creation_company_id uuid REFERENCES company(id),legacy_rule_ref uuid,legacy_rule_id uuid REFERENCES attendance_rule(id) ON DELETE SET NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),archived_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),CHECK((kind='formula' AND creation_company_id IS NOT NULL AND legacy_rule_ref IS NULL AND legacy_rule_id IS NULL AND length(trim(code)) BETWEEN 1 AND 64) OR(kind='legacy' AND creation_company_id IS NULL AND code IS NULL AND legacy_rule_ref IS NOT NULL AND(legacy_rule_id IS NULL OR legacy_rule_id=legacy_rule_ref))));
CREATE UNIQUE INDEX overtime_pattern_code_uq ON overtime_pattern(tenant_id,lower(code)) WHERE kind='formula' AND archived_at IS NULL;
CREATE UNIQUE INDEX overtime_pattern_legacy_uq ON overtime_pattern(tenant_id,legacy_rule_ref);
--> statement-breakpoint
CREATE TABLE overtime_pattern_version(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),pattern_id uuid NOT NULL REFERENCES overtime_pattern(id) ON DELETE RESTRICT,kind text NOT NULL CHECK(kind IN('formula','legacy')),creation_company_id uuid REFERENCES company(id),ordinal integer NOT NULL CHECK(ordinal>0),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 160),description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=262144),digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),activated_at timestamptz,activated_by uuid REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(pattern_id,ordinal));
--> statement-breakpoint
CREATE TABLE overtime_pattern_version_company(tenant_id uuid NOT NULL REFERENCES tenant(id),version_id uuid NOT NULL REFERENCES overtime_pattern_version(id) ON DELETE RESTRICT,company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,PRIMARY KEY(version_id,company_id));
CREATE TABLE overtime_pattern_version_state(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),version_id uuid NOT NULL REFERENCES overtime_pattern_version(id) ON DELETE RESTRICT,sequence integer NOT NULL CHECK(sequence>0),state text NOT NULL CHECK(state IN('active','inactive','archived')),effective_from date NOT NULL,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),created_by uuid REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(version_id,sequence));
CREATE TABLE overtime_pattern_legacy_binding(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),legacy_rule_ref uuid NOT NULL,rule_id uuid REFERENCES attendance_rule(id) ON DELETE SET NULL,version_id uuid NOT NULL REFERENCES overtime_pattern_version(id) ON DELETE RESTRICT,effective_from date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(legacy_rule_ref,version_id),CHECK(rule_id IS NULL OR rule_id=legacy_rule_ref));
--> statement-breakpoint
CREATE TABLE overtime_pattern_assignment(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),version_id uuid NOT NULL REFERENCES overtime_pattern_version(id) ON DELETE RESTRICT,target jsonb NOT NULL CHECK(jsonb_typeof(target)='object' AND octet_length(target::text)<=262144 AND target ? 'type' AND target->>'type' IN('individual','group')),priority integer NOT NULL CHECK(priority BETWEEN 0 AND 9999),valid_from date NOT NULL,valid_to date,superseded_at timestamptz,close_reason text,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),created_by uuid REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),CHECK(valid_to IS NULL OR valid_to>valid_from),CHECK(close_reason IS NULL OR length(trim(close_reason)) BETWEEN 1 AND 500));
CREATE INDEX overtime_pattern_assignment_dates_idx ON overtime_pattern_assignment(tenant_id,valid_from,valid_to);
CREATE TABLE overtime_pattern_assignment_employment(tenant_id uuid NOT NULL REFERENCES tenant(id),assignment_id uuid NOT NULL REFERENCES overtime_pattern_assignment(id) ON DELETE RESTRICT,employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE RESTRICT,PRIMARY KEY(assignment_id,employment_id));
--> statement-breakpoint
CREATE TABLE attendance_overtime_source(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE RESTRICT,attendance_id uuid NOT NULL REFERENCES attendance(id) ON DELETE RESTRICT,attendance_date date NOT NULL,current_calculation_id uuid,revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,employment_id,attendance_date));
CREATE TABLE attendance_overtime_personnel_context(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,source_id uuid NOT NULL UNIQUE REFERENCES attendance_overtime_source(id) ON DELETE RESTRICT,facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object' AND octet_length(facts::text)<=32768),owner_reference text NOT NULL CHECK(length(owner_reference) BETWEEN 1 AND 200),recorded_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE attendance_overtime_calculation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,source_id uuid NOT NULL REFERENCES attendance_overtime_source(id) ON DELETE RESTRICT,version_id uuid REFERENCES overtime_pattern_version(id) ON DELETE RESTRICT,assignment_id uuid REFERENCES overtime_pattern_assignment(id) ON DELETE RESTRICT,ordinal integer NOT NULL CHECK(ordinal>0),input_digest text NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),approval_digest text NOT NULL CHECK(approval_digest ~ '^[0-9a-f]{64}$'),reference_digest text NOT NULL CHECK(reference_digest ~ '^[0-9a-f]{64}$'),outcome text NOT NULL CHECK(outcome IN('ready','ineligible','refused')),currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),minor_scale integer NOT NULL CHECK(minor_scale BETWEEN 0 AND 6),duration_input_digest text CHECK(duration_input_digest IS NULL OR duration_input_digest ~ '^[0-9a-f]{64}$'),duration_outcome text NOT NULL CHECK(duration_outcome IN('ready','ineligible','refused')),approval_status text NOT NULL CHECK(approval_status IN('approved','notRequired','pending','rejected','unknown')),transferable boolean NOT NULL CHECK(NOT transferable OR outcome='ready' AND duration_outcome='ready' AND approval_status IN('approved','notRequired')),payable_numerator text,payable_denominator text,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_id,ordinal),CHECK((duration_outcome='refused' AND payable_numerator IS NULL AND payable_denominator IS NULL) OR(duration_outcome IN('ready','ineligible') AND duration_input_digest IS NOT NULL AND payable_numerator IS NOT NULL AND payable_denominator IS NOT NULL AND payable_numerator ~ '^[0-9]{1,78}$' AND payable_denominator ~ '^[1-9][0-9]{0,77}$')),CHECK((version_id IS NOT NULL AND assignment_id IS NOT NULL) OR(outcome='refused' AND version_id IS NULL AND assignment_id IS NULL)));
CREATE TABLE attendance_overtime_calculation_evidence(calculation_id uuid PRIMARY KEY REFERENCES attendance_overtime_calculation(id) ON DELETE RESTRICT,tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object' AND octet_length(inputs::text)<=1048576),evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=2097152));
ALTER TABLE attendance_overtime_source ADD CONSTRAINT attendance_overtime_current_fk FOREIGN KEY(current_calculation_id) REFERENCES attendance_overtime_calculation(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX attendance_overtime_calculation_source_idx ON attendance_overtime_calculation(tenant_id,source_id);
CREATE TABLE attendance_overtime_line(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,calculation_id uuid NOT NULL REFERENCES attendance_overtime_calculation(id) ON DELETE RESTRICT,line_key text NOT NULL CHECK(length(line_key) BETWEEN 1 AND 2048),sequence integer NOT NULL CHECK(sequence BETWEEN 0 AND 16383),component_id uuid NOT NULL REFERENCES pay_component(id) ON DELETE RESTRICT,amount_minor_units text NOT NULL CHECK(amount_minor_units ~ '^[0-9]{1,78}$'),evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=65536),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(calculation_id,line_key));
CREATE TABLE overtime_source_settlement(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id) ON DELETE RESTRICT,source_id uuid NOT NULL REFERENCES attendance_overtime_source(id) ON DELETE RESTRICT,owner_reference jsonb NOT NULL CHECK(jsonb_typeof(owner_reference)='object'),mode text NOT NULL CHECK(mode IN('cash','toil')),calculation_id uuid REFERENCES attendance_overtime_calculation(id) ON DELETE RESTRICT,payroll_batch_id uuid REFERENCES payroll_batch(id) ON DELETE SET NULL,toil_accrual_id uuid REFERENCES toil_accrual(id) ON DELETE SET NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),released_at timestamptz,release_reason text,created_at timestamptz NOT NULL DEFAULT now(),CHECK((mode='cash' AND (payroll_batch_id IS NOT NULL OR released_at IS NOT NULL) AND toil_accrual_id IS NULL AND owner_reference->>'type'='payroll_batch') OR(mode='toil' AND (toil_accrual_id IS NOT NULL OR released_at IS NOT NULL) AND payroll_batch_id IS NULL AND owner_reference->>'type'='toil_accrual')),CHECK((released_at IS NULL AND release_reason IS NULL) OR(released_at IS NOT NULL AND length(trim(release_reason)) BETWEEN 1 AND 500)));
CREATE UNIQUE INDEX overtime_source_active_settlement_uq ON overtime_source_settlement(source_id) WHERE released_at IS NULL;
--> statement-breakpoint
-- A snapshot begins NOW, not at a fabricated historical start. Future legacy OT edits must append a
-- binding through their canonical owner. Existing attendance traces and financial rows stay untouched.
INSERT INTO overtime_pattern(tenant_id,kind,legacy_rule_ref,legacy_rule_id) SELECT tenant_id,'legacy',id,id FROM attendance_rule;
INSERT INTO overtime_pattern_version(tenant_id,pattern_id,kind,ordinal,name,description,definition,digest,activated_at)
SELECT r.tenant_id,p.id,'legacy',1,r.name,coalesce(r.description,''),
 jsonb_build_object('kind','legacy','ruleId',r.id,'applyToEarlyOt',r.apply_to_early_ot,'rows',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.from_minutes,b.id) FROM attendance_rule_ot_row b WHERE b.rule_id=r.id),'[]'::jsonb)),
 encode(sha256(convert_to(jsonb_build_object('kind','legacy','ruleId',r.id,'applyToEarlyOt',r.apply_to_early_ot,'rows',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.from_minutes,b.id) FROM attendance_rule_ot_row b WHERE b.rule_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex'),now()
FROM attendance_rule r JOIN overtime_pattern p ON p.legacy_rule_id=r.id;
INSERT INTO overtime_pattern_version_state(tenant_id,version_id,sequence,state,effective_from,reason)
SELECT v.tenant_id,v.id,1,CASE WHEN r.status='active' THEN 'active' ELSE 'inactive' END,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'Recorded legacy compatibility at migration cutover'
FROM overtime_pattern_version v JOIN overtime_pattern p ON p.id=v.pattern_id JOIN attendance_rule r ON r.id=p.legacy_rule_id;
INSERT INTO overtime_pattern_legacy_binding(tenant_id,legacy_rule_ref,rule_id,version_id,effective_from)
SELECT v.tenant_id,p.legacy_rule_ref,p.legacy_rule_id,v.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date FROM overtime_pattern_version v JOIN overtime_pattern p ON p.id=v.pattern_id WHERE p.kind='legacy';
--> statement-breakpoint
CREATE FUNCTION app.lock_overtime_configuration(p_tenant uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR NOT app.is_admin() THEN RAISE EXCEPTION 'Overtime configuration is outside administrator scope' USING ERRCODE='42501';END IF;
 INSERT INTO public.overtime_pattern_epoch(tenant_id) VALUES(p_tenant) ON CONFLICT DO NOTHING;
 UPDATE public.overtime_pattern_epoch SET revision=revision+1 WHERE tenant_id=p_tenant;
END $$;
REVOKE ALL ON FUNCTION app.lock_overtime_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_overtime_configuration(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.check_overtime_references(p_tenant uuid,p_document jsonb) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n jsonb;v text;tbl text;ok boolean;mapping jsonb;
BEGIN
 FOR n IN SELECT jsonb_path_query(p_document,'$.** ? (@.type == "selection")') LOOP
  tbl:=CASE n->>'field' WHEN 'companyId' THEN 'company' WHEN 'employmentId' THEN 'employment' WHEN 'departmentId' THEN 'department' WHEN 'businessUnitId' THEN 'business_unit' WHEN 'positionId' THEN 'position' WHEN 'gradeId' THEN 'job_grade' WHEN 'shiftId' THEN 'shift' WHEN 'scheduleGroupId' THEN 'attendance_rule' ELSE NULL END;
  IF tbl IS NOT NULL THEN FOR v IN SELECT jsonb_array_elements_text(coalesce(n->'values','[]'::jsonb)) LOOP
   IF v='' THEN CONTINUE;END IF;
   IF v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN RAISE EXCEPTION 'Invalid overtime reference' USING ERRCODE='23514';END IF;
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND tenant_id=$2)',tbl) INTO ok USING v::uuid,p_tenant;
   IF NOT ok THEN RAISE EXCEPTION 'Overtime reference must belong to the same tenant' USING ERRCODE='23514';END IF;
  END LOOP;END IF;
 END LOOP;
 FOR mapping IN SELECT jsonb_path_query(p_document,'$.rates[*].tiers[*].mapping') LOOP
  v:=mapping->>'earningItemId';IF v IS NULL OR v='' THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pay_component WHERE id=v::uuid AND tenant_id=p_tenant) THEN RAISE EXCEPTION 'Overtime earning item must belong to the same tenant' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR mapping IN SELECT jsonb_path_query(p_document,'$.deductions[*]') LOOP
  v:=mapping->>'targetEarningItemId';IF v IS NULL OR v='' THEN CONTINUE;END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pay_component WHERE id=v::uuid AND tenant_id=p_tenant) THEN RAISE EXCEPTION 'Overtime deduction item must belong to the same tenant' USING ERRCODE='23514';END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.check_overtime_references(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.check_overtime_references(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_overtime_configuration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.overtime_pattern;v public.overtime_pattern_version;a public.overtime_pattern_assignment;c uuid;e uuid;
BEGIN
 -- FK cleanup from canonical unused Schedule Group deletion retains immutable references/snapshots.
 IF TG_OP='UPDATE' AND pg_trigger_depth()>1 THEN
  IF TG_TABLE_NAME='overtime_pattern' THEN IF OLD.legacy_rule_id IS NOT NULL AND NEW.legacy_rule_id IS NULL AND(to_jsonb(NEW)-'legacy_rule_id')=(to_jsonb(OLD)-'legacy_rule_id') THEN RETURN NEW;END IF;END IF;
  IF TG_TABLE_NAME='overtime_pattern_legacy_binding' THEN IF OLD.rule_id IS NOT NULL AND NEW.rule_id IS NULL AND(to_jsonb(NEW)-'rule_id')=(to_jsonb(OLD)-'rule_id') THEN RETURN NEW;END IF;END IF;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Retain overtime configuration history; close or archive it' USING ERRCODE='23514';END IF;
 PERFORM app.lock_overtime_configuration(NEW.tenant_id);
 IF TG_TABLE_NAME='overtime_pattern' THEN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.kind,NEW.code,NEW.creation_company_id,NEW.legacy_rule_ref,NEW.legacy_rule_id,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.kind,OLD.code,OLD.creation_company_id,OLD.legacy_rule_ref,OLD.legacy_rule_id,OLD.created_at) THEN RAISE EXCEPTION 'Overtime pattern identity is immutable' USING ERRCODE='23514';END IF;
  IF NEW.kind='formula' AND NOT EXISTS(SELECT 1 FROM public.company WHERE id=NEW.creation_company_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL AND app.is_admin_for(id)) THEN RAISE EXCEPTION 'Overtime creation company is unavailable' USING ERRCODE='42501';END IF;
  IF NEW.kind='legacy' AND(NEW.legacy_rule_id IS DISTINCT FROM NEW.legacy_rule_ref OR NOT EXISTS(SELECT 1 FROM public.attendance_rule WHERE id=NEW.legacy_rule_id AND tenant_id=NEW.tenant_id)) THEN RAISE EXCEPTION 'Invalid legacy overtime identity' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.overtime_pattern_version_company co JOIN public.overtime_pattern_version ver ON ver.id=co.version_id WHERE ver.pattern_id=NEW.id AND NOT app.is_admin_for(co.company_id)) THEN RAISE EXCEPTION 'Overtime change affects an unadministered company' USING ERRCODE='42501';END IF;
 ELSIF TG_TABLE_NAME='overtime_pattern_version' THEN
  SELECT * INTO p FROM public.overtime_pattern WHERE id=NEW.pattern_id AND tenant_id=NEW.tenant_id;
  IF NOT FOUND OR (NEW.kind,NEW.creation_company_id) IS DISTINCT FROM(p.kind,p.creation_company_id) THEN RAISE EXCEPTION 'Invalid overtime version identity' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND OLD.activated_at IS NOT NULL THEN RAISE EXCEPTION 'Activated overtime versions are immutable' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.pattern_id,NEW.kind,NEW.creation_company_id,NEW.ordinal,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.pattern_id,OLD.kind,OLD.creation_company_id,OLD.ordinal,OLD.created_at) THEN RAISE EXCEPTION 'Overtime version identity is immutable' USING ERRCODE='23514';END IF;
  IF NEW.activated_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user WHERE id=NEW.activated_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid overtime activation actor' USING ERRCODE='23514';END IF;
  IF NEW.kind='legacy' AND NEW.definition IS DISTINCT FROM(SELECT jsonb_build_object('kind','legacy','ruleId',r.id,'applyToEarlyOt',r.apply_to_early_ot,'rows',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.from_minutes,b.id) FROM public.attendance_rule_ot_row b WHERE b.rule_id=r.id AND b.tenant_id=r.tenant_id),'[]'::jsonb)) FROM public.attendance_rule r WHERE r.id=p.legacy_rule_id AND r.tenant_id=p.tenant_id) THEN RAISE EXCEPTION 'Legacy snapshots must be read from their canonical OT owner' USING ERRCODE='23514';END IF;
  PERFORM app.check_overtime_references(NEW.tenant_id,NEW.definition);
  IF NEW.kind='formula' AND NEW.activated_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.overtime_pattern_version_company WHERE version_id=NEW.id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Activated overtime needs company scope' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM public.overtime_pattern_version_company WHERE version_id=NEW.id AND NOT app.is_admin_for(company_id)) THEN RAISE EXCEPTION 'Version change affects an unadministered company' USING ERRCODE='42501';END IF;
 ELSE
  SELECT * INTO v FROM public.overtime_pattern_version WHERE id=NEW.version_id AND tenant_id=NEW.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Overtime version must belong to the same tenant' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='overtime_pattern_version_company' THEN
   IF v.kind<>'formula' OR v.activated_at IS NOT NULL OR TG_OP='UPDATE' THEN RAISE EXCEPTION 'Activated company scope is immutable' USING ERRCODE='23514';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL AND app.is_admin_for(id)) THEN RAISE EXCEPTION 'Overtime company scope is unavailable' USING ERRCODE='42501';END IF;
  ELSIF TG_TABLE_NAME='overtime_pattern_version_state' THEN
   IF TG_OP<>'INSERT' OR v.activated_at IS NULL OR NEW.effective_from<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NEW.sequence<>(SELECT count(*)+1 FROM public.overtime_pattern_version_state WHERE version_id=NEW.version_id) OR EXISTS(SELECT 1 FROM public.overtime_pattern_version_state WHERE version_id=NEW.version_id AND effective_from>NEW.effective_from) THEN RAISE EXCEPTION 'Append a prospective version lifecycle transition' USING ERRCODE='23514';END IF;
   IF EXISTS(SELECT 1 FROM public.overtime_pattern_version_state WHERE version_id=NEW.version_id) AND NEW.state='active' THEN RAISE EXCEPTION 'Fork a new version to reactivate overtime' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='overtime_pattern_legacy_binding' THEN
   SELECT * INTO p FROM public.overtime_pattern WHERE id=v.pattern_id;
   IF TG_OP<>'INSERT' OR v.kind<>'legacy' OR p.legacy_rule_id IS NULL OR p.legacy_rule_id IS DISTINCT FROM NEW.rule_id OR p.legacy_rule_ref IS DISTINCT FROM NEW.legacy_rule_ref THEN RAISE EXCEPTION 'Invalid legacy compatibility binding' USING ERRCODE='23514';END IF;
  ELSIF TG_TABLE_NAME='overtime_pattern_assignment' THEN
   IF v.kind<>'formula' OR v.activated_at IS NULL THEN RAISE EXCEPTION 'Assignments require an activated formula version' USING ERRCODE='23514';END IF;
   IF TG_OP='UPDATE' AND ((NEW.id,NEW.tenant_id,NEW.version_id,NEW.target,NEW.priority,NEW.valid_from,NEW.created_by,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.version_id,OLD.target,OLD.priority,OLD.valid_from,OLD.created_by,OLD.created_at) OR OLD.superseded_at IS NOT NULL OR (NEW.superseded_at IS NULL AND (NEW.valid_to IS NULL OR OLD.valid_to IS NOT NULL AND NEW.valid_to>OLD.valid_to OR NEW.valid_to<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) OR (NEW.superseded_at IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) OR NEW.revision<>OLD.revision+1 OR NEW.close_reason IS NULL) THEN RAISE EXCEPTION 'Only an audited prospective close may change an assignment' USING ERRCODE='23514';END IF;
   PERFORM app.check_overtime_references(NEW.tenant_id,NEW.target);
  END IF;
  IF TG_TABLE_NAME IN('overtime_pattern_version_state','overtime_pattern_assignment') THEN IF NEW.created_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.app_user WHERE id=NEW.created_by AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Overtime actor must belong to the same tenant' USING ERRCODE='23514';END IF;END IF;
  IF v.kind='formula' AND (NOT app.is_admin_for(v.creation_company_id) OR EXISTS(SELECT 1 FROM public.overtime_pattern_version_company WHERE version_id=v.id AND NOT app.is_admin_for(company_id))) THEN RAISE EXCEPTION 'Overtime configuration affects an unadministered company' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_configuration() FROM PUBLIC;
--> statement-breakpoint
-- Draft company replacement is allowed; activated scope and all identity rows stay immutable.
CREATE FUNCTION app.guard_overtime_company_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.lock_overtime_configuration(OLD.tenant_id);
 IF NOT EXISTS(SELECT 1 FROM public.overtime_pattern_version WHERE id=OLD.version_id AND tenant_id=OLD.tenant_id AND activated_at IS NULL AND app.is_admin_for(creation_company_id)) THEN RAISE EXCEPTION 'Activated overtime scope is immutable' USING ERRCODE='23514';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_company_delete() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.guard_overtime_assignment_employment() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.overtime_pattern_assignment;e public.employment;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Assignment membership is immutable' USING ERRCODE='23514';END IF;
 PERFORM app.lock_overtime_configuration(NEW.tenant_id);
 SELECT * INTO a FROM public.overtime_pattern_assignment WHERE id=NEW.assignment_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO e FROM public.employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id;
 IF a.id IS NULL OR e.id IS NULL OR a.target->>'type'<>'individual' OR NOT(a.target->'employmentIds' ? NEW.employment_id::text) OR NOT app.can_admin_employment(e.id) OR NOT EXISTS(SELECT 1 FROM public.overtime_pattern_version_company WHERE version_id=a.version_id AND company_id=e.company_id) THEN RAISE EXCEPTION 'Invalid or inaccessible overtime employment assignment' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_assignment_employment() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.overtime_attendance_visible(p_tenant uuid,p_employment uuid,p_date date) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance a WHERE a.tenant_id=p_tenant AND a.employment_id=p_employment AND a.attendance_date=p_date)
$$;
REVOKE ALL ON FUNCTION app.overtime_attendance_visible(uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.overtime_attendance_visible(uuid,uuid,date) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_overtime_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.attendance_overtime_source;c public.attendance_overtime_calculation;a public.attendance;e public.employment;b public.payroll_batch;t public.toil_accrual;v public.overtime_pattern_version;matched integer;co uuid;fact jsonb;k text;actual text;
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND TG_TABLE_NAME NOT IN('attendance_overtime_source','overtime_source_settlement')) THEN RAISE EXCEPTION 'Overtime evidence is immutable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='overtime_source_settlement' AND TG_OP='UPDATE' THEN
  IF pg_trigger_depth()>1 AND OLD.released_at IS NOT NULL AND (NEW.id,NEW.tenant_id,NEW.company_id,NEW.source_id,NEW.mode,NEW.calculation_id,NEW.owner_reference,NEW.revision,NEW.released_at,NEW.release_reason,NEW.created_at) IS NOT DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.company_id,OLD.source_id,OLD.mode,OLD.calculation_id,OLD.owner_reference,OLD.revision,OLD.released_at,OLD.release_reason,OLD.created_at) AND ((NEW.payroll_batch_id IS NULL AND OLD.payroll_batch_id IS NOT NULL AND NEW.toil_accrual_id IS NOT DISTINCT FROM OLD.toil_accrual_id) OR(NEW.toil_accrual_id IS NULL AND OLD.toil_accrual_id IS NOT NULL AND NEW.payroll_batch_id IS NOT DISTINCT FROM OLD.payroll_batch_id)) THEN RETURN NEW;END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_overtime_source' THEN
  IF TG_OP='INSERT' AND(NEW.revision<>0 OR NEW.current_calculation_id IS NOT NULL) THEN RAISE EXCEPTION 'A new overtime source starts without a calculation' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.company_id,NEW.employment_id,NEW.attendance_id,NEW.attendance_date,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.company_id,OLD.employment_id,OLD.attendance_id,OLD.attendance_date,OLD.created_at) THEN RAISE EXCEPTION 'Overtime source identity is immutable' USING ERRCODE='23514';END IF;
  SELECT * INTO a FROM public.attendance WHERE id=NEW.attendance_id AND tenant_id=NEW.tenant_id AND employment_id=NEW.employment_id AND attendance_date=NEW.attendance_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'Overtime source requires canonical visible attendance' USING ERRCODE='42501';END IF;
  SELECT * INTO e FROM public.employment WHERE id=a.employment_id AND tenant_id=a.tenant_id;
  SELECT count(*),min(company_id::text)::uuid INTO matched,co FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=a.attendance_date AND(valid_to IS NULL OR valid_to>a.attendance_date);
  IF matched<>1 OR co IS NULL OR co<>NEW.company_id OR a.attendance_date<e.hired_on OR e.terminated_on IS NOT NULL AND a.attendance_date>e.terminated_on THEN RAISE EXCEPTION 'Overtime source company requires exact dated proof' USING ERRCODE='23514';END IF;
  IF TG_OP='UPDATE' THEN
   IF NEW.revision<>OLD.revision+1 OR EXISTS(SELECT 1 FROM public.overtime_source_settlement WHERE source_id=NEW.id AND released_at IS NULL) THEN RAISE EXCEPTION 'Release canonical settlement before replacing overtime evidence' USING ERRCODE='23514';END IF;
   IF NEW.current_calculation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_overtime_calculation WHERE id=NEW.current_calculation_id AND source_id=NEW.id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND ordinal=NEW.revision) THEN RAISE EXCEPTION 'Invalid current overtime calculation' USING ERRCODE='23514';END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME IN('attendance_overtime_line','attendance_overtime_calculation_evidence') THEN
  SELECT * INTO c FROM public.attendance_overtime_calculation WHERE id=NEW.calculation_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid overtime calculation evidence identity' USING ERRCODE='23514';END IF;
  IF TG_TABLE_NAME='attendance_overtime_line' THEN
  IF c.outcome<>'ready' OR NOT EXISTS(SELECT 1 FROM public.pay_component WHERE id=NEW.component_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL AND NOT is_non_payable AND kind='allowance') THEN RAISE EXCEPTION 'Invalid overtime calculation line or earning item' USING ERRCODE='23514';END IF;END IF;
  SELECT * INTO d FROM public.attendance_overtime_source WHERE id=c.source_id;
 ELSE
  SELECT * INTO d FROM public.attendance_overtime_source WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 END IF;
 IF d.id IS NULL OR(TG_TABLE_NAME<>'overtime_source_settlement' AND NOT app.overtime_attendance_visible(d.tenant_id,d.employment_id,d.attendance_date)) THEN RAISE EXCEPTION 'Overtime evidence is outside Attendance subject authority' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='attendance_overtime_personnel_context' THEN
  SELECT * INTO a FROM public.attendance WHERE id=d.attendance_id;
  IF d.attendance_date<>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR a.check_in_at IS NULL THEN RAISE EXCEPTION 'Personnel context can only be captured at current-day actual attendance' USING ERRCODE='23514';END IF;
  SELECT * INTO e FROM public.employment WHERE id=d.employment_id;
  FOR k,fact IN SELECT * FROM jsonb_each(NEW.facts) LOOP
   IF k NOT IN('gradeId','orgDivision','orgBranch','orgRegion','orgLine','orgSection','orgTeam','orgBase','employmentCategory') THEN RAISE EXCEPTION 'Only recorded mutable Personnel context belongs here' USING ERRCODE='23514';END IF;
   actual:=CASE k WHEN 'gradeId' THEN e.grade_id::text WHEN 'orgDivision' THEN e.org_division WHEN 'orgBranch' THEN e.org_branch WHEN 'orgRegion' THEN e.org_region WHEN 'orgLine' THEN e.org_line WHEN 'orgSection' THEN e.org_section WHEN 'orgTeam' THEN e.org_team WHEN 'orgBase' THEN e.org_base ELSE e.employment_category END;
   IF fact->>'state'='known' AND (fact->>'value') IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Personnel context must match its canonical capture owner' USING ERRCODE='23514';END IF;
  END LOOP;
 ELSIF TG_TABLE_NAME='attendance_overtime_calculation' THEN
  IF NEW.ordinal<>d.revision+1 THEN RAISE EXCEPTION 'Overtime calculation source revision is stale' USING ERRCODE='23514';END IF;
  IF NEW.version_id IS NOT NULL THEN
   SELECT * INTO v FROM public.overtime_pattern_version WHERE id=NEW.version_id AND tenant_id=NEW.tenant_id AND activated_at IS NOT NULL;
   IF NOT FOUND OR v.kind<>'formula' OR NOT EXISTS(SELECT 1 FROM public.overtime_pattern_assignment WHERE id=NEW.assignment_id AND tenant_id=NEW.tenant_id AND version_id=v.id) OR NOT EXISTS(SELECT 1 FROM public.overtime_pattern_version_company WHERE version_id=v.id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'Overtime calculation version/assignment scope mismatch' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='attendance_overtime_calculation_evidence' THEN
  IF NEW.inputs->'source'->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text OR NEW.inputs->'source'->>'employmentId' IS DISTINCT FROM d.employment_id::text OR NEW.inputs->'source'->>'attendanceId' IS DISTINCT FROM d.attendance_id::text OR NEW.inputs->'source'->>'date' IS DISTINCT FROM d.attendance_date::text OR NEW.inputs->'source'->>'inputDigest' IS DISTINCT FROM c.input_digest OR NEW.inputs->'source'->>'approvalDigest' IS DISTINCT FROM c.approval_digest THEN RAISE EXCEPTION 'Overtime input evidence identity/digest mismatch' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='overtime_source_settlement' THEN
  IF TG_OP='UPDATE' THEN
   IF (NEW.id,NEW.tenant_id,NEW.company_id,NEW.source_id,NEW.mode,NEW.calculation_id,NEW.owner_reference,NEW.payroll_batch_id,NEW.toil_accrual_id,NEW.created_at) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.company_id,OLD.source_id,OLD.mode,OLD.calculation_id,OLD.owner_reference,OLD.payroll_batch_id,OLD.toil_accrual_id,OLD.created_at) OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Only a controlled settlement release is allowed' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.owner_reference->>'id' IS DISTINCT FROM coalesce(NEW.payroll_batch_id,NEW.toil_accrual_id)::text THEN RAISE EXCEPTION 'Retain the exact canonical settlement owner reference' USING ERRCODE='23514';END IF;
  IF NEW.mode='cash' THEN
   SELECT * INTO b FROM public.payroll_batch WHERE id=NEW.payroll_batch_id AND tenant_id=NEW.tenant_id AND company_id=d.company_id;
   IF NOT FOUND OR NOT app.can_admin_payroll_for(b.company_id) OR b.status='closed' OR TG_OP='INSERT' AND b.status<>'draft' THEN RAISE EXCEPTION 'Payroll settlement is closed or outside financial authority' USING ERRCODE='42501';END IF;
   IF TG_OP='UPDATE' AND (b.status<>'draft' OR EXISTS(SELECT 1 FROM public.payslip WHERE batch_id=b.id)) THEN RAISE EXCEPTION 'Reverse or reopen canonical Payroll before releasing its overtime source' USING ERRCODE='23514';END IF;
   IF TG_OP='INSERT' AND NEW.calculation_id IS DISTINCT FROM d.current_calculation_id THEN RAISE EXCEPTION 'Payroll requires the current overtime calculation' USING ERRCODE='23514';END IF;
   IF NEW.calculation_id IS NOT NULL THEN SELECT * INTO c FROM public.attendance_overtime_calculation WHERE id=NEW.calculation_id AND source_id=d.id;
    IF c.id IS NULL OR c.outcome<>'ready' OR NOT c.transferable OR c.approval_status NOT IN('approved','notRequired') THEN RAISE EXCEPTION 'Only approved payable overtime can settle in Payroll' USING ERRCODE='23514';END IF;
   END IF;
   IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM public.toil_accrual WHERE tenant_id=d.tenant_id AND employment_id=d.employment_id AND worked_date=d.attendance_date AND status<>'reversed') THEN RAISE EXCEPTION 'Overtime already belongs to TOIL' USING ERRCODE='23514';END IF;
  ELSE
   SELECT * INTO t FROM public.toil_accrual WHERE id=NEW.toil_accrual_id AND tenant_id=NEW.tenant_id AND employment_id=d.employment_id AND worked_date=d.attendance_date;
   IF NOT FOUND OR TG_OP='INSERT' AND t.status='reversed' OR TG_OP='UPDATE' AND t.status<>'reversed' THEN RAISE EXCEPTION 'TOIL settlement requires the canonical matching accrual/reversal' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_evidence() FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['overtime_pattern','overtime_pattern_version','overtime_pattern_version_state','overtime_pattern_legacy_binding','overtime_pattern_assignment'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_configuration()',t||'_guard',t);
 END LOOP;
END $$;
CREATE TRIGGER overtime_pattern_version_company_guard BEFORE INSERT OR UPDATE ON overtime_pattern_version_company FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_configuration();
CREATE TRIGGER overtime_pattern_version_company_delete BEFORE DELETE ON overtime_pattern_version_company FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_company_delete();
CREATE TRIGGER overtime_pattern_assignment_employment_guard BEFORE INSERT OR UPDATE OR DELETE ON overtime_pattern_assignment_employment FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_assignment_employment();
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_overtime_source','attendance_overtime_personnel_context','attendance_overtime_calculation','attendance_overtime_calculation_evidence','attendance_overtime_line','overtime_source_settlement'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_evidence()',t||'_guard',t);
 END LOOP;
END $$;
--> statement-breakpoint
-- RLS is forced, privileges explicit. No new login/BYPASSRLS role or app DDL grant is introduced.
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['overtime_pattern_epoch','overtime_pattern','overtime_pattern_version','overtime_pattern_version_company','overtime_pattern_version_state','overtime_pattern_legacy_binding','overtime_pattern_assignment','overtime_pattern_assignment_employment','attendance_overtime_source','attendance_overtime_personnel_context','attendance_overtime_calculation','attendance_overtime_calculation_evidence','attendance_overtime_line','overtime_source_settlement'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,ai_hr_app',t);EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO ai_hr_app',t);
 END LOOP;
END $$;
CREATE POLICY overtime_epoch_admin ON overtime_pattern_epoch FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin());
CREATE POLICY overtime_company_read ON overtime_pattern_version_company FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.is_admin() OR app.can_admin_payroll_for(company_id) OR EXISTS(SELECT 1 FROM public.attendance a JOIN public.assignment ar ON ar.employment_id=a.employment_id AND ar.tenant_id=a.tenant_id WHERE a.tenant_id=overtime_pattern_version_company.tenant_id AND ar.company_id=overtime_pattern_version_company.company_id AND ar.superseded_at IS NULL AND ar.valid_from<=a.attendance_date AND(ar.valid_to IS NULL OR ar.valid_to>a.attendance_date))));
CREATE POLICY overtime_version_read ON overtime_pattern_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND((kind='legacy' AND(app.is_admin() OR EXISTS(SELECT 1 FROM public.attendance WHERE tenant_id=overtime_pattern_version.tenant_id))) OR app.is_admin_for(creation_company_id) OR EXISTS(SELECT 1 FROM public.overtime_pattern_version_company vc WHERE vc.version_id=overtime_pattern_version.id AND(app.is_admin_for(vc.company_id) OR app.can_admin_payroll_for(vc.company_id) OR EXISTS(SELECT 1 FROM public.attendance a JOIN public.assignment ar ON ar.employment_id=a.employment_id AND ar.tenant_id=a.tenant_id WHERE a.tenant_id=vc.tenant_id AND ar.company_id=vc.company_id AND ar.superseded_at IS NULL AND ar.valid_from<=a.attendance_date AND(ar.valid_to IS NULL OR ar.valid_to>a.attendance_date))))));
CREATE POLICY overtime_pattern_read ON overtime_pattern FOR SELECT USING(tenant_id=app.current_tenant_id() AND((kind='legacy' AND app.is_admin()) OR app.is_admin_for(creation_company_id) OR EXISTS(SELECT 1 FROM public.overtime_pattern_version WHERE pattern_id=overtime_pattern.id)));
CREATE POLICY overtime_pattern_write ON overtime_pattern FOR ALL USING(tenant_id=app.current_tenant_id() AND((kind='formula' AND app.is_admin_for(creation_company_id)) OR(kind='legacy' AND app.is_admin()))) WITH CHECK(tenant_id=app.current_tenant_id() AND((kind='formula' AND app.is_admin_for(creation_company_id)) OR(kind='legacy' AND app.is_admin())));
CREATE POLICY overtime_version_write ON overtime_pattern_version FOR ALL USING(tenant_id=app.current_tenant_id() AND((kind='formula' AND app.is_admin_for(creation_company_id)) OR(kind='legacy' AND app.is_admin()))) WITH CHECK(tenant_id=app.current_tenant_id() AND((kind='formula' AND app.is_admin_for(creation_company_id)) OR(kind='legacy' AND app.is_admin())));
CREATE POLICY overtime_company_write ON overtime_pattern_version_company FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['overtime_pattern_version_state','overtime_pattern_legacy_binding','overtime_pattern_assignment'] LOOP
  EXECUTE format('CREATE POLICY overtime_config_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.overtime_pattern_version WHERE id=version_id))',t);
  EXECUTE format('CREATE POLICY overtime_config_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.overtime_pattern_version v WHERE v.id=version_id))',t);
  EXECUTE format('CREATE POLICY overtime_config_update ON public.%I FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.overtime_pattern_version v WHERE v.id=version_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.overtime_pattern_version v WHERE v.id=version_id))',t);
  EXECUTE format('CREATE POLICY overtime_config_delete ON public.%I FOR DELETE USING(tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.overtime_pattern_version v WHERE v.id=version_id))',t);
 END LOOP;
END $$;
CREATE POLICY overtime_assignment_employment_read ON overtime_pattern_assignment_employment FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.is_admin() OR app.can_see_employment(employment_id) OR app.can_admin_payroll_employment(employment_id)));
CREATE POLICY overtime_assignment_employment_write ON overtime_pattern_assignment_employment FOR ALL USING(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id));
CREATE POLICY overtime_source_subject ON attendance_overtime_source FOR ALL USING(tenant_id=app.current_tenant_id() AND(app.overtime_attendance_visible(tenant_id,employment_id,attendance_date) OR app.can_admin_payroll_for(company_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND(app.overtime_attendance_visible(tenant_id,employment_id,attendance_date) OR app.can_admin_payroll_for(company_id)));
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_overtime_personnel_context','attendance_overtime_calculation'] LOOP
  EXECUTE format('CREATE POLICY overtime_subject_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_overtime_source WHERE id=source_id))',t);
  EXECUTE format('CREATE POLICY overtime_subject_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_overtime_source WHERE id=source_id))',t);
 END LOOP;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_overtime_calculation_evidence','attendance_overtime_line'] LOOP
  EXECUTE format('CREATE POLICY overtime_private_read ON public.%I FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.can_admin_payroll_for(company_id) OR EXISTS(SELECT 1 FROM public.attendance_overtime_calculation c JOIN public.attendance_overtime_source d ON d.id=c.source_id JOIN public.employment e ON e.id=d.employment_id WHERE c.id=calculation_id AND app.is_self_person(e.person_id))))',t);
  EXECUTE format('CREATE POLICY overtime_private_insert ON public.%I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_overtime_calculation WHERE id=calculation_id))',t);
 END LOOP;
END $$;
CREATE POLICY overtime_settlement_read ON overtime_source_settlement FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_overtime_source WHERE id=source_id));
CREATE POLICY overtime_settlement_write ON overtime_source_settlement FOR ALL USING(tenant_id=app.current_tenant_id() AND((mode='cash' AND app.can_admin_payroll_for(company_id)) OR(mode='toil' AND EXISTS(SELECT 1 FROM public.toil_accrual WHERE id=toil_accrual_id)))) WITH CHECK(tenant_id=app.current_tenant_id() AND((mode='cash' AND app.can_admin_payroll_for(company_id)) OR(mode='toil' AND EXISTS(SELECT 1 FROM public.toil_accrual WHERE id=toil_accrual_id))));
--> statement-breakpoint
-- Teardown may null a released canonical FK; the frozen owner_reference remains readable forever.
CREATE FUNCTION app.guard_overtime_settlement_owner_delete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='payroll_batch' THEN
  IF EXISTS(SELECT 1 FROM public.overtime_source_settlement WHERE payroll_batch_id=OLD.id AND tenant_id=OLD.tenant_id AND released_at IS NULL) THEN RAISE EXCEPTION 'Release overtime cash claims through canonical draft teardown first' USING ERRCODE='23514';END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.overtime_source_settlement WHERE toil_accrual_id=OLD.id AND tenant_id=OLD.tenant_id AND released_at IS NULL) THEN RAISE EXCEPTION 'Reverse and release the canonical TOIL claim first' USING ERRCODE='23514';END IF;
 END IF;RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_settlement_owner_delete() FROM PUBLIC;
CREATE TRIGGER payroll_batch_overtime_owner_delete BEFORE DELETE ON payroll_batch FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_settlement_owner_delete();
CREATE TRIGGER toil_accrual_overtime_owner_delete BEFORE DELETE ON toil_accrual FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_settlement_owner_delete();
--> statement-breakpoint
-- No app-callable bypass: exact raw business-input changes inherit the existing Attendance subject
-- policy and private Payroll coverage lock owner. This function returns no salary/Payroll payload.
CREATE FUNCTION app.guard_overtime_cash_source_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE olddoc jsonb;newdoc jsonb;doc jsonb;tenant_value uuid;emp uuid;on_date date;claim record;batch_status text;request_value uuid;seen text[]:='{}';source_key text;full_source_visibility boolean;requested_minutes integer;
BEGIN
 -- FORCE RLS makes an empty owner read inconclusive unless this EFFECTIVE reader truly bypasses RLS.
 -- This is absence proof only: a protected source still requires its normal context and guards.
 olddoc:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;newdoc:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='attendance' THEN
   -- A referenced canonical day is an immutable source identity, including context-only sources.
   -- Check BEFORE derived-field/no-op shortcuts and before FK/RLS rejection of the new identity.
   IF (NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date) IS DISTINCT FROM(OLD.id,OLD.tenant_id,OLD.employment_id,OLD.attendance_date) AND EXISTS(SELECT 1 FROM public.attendance_overtime_source d WHERE d.attendance_id=OLD.id AND d.tenant_id=OLD.tenant_id) THEN RAISE EXCEPTION 'Referenced overtime Attendance identity is immutable' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_TABLE_NAME='attendance' AND (olddoc->'check_in_at',olddoc->'check_out_at',olddoc->'status',olddoc->'absence_reason',olddoc->'day_type',olddoc->'worked_minutes',olddoc->'late_minutes',olddoc->'early_out_minutes',olddoc->'under_minutes',CASE WHEN jsonb_typeof(olddoc->'calc_trace')='object' THEN(olddoc->'calc_trace')-'overtime'-'overtimePattern' ELSE '{}'::jsonb END) IS NOT DISTINCT FROM(newdoc->'check_in_at',newdoc->'check_out_at',newdoc->'status',newdoc->'absence_reason',newdoc->'day_type',newdoc->'worked_minutes',newdoc->'late_minutes',newdoc->'early_out_minutes',newdoc->'under_minutes',CASE WHEN jsonb_typeof(newdoc->'calc_trace')='object' THEN(newdoc->'calc_trace')-'overtime'-'overtimePattern' ELSE '{}'::jsonb END) THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='attendance_punch' AND (olddoc->'employment_id',olddoc->'attendance_date',olddoc->'punch_at',olddoc->'direction',olddoc->'attendance_id',olddoc->'voided_at') IS NOT DISTINCT FROM(newdoc->'employment_id',newdoc->'attendance_date',newdoc->'punch_at',newdoc->'direction',newdoc->'attendance_id',newdoc->'voided_at') THEN RETURN NEW;END IF;
  IF TG_TABLE_NAME='attendance_correction' AND (olddoc-'reason'-'remarks') IS NOT DISTINCT FROM(newdoc-'reason'-'remarks') THEN RETURN NEW;END IF;
 END IF;
 SELECT rolsuper OR rolbypassrls INTO full_source_visibility FROM pg_catalog.pg_roles WHERE rolname=current_user;
 FOR doc IN SELECT value FROM jsonb_array_elements(jsonb_build_array(olddoc,newdoc)) WHERE value<>'null'::jsonb LOOP
  tenant_value:=(doc->>'tenant_id')::uuid;
  -- Non-OT requests/decisions are not formula approval inputs. Their actual clock effects still
  -- pass through Attendance/punch guards; OLD and NEW docs retain protection for removed OT inputs.
  IF TG_TABLE_NAME='attendance_correction' AND doc->>'requested_ot_minutes' IS NULL THEN CONTINUE;END IF;
  IF TG_TABLE_NAME='attendance_workflow_decision' THEN
   SELECT c.employment_id,c.attendance_date,c.requested_ot_minutes INTO emp,on_date,requested_minutes FROM public.attendance_workflow_request r JOIN public.attendance_correction c ON c.id=r.correction_id AND c.tenant_id=r.tenant_id WHERE r.id=(doc->>'request_id')::uuid AND r.tenant_id=tenant_value;
   IF FOUND AND requested_minutes IS NULL THEN CONTINUE;END IF;
  ELSE emp:=(doc->>'employment_id')::uuid;on_date:=(doc->>'attendance_date')::date;END IF;
  IF full_source_visibility AND emp IS NOT NULL AND on_date IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.attendance_overtime_source d WHERE d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date) THEN CONTINUE;END IF;
  IF tenant_value IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Overtime input tenant mismatch' USING ERRCODE='42501';END IF;
  IF emp IS NULL OR on_date IS NULL THEN CONTINUE;END IF;source_key:=emp::text||':'||on_date::text;IF source_key=ANY(seen) THEN CONTINUE;END IF;seen:=array_append(seen,source_key);
  IF NOT(emp=ANY(app.visible_employment_ids()) OR app.can_admin_payroll_employment(emp)) THEN RAISE EXCEPTION 'Canonical Attendance subject authority is required' USING ERRCODE='42501';END IF;
  -- Raw input is already Attendance-row locked. Serialize source claims BEFORE batch locks; do not
  -- acquire employee advisory here (actual calculation takes employee -> Attendance -> source).
  PERFORM d.id FROM public.attendance_overtime_source d WHERE d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date ORDER BY d.id FOR UPDATE;
  -- Tenant plus subject authority makes the matching source visible even under FORCE RLS.
  IF NOT FOUND THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM public.overtime_source_settlement st JOIN public.attendance_overtime_source d ON d.id=st.source_id WHERE st.tenant_id=tenant_value AND d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date AND st.mode='toil' AND st.released_at IS NULL) THEN RAISE EXCEPTION 'Reverse and release canonical TOIL before changing its overtime source' USING ERRCODE='23514';END IF;
  -- The existing private owner locks every relevant batch in stable ID order, including draft runs.
  PERFORM * FROM app.attendance_payroll_protection_rows(emp);
  FOR claim IN SELECT st.id,st.payroll_batch_id,d.id AS source_id FROM public.overtime_source_settlement st JOIN public.attendance_overtime_source d ON d.id=st.source_id WHERE st.tenant_id=tenant_value AND d.tenant_id=tenant_value AND d.employment_id=emp AND d.attendance_date=on_date AND st.mode='cash' AND st.released_at IS NULL ORDER BY st.payroll_batch_id LOOP
   SELECT status::text INTO batch_status FROM public.payroll_batch WHERE id=claim.payroll_batch_id AND tenant_id=tenant_value FOR UPDATE;
   IF batch_status='closed' THEN RAISE EXCEPTION 'Closed Payroll protects this overtime source; use its controlled adjustment workflow' USING ERRCODE='23514';END IF;
   IF batch_status='processed' THEN
    UPDATE public.payroll_batch SET needs_recalc_at=now(),recalc_employment_ids=(SELECT coalesce(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(coalesce(recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(emp::text))) WHERE id=claim.payroll_batch_id AND tenant_id=tenant_value AND status='processed';
   END IF;
   -- Append invalidation evidence; do NOT take a source row lock after the batch (cash transfer uses
   -- employee -> source -> batch). Fresh canonical digests remain the settlement/close authority.
   INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(tenant_value,'overtime-pattern',claim.source_id,'overtime.cash-source.invalidated','user',app.current_user_id(),emp,jsonb_build_object('sourceId',claim.source_id,'batchId',claim.payroll_batch_id,'date',on_date,'inputOwner',TG_TABLE_NAME,'operation',TG_OP));
  END LOOP;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.guard_overtime_cash_source_write() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_overtime_cash_source BEFORE INSERT OR UPDATE OR DELETE ON attendance FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_cash_source_write();
CREATE TRIGGER attendance_punch_overtime_cash_source BEFORE INSERT OR UPDATE OR DELETE ON attendance_punch FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_cash_source_write();
CREATE TRIGGER attendance_day_adjustment_overtime_cash_source BEFORE INSERT OR UPDATE OR DELETE ON attendance_day_adjustment FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_cash_source_write();
CREATE TRIGGER attendance_correction_overtime_cash_source BEFORE INSERT OR UPDATE OR DELETE ON attendance_correction FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_cash_source_write();
CREATE TRIGGER attendance_workflow_decision_overtime_cash_source BEFORE INSERT OR UPDATE OR DELETE ON attendance_workflow_decision FOR EACH ROW EXECUTE FUNCTION app.guard_overtime_cash_source_write();

--> statement-breakpoint
-- Deferred events observe the final canonical OT rows, not intermediate delete/insert ladders.
-- Every event uses digest deduplication under the persistent tenant epoch: one changed final snapshot.
CREATE FUNCTION app.snapshot_legacy_overtime_edit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rid uuid;tid uuid;r public.attendance_rule;p public.overtime_pattern;lastver public.overtime_pattern_version;vid uuid;definition jsonb;hash text;
BEGIN
 IF TG_TABLE_NAME='attendance_rule' THEN
  IF TG_OP='UPDATE' AND NEW.apply_to_early_ot IS NOT DISTINCT FROM OLD.apply_to_early_ot THEN RETURN NULL;END IF;
  rid:=NEW.id;tid:=NEW.tenant_id;
 ELSE
  IF TG_OP='DELETE' THEN rid:=OLD.rule_id;tid:=OLD.tenant_id;ELSE rid:=NEW.rule_id;tid:=NEW.tenant_id;END IF;
 END IF;
 SELECT * INTO r FROM public.attendance_rule WHERE id=rid AND tenant_id=tid;
 IF r.id IS NULL THEN RETURN NULL;END IF; -- Canonical unused-group deletion retains prior history only.
 PERFORM app.lock_overtime_configuration(tid);
 definition:=jsonb_build_object('kind','legacy','ruleId',r.id,'applyToEarlyOt',r.apply_to_early_ot,'rows',coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.from_minutes,b.id) FROM public.attendance_rule_ot_row b WHERE b.rule_id=r.id AND b.tenant_id=tid),'[]'::jsonb));
 hash:=encode(sha256(convert_to(definition::text,'UTF8')),'hex');
 SELECT * INTO p FROM public.overtime_pattern WHERE tenant_id=tid AND legacy_rule_ref=rid;
 IF p.id IS NULL THEN INSERT INTO public.overtime_pattern(tenant_id,kind,legacy_rule_ref,legacy_rule_id) VALUES(tid,'legacy',rid,rid) RETURNING * INTO p;END IF;
 SELECT * INTO lastver FROM public.overtime_pattern_version WHERE pattern_id=p.id ORDER BY ordinal DESC LIMIT 1;
 IF lastver.id IS NOT NULL AND lastver.definition=definition THEN RETURN NULL;END IF;
 INSERT INTO public.overtime_pattern_version(tenant_id,pattern_id,kind,ordinal,name,description,definition,digest,activated_at) VALUES(tid,p.id,'legacy',coalesce(lastver.ordinal,0)+1,r.name,coalesce(r.description,''),definition,hash,now()) RETURNING id INTO vid;
 INSERT INTO public.overtime_pattern_version_state(tenant_id,version_id,sequence,state,effective_from,reason) VALUES(tid,vid,1,CASE WHEN r.status='active' THEN 'active' ELSE 'inactive' END,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,'Canonical final legacy OT snapshot');
 INSERT INTO public.overtime_pattern_legacy_binding(tenant_id,legacy_rule_ref,rule_id,version_id,effective_from) VALUES(tid,rid,rid,vid,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(tid,'overtime-pattern',p.id,'overtime.legacy.snapshot.recorded','user',app.current_user_id(),jsonb_build_object('ruleId',rid,'versionId',vid,'digest',hash));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.snapshot_legacy_overtime_edit() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER overtime_legacy_rule_snapshot AFTER INSERT OR UPDATE ON attendance_rule DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.snapshot_legacy_overtime_edit();
CREATE CONSTRAINT TRIGGER overtime_legacy_rows_snapshot AFTER INSERT OR UPDATE OR DELETE ON attendance_rule_ot_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.snapshot_legacy_overtime_edit();

--> statement-breakpoint
CREATE FUNCTION app.check_overtime_assignment_final() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a public.overtime_pattern_assignment;aid uuid;tid uuid;
BEGIN
 IF TG_TABLE_NAME='overtime_pattern_assignment' THEN aid:=NEW.id;tid:=NEW.tenant_id;ELSE aid:=NEW.assignment_id;tid:=NEW.tenant_id;END IF;
 SELECT * INTO a FROM public.overtime_pattern_assignment WHERE id=aid AND tenant_id=tid;
 IF a.id IS NULL THEN RETURN NULL;END IF;
 IF a.target->>'type'='individual' THEN
  IF jsonb_typeof(a.target->'employmentIds')<>'array' OR jsonb_array_length(a.target->'employmentIds') NOT BETWEEN 1 AND 500 OR (SELECT count(*) FROM public.overtime_pattern_assignment_employment WHERE assignment_id=aid)<>jsonb_array_length(a.target->'employmentIds') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.target->'employmentIds') id WHERE NOT EXISTS(SELECT 1 FROM public.overtime_pattern_assignment_employment m WHERE m.assignment_id=aid AND m.employment_id::text=id)) THEN RAISE EXCEPTION 'Persist every exact individual assignment member' USING ERRCODE='23514';END IF;
 ELSIF a.target->>'type'='group' THEN
  IF jsonb_typeof(a.target->'condition')<>'object' OR EXISTS(SELECT 1 FROM public.overtime_pattern_assignment_employment WHERE assignment_id=aid) THEN RAISE EXCEPTION 'Group assignments require their typed condition only' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'Unknown overtime assignment target' USING ERRCODE='23514';END IF;
 IF a.superseded_at IS NULL AND EXISTS(
  SELECT 1 FROM public.overtime_pattern_assignment peer
  WHERE peer.tenant_id=tid AND peer.id<>aid AND peer.superseded_at IS NULL AND peer.priority=a.priority
   AND peer.valid_from<coalesce(a.valid_to,'infinity'::date) AND a.valid_from<coalesce(peer.valid_to,'infinity'::date)
   AND peer.target->>'type'=a.target->>'type'
   AND EXISTS(SELECT 1 FROM public.overtime_pattern_version_company x JOIN public.overtime_pattern_version_company y ON y.company_id=x.company_id WHERE x.version_id=a.version_id AND y.version_id=peer.version_id)
   AND ((a.target->>'type'='individual' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.target->'employmentIds') mine JOIN jsonb_array_elements_text(peer.target->'employmentIds') theirs ON mine=theirs)) OR(a.target->>'type'='group' AND a.target->'condition'=peer.target->'condition'))
 ) THEN RAISE EXCEPTION 'Equal priority effective assignments have overlapping scope' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.check_overtime_assignment_final() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER overtime_assignment_final AFTER INSERT OR UPDATE ON overtime_pattern_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_overtime_assignment_final();
CREATE CONSTRAINT TRIGGER overtime_assignment_members_final AFTER INSERT ON overtime_pattern_assignment_employment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_overtime_assignment_final();
