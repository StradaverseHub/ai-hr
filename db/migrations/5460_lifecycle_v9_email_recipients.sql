-- DRAFT (board 4a60b3ec, lane block 5460-5479): workflow email recipients.
-- 1. A workflow email reaches everyone in To together: up to eight To recipients per queued message.
-- 2. An onboarding contact without an account stays the first To recipient; the rest of To and CC resolve as before.
-- 3. lc_v9_email_hold: a projection of held email steps, written in the same transaction as the case store,
--    read for the Inbox. Labels and reasons only; it never holds an address.
CREATE OR REPLACE FUNCTION app.lc_v9_capture_mail() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent_id uuid; company uuid; state jsonb; facts jsonb; is_native boolean; mail jsonb;
 docs jsonb; files jsonb; subject jsonb; parent_state text; parent_number text;
BEGIN
 is_native:=TG_TABLE_NAME='lc_onboarding_private';
 IF is_native THEN
  parent_id:=NEW.case_id; state:=NEW.data->'lifecycleV9';
  SELECT c.company_id,c.data->>'state',c.data->>'number',NEW.data->'lifecycleV9Subject'
   INTO company,parent_state,parent_number,subject
   FROM lc_onboarding_case c WHERE c.id=parent_id AND c.tenant_id=NEW.tenant_id;
 ELSE
  parent_id:=NEW.id; state:=NEW.data; company:=NEW.company_id;
  parent_state:=state->>'state'; parent_number:=state->>'number'; facts:=state->'facts';
  subject:=jsonb_build_object('personId',facts->>'personId','employmentId',facts->>'employmentId');
 END IF;
 IF company IS NULL OR state IS NULL THEN RETURN NEW; END IF;
 IF parent_state IS DISTINCT FROM 'submitted' THEN
  UPDATE lc_v9_email_delivery SET status='cancelled',error_code='notEligible',updated_at=now()
   WHERE tenant_id=NEW.tenant_id AND coalesce(case_id,onboarding_case_id)=parent_id
    AND status IN ('queued','retry','leased') AND started_at IS NULL AND NOT app.lc_v9_is_self_test(payload->'mail');
 END IF;
 FOR mail IN SELECT value FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) LOOP
  IF parent_state IS DISTINCT FROM 'submitted' AND NOT app.lc_v9_is_self_test(mail) OR mail->'test'='true'::jsonb AND NOT app.lc_v9_is_self_test(mail) THEN CONTINUE; END IF;
  -- Old records without frozen transport choices remain historical holds.
  IF mail->>'status'<>'pending' OR mail->'delivery'->>'version' IS DISTINCT FROM '1' OR
     coalesce(mail->>'id','')='' OR jsonb_typeof(mail->'to') IS DISTINCT FROM 'array' OR
     jsonb_array_length(mail->'to') NOT BETWEEN 1 AND 8 OR coalesce(mail->'delivery'->>'sender','') NOT IN ('onboarding','hr','noreply')
  THEN CONTINUE; END IF;
  -- Bind a new test intent to its actual database actor; worker updates reuse the sealed job.
  IF app.lc_v9_is_self_test(mail) AND NOT EXISTS(
   SELECT 1 FROM lc_v9_email_delivery existing WHERE existing.tenant_id=NEW.tenant_id
    AND coalesce(existing.case_id,existing.onboarding_case_id)=parent_id AND existing.mail_id=mail->>'id')
   AND (app.current_user_id() IS NULL OR mail->'delivery'->'queuedBy'->>'id' IS DISTINCT FROM app.current_user_id()::text)
  THEN CONTINUE; END IF;
  SELECT coalesce(jsonb_agg(d),'[]'::jsonb) INTO docs
   FROM jsonb_array_elements(coalesce(state->'documents','[]'::jsonb)) d
   WHERE coalesce(mail->'documentIds','[]'::jsonb) ? (d->>'id');
  SELECT coalesce(jsonb_agg(f),'[]'::jsonb) INTO files
   FROM jsonb_array_elements(coalesce(state->'files','[]'::jsonb)) f
   WHERE coalesce(mail->'fileIds','[]'::jsonb) ? (f->>'id');
  IF jsonb_array_length(docs)<>jsonb_array_length(coalesce(mail->'documentIds','[]'::jsonb)) OR
     jsonb_array_length(files)<>jsonb_array_length(coalesce(mail->'fileIds','[]'::jsonb)) THEN
    RAISE EXCEPTION 'A queued lifecycle delivery has missing documents or files';
  END IF;
  INSERT INTO lc_v9_email_delivery(tenant_id,company_id,case_id,onboarding_case_id,mail_id,payload)
   VALUES(NEW.tenant_id,company,CASE WHEN NOT is_native THEN parent_id END,CASE WHEN is_native THEN parent_id END,mail->>'id',
    jsonb_build_object('version',1,'mail',mail,'documents',docs,'files',files,'subject',subject,'number',parent_number))
   ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_capture_mail() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.lc_v9_email_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job lc_v9_email_delivery%ROWTYPE; state jsonb; subject jsonb; parent_state text; bindings jsonb; total integer; contact jsonb; contact_email text; recipient_ids jsonb; literals jsonb;
BEGIN
 IF p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
 SELECT * INTO job FROM lc_v9_email_delivery WHERE id=p_id AND lease_token=p_token
  AND status='leased' AND started_at IS NULL AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.case_id IS NOT NULL THEN
  SELECT c.data,c.data->>'state',jsonb_build_object('personId',c.data->'facts'->>'personId','employmentId',c.data->'facts'->>'employmentId')
   INTO state,parent_state,subject FROM lc_v9_case c
   WHERE c.id=job.case_id AND c.tenant_id=job.tenant_id AND c.company_id=job.company_id;
 ELSE
  SELECT p.data->'lifecycleV9',c.data->>'state',p.data->'lifecycleV9Subject',CASE WHEN p.data ? 'caseContactEmail' THEN p.data->>'caseContactEmail' WHEN c.data->'source' ? 'email' THEN c.data->'source'->>'email' ELSE c.data->'local'->>'email' END
   INTO state,parent_state,subject,contact_email FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
   WHERE c.id=job.onboarding_case_id AND c.tenant_id=job.tenant_id AND c.company_id=job.company_id
    AND (p.data->'lifecycleV9Subject'->>'personId') IS NOT DISTINCT FROM c.data->>'personId'
    AND (p.data->'lifecycleV9Subject'->>'employmentId') IS NOT DISTINCT FROM c.data->>'employmentId';
 END IF;
 IF (parent_state IS DISTINCT FROM 'submitted' AND NOT app.lc_v9_is_self_test(job.payload->'mail')) OR
  (job.payload->'mail'->'test'='true'::jsonb AND NOT app.lc_v9_is_self_test(job.payload->'mail')) OR subject IS DISTINCT FROM job.payload->'subject' OR
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'mails') m WHERE m->>'id'=job.mail_id AND m->>'status'='sending')
 THEN RETURN NULL; END IF;
 -- A document changed through another writer must never be marked sent as a different copy.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(job.payload->'documents') frozen
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'documents') current WHERE current=frozen)) THEN RETURN NULL; END IF;
 contact:=job.payload->'mail'->'delivery'->'contact';
 IF contact IS NOT NULL THEN
  IF job.onboarding_case_id IS NULL OR contact->>'kind' IS DISTINCT FROM 'onboardingContact' OR
   contact->>'caseId' IS DISTINCT FROM job.onboarding_case_id::text OR contact->>'email' IS DISTINCT FROM trim(contact_email) OR
   job.payload->'mail'->'to'->>0 IS DISTINCT FROM contact->>'email' OR
   jsonb_array_length(job.payload->'mail'->'delivery'->'linkDocumentIds')<>0 THEN RETURN NULL; END IF;
 END IF;
 recipient_ids:=(CASE WHEN contact IS NULL THEN job.payload->'mail'->'to' ELSE (job.payload->'mail'->'to')-0 END)||coalesce(job.payload->'mail'->'cc','[]'::jsonb);
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.uid,'email',app.lc_v9_literal_address(r.uid),'position',r.ordinality+(CASE WHEN contact IS NULL THEN 0 ELSE 1 END)) ORDER BY r.ordinality) FILTER(WHERE r.uid LIKE 'address:%'),'[]'::jsonb)
  INTO literals FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(literals) r WHERE r->>'email' IS NULL) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(r.uid ORDER BY r.ordinality),'[]'::jsonb) INTO recipient_ids FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality) WHERE r.uid NOT LIKE 'address:%';
 SELECT count(*) INTO total FROM jsonb_array_elements_text(recipient_ids);
 SELECT jsonb_agg(jsonb_build_object('userId',r.uid,'subject',identity.subject,'issuer',identity.issuer) ORDER BY r.ordinality)
  INTO bindings
  FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality)
  JOIN app_user u ON u.id::text=r.uid AND u.tenant_id=job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN app_external_identity identity ON identity.app_user_id=u.id AND identity.issuer=p_origin||'/auth/'||job.tenant_id::text AND identity.revoked_at IS NULL;
 bindings:=coalesce(bindings,'[]'::jsonb);
 IF jsonb_array_length(bindings)<>total OR total<1 AND contact IS NULL AND jsonb_array_length(literals)=0 OR
  (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b)<>total THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'companyId',job.company_id,'caseId',coalesce(job.case_id,job.onboarding_case_id),'payload',job.payload,'bindings',bindings,'contact',contact,'literals',literals);
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) TO ai_hr_app;

CREATE TABLE lc_v9_email_hold (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), module text NOT NULL CHECK(module IN ('onb','off')),
 -- The V9 offboarding case or the Native onboarding case; the case store owns both.
 case_id uuid NOT NULL, case_number text NOT NULL CHECK(length(case_number) BETWEEN 1 AND 200),
 subject_name text NOT NULL CHECK(length(subject_name) <= 500),
 run_id text NOT NULL CHECK(length(run_id) BETWEEN 1 AND 300), step_id text NOT NULL CHECK(length(step_id) BETWEEN 1 AND 120),
 workflow_name text NOT NULL CHECK(length(workflow_name) <= 200), email_name text NOT NULL CHECK(length(email_name) <= 1000),
 missing jsonb NOT NULL CHECK(jsonb_typeof(missing)='array' AND jsonb_array_length(missing) BETWEEN 1 AND 32),
 held_at timestamptz NOT NULL, released_at timestamptz, released_by uuid REFERENCES app_user(id),
 UNIQUE(tenant_id,case_id,run_id,step_id,held_at)
);
CREATE INDEX lc_v9_email_hold_open ON lc_v9_email_hold(tenant_id,module,held_at) WHERE released_at IS NULL;
CREATE INDEX lc_v9_email_hold_case ON lc_v9_email_hold(tenant_id,case_id) WHERE released_at IS NULL;
ALTER TABLE lc_v9_email_hold ENABLE ROW LEVEL SECURITY;
-- The same company and module authority as the case itself.
CREATE POLICY v9_email_hold_read ON lc_v9_email_hold FOR SELECT USING(tenant_id=app.current_tenant_id() AND (
 module='off' AND app.lc_v9_off_access(company_id) OR
 module='onb' AND app.is_admin_for(company_id) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())));
CREATE POLICY v9_email_hold_insert ON lc_v9_email_hold FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND released_at IS NULL AND (
 module='off' AND app.lc_v9_off_access(company_id) OR
 module='onb' AND app.is_admin_for(company_id) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())));
CREATE POLICY v9_email_hold_release ON lc_v9_email_hold FOR UPDATE USING(tenant_id=app.current_tenant_id() AND released_at IS NULL AND (
 module='off' AND app.lc_v9_off_access(company_id) OR
 module='onb' AND app.is_admin_for(company_id) AND (app.onboarding_page_access() OR app.onboarding_v9_case_actor() OR app.is_group_admin())))
 WITH CHECK(tenant_id=app.current_tenant_id() AND released_at IS NOT NULL);
-- The scheduled sweep runs as the storage owner, like the capture trigger's delivery rows.
CREATE POLICY v9_email_hold_storage_owner ON lc_v9_email_hold TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON lc_v9_email_hold FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON lc_v9_email_hold TO ai_hr_app;
