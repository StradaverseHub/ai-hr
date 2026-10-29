-- Durable Bank & Statutory jobs; no HR writes or privilege changes to existing tables.
CREATE TABLE bank_import_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),created_by uuid NOT NULL REFERENCES app_user(id),
 context jsonb NOT NULL,company_ids uuid[] NOT NULL DEFAULT '{}' CHECK(array_position(company_ids,NULL) IS NULL),source_name text NOT NULL CHECK(length(source_name)<=255),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 source_bytes integer NOT NULL CHECK(source_bytes BETWEEN 1 AND 134217728),uploaded_bytes integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','queued','validating','ready','importing','completed','failed','cancelled')),
 total integer NOT NULL DEFAULT 0 CHECK(total BETWEEN 0 AND 250000),validated integer NOT NULL DEFAULT 0,valid integer NOT NULL DEFAULT 0,
 invalid integer NOT NULL DEFAULT 0,unchanged integer NOT NULL DEFAULT 0,processed integer NOT NULL DEFAULT 0,saved integer NOT NULL DEFAULT 0,failed integer NOT NULL DEFAULT 0,
 attempt_id uuid REFERENCES import_attempt(id),error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(uploaded_bytes BETWEEN 0 AND source_bytes),CHECK(processed<=total),CHECK(validated<=total)
);
-- Tenant-wide, including other admins and tabs. Ready previews also reserve their exact source.
CREATE UNIQUE INDEX bank_import_job_active_source ON bank_import_job(tenant_id,source_hash)
 WHERE state IN ('uploading','queued','validating','ready','importing');
CREATE INDEX bank_import_job_queue ON bank_import_job(created_at) WHERE state IN ('queued','validating','importing');
CREATE TABLE bank_import_chunk (
 job_id uuid NOT NULL REFERENCES bank_import_job(id) ON DELETE CASCADE,part integer NOT NULL CHECK(part>=0),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 1048576),PRIMARY KEY(job_id,part)
);
CREATE TABLE bank_import_row (
 job_id uuid NOT NULL REFERENCES bank_import_job(id) ON DELETE CASCADE,ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 250000),
 record jsonb NOT NULL,preview jsonb,company_id uuid REFERENCES company(id),employment_id uuid REFERENCES employment(id),binding text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','valid','invalid','unchanged','applied','failed','skipped')),
 error text,PRIMARY KEY(job_id,ordinal)
);
CREATE INDEX bank_import_row_pending ON bank_import_row(job_id,state,ordinal);
--> statement-breakpoint
-- Cached preview values remain readable only while the captured authority is still held.
-- A freshly resolved weaker login must not regain an old job's enriched employee data.
CREATE FUNCTION app.bank_import_context_current(snapshot jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND snapshot->>'tenantId'=app.current_tenant_id()::text
 AND snapshot->>'userId'=app.current_user_id()::text
 AND EXISTS(SELECT 1 FROM app.principal(app.current_user_id()) p WHERE p.tenant_id=app.current_tenant_id()
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'grants') claimed
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.grants) actual
    WHERE actual->>'role'=claimed->>'role' AND (nullif(actual->>'companyId','') IS NULL
     OR nullif(actual->>'companyId','')=nullif(claimed->>'companyId','')
     OR (nullif(claimed->>'companyId','') IS NOT NULL AND app.is_company_descendant((claimed->>'companyId')::uuid,(actual->>'companyId')::uuid))))));
$$;
REVOKE ALL ON FUNCTION app.bank_import_context_current(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_import_context_current(jsonb) TO ai_hr_app;
CREATE FUNCTION app.bank_import_job_access(wanted uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.bank_import_job j WHERE j.id=wanted AND j.tenant_id=app.current_tenant_id()
 AND j.created_by=app.current_user_id() AND app.bank_import_context_current(j.context)
 AND NOT EXISTS(SELECT 1 FROM unnest(j.company_ids) c WHERE NOT app.import_company_access('bank_statutory',c,'view')));
$$;
REVOKE ALL ON FUNCTION app.bank_import_job_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_import_job_access(uuid) TO ai_hr_app;
CREATE FUNCTION app.bank_import_job_context() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501';END IF;
 NEW.context=jsonb_build_object('tenantId',app.current_tenant_id(),'userId',app.current_user_id(),
 'roles',to_jsonb(app.current_roles()),'grants',coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb));
 RETURN NEW;
END $$;
CREATE FUNCTION app.bank_import_job_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT NEW.company_ids @> OLD.company_ids THEN RAISE EXCEPTION 'Import scope cannot be removed' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_import_job_scope BEFORE UPDATE OF company_ids ON bank_import_job FOR EACH ROW EXECUTE FUNCTION app.bank_import_job_scope();
CREATE TRIGGER bank_import_job_context BEFORE INSERT ON bank_import_job FOR EACH ROW EXECUTE FUNCTION app.bank_import_job_context();
ALTER TABLE bank_import_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_import_job_read ON bank_import_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.bank_import_context_current(context) AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.import_company_access('bank_statutory',c,'view')));
CREATE POLICY bank_import_job_insert ON bank_import_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
CREATE POLICY bank_import_job_update ON bank_import_job FOR UPDATE USING(app.bank_import_job_access(id)) WITH CHECK(app.bank_import_job_access(id));
ALTER TABLE bank_import_chunk ENABLE ROW LEVEL SECURITY;
-- The uncorrelated authorized-job set is computed once per statement, rather than proving the
-- same creator/scope for every one of a 100k-row upload's rows. Job RLS remains authoritative.
CREATE POLICY bank_import_chunk_access ON bank_import_chunk FOR ALL USING(job_id IN (SELECT id FROM bank_import_job)) WITH CHECK(job_id IN (SELECT id FROM bank_import_job));
ALTER TABLE bank_import_row ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_import_row_access ON bank_import_row FOR ALL USING(job_id IN (SELECT id FROM bank_import_job)) WITH CHECK(job_id IN (SELECT id FROM bank_import_job));
REVOKE ALL ON bank_import_job,bank_import_chunk,bank_import_row FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON bank_import_job TO ai_hr_app;
GRANT UPDATE(company_ids,state,uploaded_bytes,total,validated,valid,invalid,unchanged,processed,saved,failed,attempt_id,error,updated_at) ON bank_import_job TO ai_hr_app;
GRANT SELECT,INSERT,DELETE ON bank_import_chunk TO ai_hr_app;
GRANT SELECT,INSERT ON bank_import_row TO ai_hr_app;
GRANT UPDATE(preview,company_id,employment_id,binding,state,error) ON bank_import_row TO ai_hr_app;
--> statement-breakpoint
-- Preserve the 10 MiB ceiling for the other kinds. Bank source is uploaded in 1 MiB requests.
ALTER TABLE import_attempt DROP CONSTRAINT import_attempt_source_content_check;
ALTER TABLE import_attempt ADD CONSTRAINT import_attempt_source_content_check CHECK(octet_length(source_content)<=CASE WHEN kind='bank_statutory' THEN 134217728 ELSE 10485760 END);
--> statement-breakpoint
-- A bounded Bank import projection avoids rebuilding the legacy tenant-wide visible-employment set
-- for every batch. This is narrower than raw-row admin access: current principal, legacy company HR
-- authority AND both current Workforce target predicates remain required. Never returns other tenants,
-- voided employments, salary/compensation rows or arbitrary person columns. Writes still use canonical owners.
CREATE FUNCTION app.bank_import_subjects(p_codes jsonb)
RETURNS TABLE(employment_id uuid,person_id uuid,company_id uuid,employee_code text,hired_on date,
 card_id text,attendance_photo_setting text,payment_method text,full_name text,primary_email text,phone text,country text,statutory jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(p_codes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_codes)>1000 OR NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Import subject lookup refused' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT e.id,e.person_id,e.company_id,e.employee_code,e.hired_on,e.card_id,e.attendance_photo_setting,e.payment_method,
 p.full_name,p.primary_email,p.phone,c.country,CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)||jsonb_build_object(
 'epf_employee_rate',s.epf_employee_rate::text,'epf_employer_rate',s.epf_employer_rate::text,
 'epf_employee_amount',s.epf_employee_amount::text,'epf_employer_amount',s.epf_employer_amount::text,
 'tp3_net_remuneration',s.tp3_net_remuneration::text,'tp3_epf_claimed',s.tp3_epf_claimed::text,
 'tp3_pcb_paid',s.tp3_pcb_paid::text,'tp3_zakat_paid',s.tp3_zakat_paid::text,'tp3_lp',s.tp3_lp::text,
 'zakat_percent',s.zakat_percent::text,'zakat_fixed',s.zakat_fixed::text) END
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=p.id AND s.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 AND e.employee_code=ANY(ARRAY(SELECT jsonb_array_elements_text(p_codes)))
 AND app.is_admin_for(c.id) AND app.access_workforce_employment(e.id,'workforce.view') AND app.access_workforce_person(p.id,'workforce.view');
END $$;
REVOKE ALL ON FUNCTION app.bank_import_subjects(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bank_import_subjects(jsonb) TO ai_hr_app;
