-- Nullable rich source on new revisions. Existing plain messages retain their original source.
ALTER TABLE public.automation_email_template_version ADD COLUMN body_doc jsonb CHECK(body_doc IS NULL OR (jsonb_typeof(body_doc)='object' AND body_doc->>'type'='doc' AND octet_length(body_doc::text)<=262144));
--> statement-breakpoint
CREATE FUNCTION app.automation_email_template_save_rich(p_template uuid, p_module text, p_name text, p_active boolean, p_subject text, p_body text, p_cc jsonb, p_retired boolean, p_expected integer, p_reason text,p_body_doc jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_email_template_version; v_revision integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_template IS NULL OR NOT app.automation_can_configure(p_module) THEN RAISE EXCEPTION 'You cannot configure email templates for this module' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||t::text||':'||p_template::text, 0));
  SELECT * INTO prior FROM public.automation_email_template_version WHERE tenant_id = t AND template_id = p_template ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This email template changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.revision IS NOT NULL AND prior.module <> p_module THEN RAISE EXCEPTION 'An email template cannot move to another module' USING ERRCODE='22023'; END IF;
  IF prior.retired THEN RAISE EXCEPTION 'A retired email template cannot change' USING ERRCODE='22023'; END IF;
  IF p_active IS NULL OR p_retired IS NULL OR length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 200
     OR length(btrim(coalesce(p_subject, ''))) NOT BETWEEN 1 AND 500 OR p_body IS NULL OR length(p_body) > 20000
     OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Each type is checked in its own statement before a function that would fail on another type: SQL does not
  -- promise the order in which OR operands are evaluated.
  IF jsonb_typeof(p_cc) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_cc) > 20 OR pg_column_size(p_cc) > 16384 THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE jsonb_typeof(r) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Every element is now an object, so reading its kind cannot fail.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE coalesce(r->>'kind', '') NOT IN ('role','routing','group','person','pending'))
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF p_body_doc IS NOT NULL AND (jsonb_typeof(p_body_doc) IS DISTINCT FROM 'object' OR p_body_doc->>'type' IS DISTINCT FROM 'doc' OR octet_length(p_body_doc::text)>262144) THEN RAISE EXCEPTION 'Invalid email body' USING ERRCODE='22023';END IF;
  v_revision := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_email_template_version (tenant_id, template_id, revision, module, name, active, subject, body, cc, retired, reason, saved_by,body_doc)
  VALUES (t, p_template, v_revision, p_module, btrim(p_name), p_active, p_subject, p_body, p_cc, p_retired, btrim(p_reason), app.current_user_id(),p_body_doc);
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_email_template', p_template,
    CASE WHEN v_revision = 1 THEN 'automation.email_template.created' WHEN p_retired THEN 'automation.email_template.retired' ELSE 'automation.email_template.saved' END,
    'user'::actor_type, app.current_user_id(),
    jsonb_build_object('module', p_module, 'revision', v_revision, 'active', p_active, 'previousActive', prior.active, 'retired', p_retired));
  RETURN v_revision;
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_template_save_rich(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_template_save_rich(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb) TO ai_hr_app;
