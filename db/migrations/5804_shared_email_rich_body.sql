-- Nullable rich source on new revisions. Existing plain messages retain their original source.
ALTER TABLE public.automation_email_template_version ADD COLUMN body_doc jsonb CHECK(body_doc IS NULL OR (jsonb_typeof(body_doc)='object' AND body_doc->>'type'='doc' AND octet_length(body_doc::text)<=262144));
--> statement-breakpoint
CREATE FUNCTION app.automation_email_template_save_rich(p_template uuid, p_module text, p_name text, p_active boolean, p_subject text, p_body text, p_cc jsonb, p_retired boolean, p_expected integer, p_reason text,p_body_doc jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_email_template_version; v_revision integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_template IS NULL OR NOT app.automation_can_manage(p_module,'templates') THEN RAISE EXCEPTION 'You cannot configure email templates for this module' USING ERRCODE='42501'; END IF;
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

--> statement-breakpoint
CREATE FUNCTION app.automation_email_queue_rich(p_module text, p_subject uuid, p_key text, p_to uuid[], p_cc uuid[], p_subject_line text, p_body text,p_rich_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); to_ids uuid[]; cc_ids uuid[]; unreachable uuid[]; queued integer := 0; v_employment uuid; link text;
BEGIN
  IF app.automation_can_run(p_module, p_subject) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_rich_body IS NOT NULL AND (jsonb_typeof(p_rich_body) IS DISTINCT FROM 'object' OR octet_length(p_rich_body::text)>524288) THEN RAISE EXCEPTION 'Invalid rich email source' USING ERRCODE='22023';END IF;
  IF length(coalesce(p_key, '')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_subject_line, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_body, '')) > 20000
     OR coalesce(cardinality(p_to), 0) > 200 OR coalesce(cardinality(p_cc), 0) > 200 OR coalesce(cardinality(p_to), 0) + coalesce(cardinality(p_cc), 0) = 0
  THEN RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  IF p_module = 'probation' THEN
    SELECT c.employment_id INTO v_employment FROM public.probation_case c WHERE c.id = p_subject AND c.tenant_id = t;
    IF v_employment IS NULL THEN RAISE EXCEPTION 'Probation case unavailable'; END IF;
    link := '/lifecycle/probation/' || p_subject::text;
  ELSE RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  WITH input AS (
    SELECT DISTINCT ON (x.id) x.id, x.n, x.list FROM (
      SELECT id, n, 1 AS list FROM unnest(coalesce(p_to, '{}'::uuid[])) WITH ORDINALITY a(id, n)
      UNION ALL SELECT id, n, 2 AS list FROM unnest(coalesce(p_cc, '{}'::uuid[])) WITH ORDINALITY b(id, n)) x
    WHERE x.id IS NOT NULL ORDER BY x.id, x.list, x.n
  ), checked AS (
    SELECT i.id, i.n, i.list, EXISTS(
      SELECT 1 FROM public.app_user u JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.revoked_at IS NULL AND identity.issuer LIKE '%/auth/' || t::text
      WHERE u.id = i.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AS reachable
    FROM input i
  )
  SELECT coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 1), '{}'),
         coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 2), '{}'),
         coalesce(array_agg(id ORDER BY list, n) FILTER (WHERE NOT reachable), '{}')
    INTO to_ids, cc_ids, unreachable FROM checked;
  IF cardinality(to_ids) = 0 THEN to_ids := cc_ids; cc_ids := '{}'; END IF;
  IF cardinality(to_ids) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.automation_email_delivery (tenant_id, module, subject_id, mail_key, payload, created_by)
      SELECT t, p_module, p_subject, p_key || ':' || g::text,
        jsonb_build_object('version', 1, 'module', p_module, 'subjectId', p_subject, 'linkPath', link, 'mail', jsonb_build_object(
          'id', p_key || ':' || g::text, 'to', to_jsonb(to_ids[g * 8 + 1 : g * 8 + 8]), 'cc', CASE WHEN g = 0 THEN to_jsonb(cc_ids) ELSE '[]'::jsonb END,
          'subject', p_subject_line, 'body', coalesce(p_body, ''),'richBody',p_rich_body,
          'delivery', jsonb_build_object('version', 1, 'sender', 'noreply', 'pdfDocumentIds', '[]'::jsonb, 'linkDocumentIds', '[]'::jsonb, 'assets', '[]'::jsonb))),
        app.current_user_id()
      FROM generate_series(0, (cardinality(to_ids) - 1) / 8) g
      ON CONFLICT (tenant_id, mail_key) DO NOTHING RETURNING 1)
    SELECT count(*) INTO queued FROM inserted;
  END IF;
  IF queued > 0 THEN
    INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
    VALUES (t, 'automation-email', p_subject, 'automation.email-queued', CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,
      app.current_user_id(), v_employment, jsonb_build_object('module', p_module, 'subjectId', p_subject, 'key', p_key, 'messages', queued,
      'recipients', cardinality(to_ids) + cardinality(cc_ids), 'withoutEmail', cardinality(unreachable)));
  END IF;
  RETURN jsonb_build_object('queued', queued, 'to', to_jsonb(to_ids), 'cc', to_jsonb(cc_ids), 'unreachable', to_jsonb(unreachable));
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_queue_rich(text,uuid,text,uuid[],uuid[],text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_queue_rich(text,uuid,text,uuid[],uuid[],text,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_automation_context(uuid) RENAME TO probation_automation_context_before_rich;
--> statement-breakpoint
CREATE FUNCTION app.probation_automation_context(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=app.probation_automation_context_before_rich(p_case);
 result:=jsonb_set(result,'{emailTemplates}',coalesce((SELECT jsonb_agg(e||jsonb_build_object('bodyDoc',(SELECT v.body_doc FROM public.automation_email_template_version v WHERE v.tenant_id=app.current_tenant_id() AND v.module='probation' AND v.template_id::text=e->>'id' ORDER BY v.revision DESC LIMIT 1))) FROM jsonb_array_elements(result->'emailTemplates') e),'[]'::jsonb));
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_automation_context_before_rich(uuid),app.probation_automation_context(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.probation_automation_context(uuid) TO ai_hr_app;
