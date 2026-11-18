-- Approved 4a60b3ec: eight recipient CHOICES is the editor limit, not an address fanout limit.
-- Keep one immutable email for every resolved group/task-owner member. This restates the current
-- 5460 capture owner byte-for-byte except for its erroneous eight-address ceiling. No auth, contact,
-- document, replay or sender checks change; already captured receipts/payloads remain immutable.
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
  IF mail->>'status'<>'pending' OR coalesce(mail->'delivery'->>'version','') NOT IN ('1','2') OR
     coalesce(mail->>'id','')='' OR jsonb_typeof(mail->'to') IS DISTINCT FROM 'array' OR
     jsonb_array_length(mail->'to')<1 OR coalesce(mail->'delivery'->>'sender','') NOT IN ('onboarding','hr','noreply')
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

