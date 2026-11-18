-- Rich snapshots use the existing idempotency, lease and private identity boundary. Legacy queued payloads are untouched.
CREATE FUNCTION app.automation_rich_email_queue(p_module text, p_subject uuid, p_key text, p_to uuid[], p_cc uuid[], p_subject_line text, p_body text, p_template uuid, p_render jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); to_ids uuid[]; cc_ids uuid[]; unreachable uuid[]; queued integer := 0; v_employment uuid; link text; definition jsonb; asset jsonb;
BEGIN
  IF app.automation_can_run(p_module, p_subject) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF length(coalesce(p_key, '')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_subject_line, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_body, '')) > 20000
     OR coalesce(cardinality(p_to), 0) > 200 OR coalesce(cardinality(p_cc), 0) > 200 OR coalesce(cardinality(p_to), 0) + coalesce(cardinality(p_cc), 0) = 0
  THEN RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  IF p_module = 'probation' THEN
    SELECT c.employment_id INTO v_employment FROM public.probation_case c WHERE c.id = p_subject AND c.tenant_id = t;
    IF v_employment IS NULL THEN RAISE EXCEPTION 'Probation case unavailable'; END IF;
    link := '/lifecycle/probation/' || p_subject::text;
  ELSE RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  SELECT v.definition INTO definition FROM automation_email_template_version v WHERE v.tenant_id=t AND v.template_id=p_template AND v.module=p_module ORDER BY v.revision DESC LIMIT 1;
  IF definition IS NULL OR jsonb_typeof(p_render) IS DISTINCT FROM 'object' OR p_render->>'version'<>'2' OR jsonb_typeof(p_render->'html') IS DISTINCT FROM 'string' OR octet_length(p_render->>'html')>1000000 OR jsonb_typeof(p_render->'assets') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rich email snapshot' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(p_render->'assets')>23 THEN RAISE EXCEPTION 'Too many email attachments' USING ERRCODE='22023';END IF;
  FOR asset IN SELECT value FROM jsonb_array_elements(p_render->'assets') LOOP
    IF NOT EXISTS(SELECT 1 FROM automation_email_asset a WHERE a.tenant_id=t AND a.template_id=p_template AND a.id::text=asset->>'id' AND a.kind=asset->>'kind' AND a.content_hash=asset->>'contentHash' AND EXISTS(SELECT 1 FROM jsonb_array_elements((definition->'files')||(definition->'images')) r WHERE r->>'id'=a.id::text AND r->>'contentHash'=a.content_hash)) THEN RAISE EXCEPTION 'Email asset unavailable' USING ERRCODE='22023';END IF;
  END LOOP;
  IF jsonb_typeof(coalesce(p_render->'documents','[]'::jsonb)) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid document references' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(coalesce(p_render->'documents','[]'::jsonb))>100 THEN RAISE EXCEPTION 'Too many document references' USING ERRCODE='22023';END IF;
  FOR asset IN SELECT value FROM jsonb_array_elements(coalesce(p_render->'documents','[]'::jsonb)) LOOP
   IF NOT EXISTS(SELECT 1 FROM probation_file f JOIN probation_part part ON part.id=f.part_id AND part.tenant_id=f.tenant_id JOIN probation_builder_definition b ON b.id::text=part.data->>'letterTemplateId' AND b.tenant_id=f.tenant_id AND b.kind='template'
     WHERE f.tenant_id=t AND f.case_id=p_subject AND f.kind='letter_released' AND f.id::text=asset->>'id' AND f.content_hash=asset->>'contentHash' AND b.definition_key::text=asset->>'templateId'
      AND (coalesce((asset->>'link')::boolean,false) IS NOT TRUE OR definition->'links'?b.definition_key::text)
      AND (coalesce((asset->>'attach')::boolean,false) IS NOT TRUE OR definition->'attachments'?b.definition_key::text OR definition->>'outcomeLetter'='true' AND asset->>'outcome'='true' AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.tenant_id=t AND o.case_id=p_subject AND o.id::text=asset->>'outcomeId' AND o.letter_file_id=f.id AND o.letter_part_id=part.id AND o.released_at IS NOT NULL)))
   THEN RAISE EXCEPTION 'Generated email document unavailable' USING ERRCODE='22023';END IF;
  END LOOP;
  IF jsonb_typeof(coalesce(p_render->'caseFiles','[]'::jsonb)) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid per-person files' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(coalesce(p_render->'caseFiles','[]'::jsonb))>50 THEN RAISE EXCEPTION 'Too many per-person files' USING ERRCODE='22023';END IF;
  FOR asset IN SELECT value FROM jsonb_array_elements(coalesce(p_render->'caseFiles','[]'::jsonb)) LOOP
   IF NOT EXISTS(SELECT 1 FROM automation_email_case_file f WHERE f.id::text=asset->>'id' AND f.tenant_id=t AND f.case_id=p_subject AND f.template_id=p_template AND f.slot_id::text=asset->>'slotId' AND f.content_hash=asset->>'contentHash' AND EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'slots') slot WHERE slot->>'id'=f.slot_id::text)) THEN RAISE EXCEPTION 'Per-person file unavailable' USING ERRCODE='22023';END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'slots') slot WHERE slot->>'required'='true' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_render->'caseFiles','[]'::jsonb)) f WHERE f->>'slotId'=slot->>'id')) THEN RAISE EXCEPTION 'Required per-person file missing' USING ERRCODE='22023';END IF;
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
          'subject', p_subject_line, 'body', coalesce(p_body, ''),
          'delivery', p_render || jsonb_build_object('sender','noreply','templateId',p_template))),
        app.current_user_id()
      FROM generate_series(0, (cardinality(to_ids) - 1) / 8) g
      ON CONFLICT (tenant_id, mail_key) DO NOTHING RETURNING 1)
    SELECT count(*) INTO queued FROM inserted;
  END IF;
  IF queued > 0 THEN
    INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
    VALUES (t, 'automation-email', p_subject, 'automation.rich-email-queued', CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,
      app.current_user_id(), v_employment, jsonb_build_object('module', p_module, 'subjectId', p_subject, 'key', p_key, 'messages', queued,
      'recipients', cardinality(to_ids) + cardinality(cc_ids), 'withoutEmail', cardinality(unreachable)));
  END IF;
  RETURN jsonb_build_object('queued', queued, 'to', to_jsonb(to_ids), 'cc', to_jsonb(cc_ids), 'unreachable', to_jsonb(unreachable));
END $$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_rich_email_queue(text,uuid,text,uuid[],uuid[],text,text,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_rich_email_queue(text,uuid,text,uuid[],uuid[],text,text,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_rich_email_definitions(p_case uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_run('probation',p_case) IS NOT TRUE THEN RAISE EXCEPTION 'Workflow unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_object_agg(v.template_id::text,v.definition),'{}'::jsonb) INTO result FROM (SELECT DISTINCT ON(template_id) template_id,definition FROM automation_email_template_version WHERE tenant_id=app.current_tenant_id() AND module='probation' ORDER BY template_id,revision DESC LIMIT 500) v WHERE v.definition IS NOT NULL;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_rich_email_definitions(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_rich_email_definitions(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_assets(p_id uuid,p_token uuid,p_origin text) RETURNS TABLE(id uuid,kind text,filename text,mime_type text,bytes text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);IF target IS NULL THEN RETURN;END IF;
 RETURN QUERY SELECT a.id,a.kind,a.filename,a.mime_type,encode(a.content,'base64') FROM automation_email_asset a JOIN jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb)) r ON r->>'id'=a.id::text AND r->>'contentHash'=a.content_hash WHERE a.tenant_id=(target->>'tenantId')::uuid ORDER BY a.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_assets(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_email_assets(uuid,uuid,text) TO ai_hr_app;
