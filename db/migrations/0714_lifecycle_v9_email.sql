-- UNALLOCATED V9 companion draft. Rehearse only; no canonical journal allocation or installation.
-- Private transport receipts are separate from the HR-visible case projection. App callers cannot
-- write payloads, claim leases, clear a started marker or select this table.
CREATE TABLE lc_v9_email_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id), company_id uuid NOT NULL REFERENCES company(id),
 case_id uuid REFERENCES lc_v9_case(id), onboarding_case_id uuid REFERENCES lc_onboarding_case(id),
 mail_id text NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','sending','sent','retry','failed','uncertain','cancelled')),
 lease_token uuid, lease_until timestamptz, started_at timestamptz, completed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 error_code text CHECK(error_code IS NULL OR error_code IN ('relayUnavailable','recipientUnavailable','recipientChanged','notEligible','smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain','documentChanged')),
 recipient_proof jsonb, projected_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(case_id,onboarding_case_id)=1), CHECK(jsonb_typeof(payload)='object'),
 CHECK((status NOT IN ('leased','sending')) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(status<>'sending' OR started_at IS NOT NULL), CHECK(status<>'sent' OR completed_at IS NOT NULL)
);
CREATE UNIQUE INDEX lc_v9_email_off_mail ON lc_v9_email_delivery(case_id,mail_id) WHERE case_id IS NOT NULL;
CREATE UNIQUE INDEX lc_v9_email_on_mail ON lc_v9_email_delivery(onboarding_case_id,mail_id) WHERE onboarding_case_id IS NOT NULL;
CREATE INDEX lc_v9_email_due ON lc_v9_email_delivery(tenant_id,next_attempt_at,id) WHERE status IN ('queued','retry','leased','sending');
ALTER TABLE lc_v9_email_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE lc_v9_email_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY lc_v9_email_storage_owner ON lc_v9_email_delivery TO CURRENT_USER USING(true) WITH CHECK(true);
REVOKE ALL ON lc_v9_email_delivery FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.lc_v9_email_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.company_id,NEW.case_id,NEW.onboarding_case_id,NEW.mail_id,NEW.payload,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.case_id,OLD.onboarding_case_id,OLD.mail_id,OLD.payload,OLD.created_at)
 THEN RAISE EXCEPTION 'A queued lifecycle delivery is immutable'; END IF;
 IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
  RAISE EXCEPTION 'A started lifecycle delivery cannot be replayed';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_immutable() FROM PUBLIC;
CREATE TRIGGER lc_v9_email_immutable BEFORE UPDATE ON lc_v9_email_delivery FOR EACH ROW EXECUTE FUNCTION app.lc_v9_email_immutable();

-- Capture only canonical stored records at their actual writer's transaction boundary. There is
-- no caller-controlled payload argument and no second owner of Native onboarding facts/tasks.
-- A closed/pending case may only queue an explicit test to its initiating signed-in actor.
-- This pure internal predicate grants no recipient, company or case authority.
CREATE FUNCTION app.lc_v9_is_self_test(p_mail jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(p_mail->'test'='true'::jsonb
  AND p_mail->'delivery'->'queuedBy'->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND p_mail->'to'=jsonb_build_array(p_mail->'delivery'->'queuedBy'->>'id')
  AND p_mail->'cc'='[]'::jsonb
  AND (p_mail->'delivery'->'contact' IS NULL OR p_mail->'delivery'->'contact'='null'::jsonb),false)
$$;
REVOKE ALL ON FUNCTION app.lc_v9_is_self_test(jsonb) FROM PUBLIC;

CREATE FUNCTION app.lc_v9_capture_mail() RETURNS trigger
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
     jsonb_array_length(mail->'to')<>1 OR coalesce(mail->'delivery'->>'sender','') NOT IN ('onboarding','hr','noreply')
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
CREATE TRIGGER lc_v9_capture_mail AFTER INSERT OR UPDATE OF data ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.lc_v9_capture_mail();
CREATE TRIGGER lc_v9_capture_native_mail AFTER INSERT OR UPDATE OF data ON lc_onboarding_private FOR EACH ROW EXECUTE FUNCTION app.lc_v9_capture_mail();

-- Capability reads are restricted to a live lease and its canonical HTTPS installation origin.
-- The private sender still verifies each encrypted credential through its authentication owner.
CREATE FUNCTION app.lc_v9_email_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job lc_v9_email_delivery%ROWTYPE; state jsonb; subject jsonb; parent_state text; bindings jsonb; total integer; contact jsonb; contact_email text; recipient_ids jsonb;
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
  SELECT p.data->'lifecycleV9',c.data->>'state',p.data->'lifecycleV9Subject',CASE WHEN c.data->'source' ? 'email' THEN c.data->'source'->>'email' ELSE c.data->'local'->>'email' END
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
 recipient_ids:=(CASE WHEN contact IS NULL THEN job.payload->'mail'->'to' ELSE '[]'::jsonb END)||coalesce(job.payload->'mail'->'cc','[]'::jsonb);
 SELECT count(*) INTO total FROM jsonb_array_elements_text(recipient_ids);
 SELECT jsonb_agg(jsonb_build_object('userId',r.uid,'subject',identity.subject,'issuer',identity.issuer) ORDER BY r.ordinality)
  INTO bindings
  FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality)
  JOIN app_user u ON u.id::text=r.uid AND u.tenant_id=job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN app_external_identity identity ON identity.app_user_id=u.id AND identity.issuer=p_origin||'/auth/'||job.tenant_id::text AND identity.revoked_at IS NULL;
 bindings:=coalesce(bindings,'[]'::jsonb);
 IF jsonb_array_length(bindings)<>total OR total<1 AND contact IS NULL OR
  (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b)<>total THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'companyId',job.company_id,'caseId',coalesce(job.case_id,job.onboarding_case_id),'payload',job.payload,'bindings',bindings,'contact',contact);
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) TO ai_hr_app;

-- This statement commits before SMTP starts. A crash after this boundary becomes uncertain;
-- an expired lease with this marker is never requeued automatically.
CREATE FUNCTION app.lc_v9_email_start(p_id uuid,p_token uuid,p_origin text,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 PERFORM 1 FROM lc_v9_email_delivery WHERE id=p_id AND lease_token=p_token FOR UPDATE;
 target:=app.lc_v9_email_target(p_id,p_token,p_origin);
 IF target IS NULL OR jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR p_proof->'bindings' IS DISTINCT FROM target->'bindings' OR p_proof->'contact' IS DISTINCT FROM target->'contact' OR
    jsonb_typeof(p_proof->'addresses') IS DISTINCT FROM 'array' OR jsonb_array_length(p_proof->'addresses')<>jsonb_array_length(target->'bindings')+(CASE WHEN target->'contact' IS NOT NULL AND target->'contact'<>'null'::jsonb THEN 1 ELSE 0 END) OR
    coalesce(p_proof->>'relayRevision','')='' THEN RETURN false; END IF;
 UPDATE lc_v9_email_delivery SET status='sending',started_at=clock_timestamp(),recipient_proof=p_proof,updated_at=now()
  WHERE id=p_id AND lease_token=p_token AND status='leased' AND started_at IS NULL;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_start(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_start(uuid,uuid,text,jsonb) TO ai_hr_app;

CREATE FUNCTION app.lc_v9_email_finish(p_id uuid,p_token uuid,p_outcome text,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_outcome NOT IN ('sent','retry','failed','uncertain') OR
  p_error IS NOT NULL AND p_error NOT IN ('smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain') OR
  p_outcome='sent' AND p_error IS NOT NULL OR p_outcome<>'sent' AND p_error IS NULL THEN RETURN false; END IF;
 UPDATE lc_v9_email_delivery SET status=p_outcome,completed_at=clock_timestamp(),error_code=p_error,projected_at=null,updated_at=now(),
  next_attempt_at=CASE WHEN p_outcome='retry' THEN now()+interval '5 minutes' ELSE next_attempt_at END
 WHERE id=p_id AND lease_token=p_token AND (status='sending' OR status='uncertain' AND error_code='uncertain') AND started_at IS NOT NULL;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_finish(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_finish(uuid,uuid,text,text) TO ai_hr_app;

CREATE FUNCTION app.lc_v9_email_files(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.lc_v9_email_target(p_id,p_token,p_origin);
 IF target IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT f.id,f.filename,f.mime_type,encode(f.content,'base64'),encode(sha256(f.content),'hex')
  FROM jsonb_array_elements(target->'payload'->'files') frozen
  JOIN lc_v9_file f ON f.id::text=frozen->>'storageId' AND f.id::text=frozen->>'id'
   AND f.tenant_id=(target->>'tenantId')::uuid AND f.company_id=(target->>'companyId')::uuid
   AND coalesce(f.case_id,f.onboarding_case_id)=(target->>'caseId')::uuid
   AND f.filename=frozen->>'name' AND encode(sha256(f.content),'hex')=frozen->>'contentHash';
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_files(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_files(uuid,uuid,text) TO ai_hr_app;
