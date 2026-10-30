-- UNALLOCATED V9 companion draft. An HR retry is a new intent, never a replay of a started receipt.
CREATE FUNCTION app.lc_v9_email_retryable(p_case uuid,p_mail text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job lc_v9_email_delivery%ROWTYPE; state jsonb; subject jsonb; parent_state text; current_mail jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) THEN RETURN false; END IF;
 SELECT * INTO job FROM lc_v9_email_delivery WHERE tenant_id=app.current_tenant_id() AND coalesce(case_id,onboarding_case_id)=p_case AND mail_id=p_mail;
 IF NOT FOUND OR NOT app.is_admin_for(job.company_id) OR job.status NOT IN ('failed','retry') OR job.started_at IS NULL OR job.error_code NOT IN ('smtpTemporary','smtpRejected','smtpAuthentication','smtpTls') THEN RETURN false; END IF;
 IF job.case_id IS NOT NULL THEN
  SELECT data,data->>'state',jsonb_build_object('personId',data->'facts'->>'personId','employmentId',data->'facts'->>'employmentId') INTO state,parent_state,subject FROM lc_v9_case WHERE id=job.case_id AND tenant_id=job.tenant_id;
 ELSE
  SELECT p.data->'lifecycleV9',c.data->>'state',p.data->'lifecycleV9Subject' INTO state,parent_state,subject FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id WHERE c.id=job.onboarding_case_id AND c.tenant_id=job.tenant_id;
 END IF;
 IF parent_state IS DISTINCT FROM 'submitted' OR subject IS DISTINCT FROM job.payload->'subject' THEN RETURN false; END IF;
 SELECT m INTO current_mail FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) m WHERE m->>'id'=p_mail;
 IF current_mail IS NULL OR current_mail->>'status'<>'failed' OR
  (current_mail-ARRAY['status','failure','deliveredAt']) IS DISTINCT FROM ((job.payload->'mail')-ARRAY['status','failure','deliveredAt']) OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) m WHERE m->>'retryOf'=p_mail) OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(job.payload->'documents') frozen WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'documents','[]'::jsonb)) d WHERE d=frozen)) OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(job.payload->'files') frozen WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'files','[]'::jsonb)) f WHERE f=frozen)) THEN RETURN false; END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_retryable(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_retryable(uuid,text) TO ai_hr_app;


-- A reviewed updated copy is a new intent. Only definitive failure or a final, never-started hold
-- can authorize it; immutable old receipts and uncertain/sent deliveries are never replayed.
CREATE FUNCTION app.lc_v9_email_replaceable(p_case uuid,p_mail text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job lc_v9_email_delivery%ROWTYPE; state jsonb; subject jsonb; parent_state text; current_mail jsonb;
BEGIN
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) THEN RETURN false; END IF;
 SELECT * INTO job FROM lc_v9_email_delivery WHERE tenant_id=app.current_tenant_id() AND coalesce(case_id,onboarding_case_id)=p_case AND mail_id=p_mail;
 IF NOT FOUND OR NOT app.is_admin_for(job.company_id) OR NOT (
 job.status IN ('failed','retry') AND job.started_at IS NOT NULL AND job.error_code IN ('smtpTemporary','smtpRejected','smtpAuthentication','smtpTls') OR
 job.status IN ('failed','cancelled') AND job.started_at IS NULL AND job.error_code IN ('recipientUnavailable','recipientChanged','documentChanged','notEligible')) THEN RETURN false; END IF;
 IF job.case_id IS NOT NULL THEN
  IF NOT app.lc_v9_off_access(job.company_id) THEN RETURN false; END IF;
  SELECT data,data->>'state',jsonb_build_object('personId',data->'facts'->>'personId','employmentId',data->'facts'->>'employmentId') INTO state,parent_state,subject FROM lc_v9_case WHERE id=job.case_id AND tenant_id=job.tenant_id;
 ELSE
  IF NOT app.onboarding_v9_case_actor() THEN RETURN false; END IF;
  SELECT p.data->'lifecycleV9',c.data->>'state',p.data->'lifecycleV9Subject' INTO state,parent_state,subject FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id WHERE c.id=job.onboarding_case_id AND c.tenant_id=job.tenant_id;
 END IF;
 IF parent_state IS DISTINCT FROM 'submitted' OR subject IS DISTINCT FROM job.payload->'subject' THEN RETURN false; END IF;
 SELECT m INTO current_mail FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) m WHERE m->>'id'=p_mail;
 IF current_mail IS NULL OR current_mail->>'status' NOT IN ('failed','cancelled') OR current_mail->>'templateId' IS NULL OR coalesce((current_mail->>'test')::boolean,false) OR
  (current_mail-ARRAY['status','failure','deliveredAt']) IS DISTINCT FROM ((job.payload->'mail')-ARRAY['status','failure','deliveredAt']) OR
  EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'mails','[]'::jsonb)) m WHERE m->>'retryOf'=p_mail) THEN RETURN false; END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_replaceable(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_replaceable(uuid,text) TO ai_hr_app;
