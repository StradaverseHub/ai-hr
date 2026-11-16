-- Additive Offboarding delivery adapter. Existing Probation queue semantics and immutable receipts are unchanged.
-- idx5171 / when1793330100105; append after the resignation owner/configuration/posting migrations.
ALTER TABLE public.automation_email_delivery DROP CONSTRAINT automation_email_delivery_module_check;
--> statement-breakpoint
ALTER TABLE public.automation_email_delivery ADD CONSTRAINT automation_email_delivery_module_check CHECK (module IN ('probation','off'));
--> statement-breakpoint
CREATE FUNCTION app.resignation_email_queue(p_subject uuid,p_key text,p_to uuid[],p_cc uuid[],p_subject_line text,p_body text,p_content jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); j public.resignation_journey%ROWTYPE;
  to_ids uuid[]; cc_ids uuid[]; unreachable uuid[]; queued integer:=0;
  content jsonb:=nullif(p_content,'null'::jsonb); doc jsonb; asset jsonb; file_ref jsonb; total_bytes bigint:=0;
BEGIN
  PERFORM app.resignation_runtime_consume('email',p_subject,jsonb_build_object('key',p_key,'to',to_jsonb(p_to),'cc',to_jsonb(coalesce(p_cc,'{}'::uuid[])),'subject',p_subject_line,'body',p_body,'content',p_content));
  IF app.automation_can_run('off',p_subject) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  SELECT * INTO j FROM public.resignation_journey WHERE tenant_id=t AND id=p_subject;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resignation case unavailable' USING ERRCODE='42501'; END IF;
  IF length(coalesce(p_key,'')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_subject_line,'')) NOT BETWEEN 1 AND 500
    OR length(coalesce(p_body,''))>20000 OR coalesce(cardinality(p_to),0) NOT BETWEEN 1 AND 200
    OR coalesce(cardinality(p_cc),0)>200 THEN RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE='22023'; END IF;
  IF content IS NOT NULL THEN
    IF jsonb_typeof(content)<>'object' OR octet_length(content::text)>1000000
      OR jsonb_typeof(content->'documents') IS DISTINCT FROM 'array'
      OR jsonb_typeof(content->'pdfDocumentIds') IS DISTINCT FROM 'array'
      OR jsonb_typeof(content->'linkDocumentIds') IS DISTINCT FROM 'array'
      OR length(coalesce(content->>'number','')) NOT BETWEEN 1 AND 160
      OR jsonb_array_length(content->'documents')>20
      OR jsonb_typeof(coalesce(content->'assets','[]'::jsonb))<>'array'
      OR jsonb_typeof(coalesce(content->'files','[]'::jsonb))<>'array'
      OR jsonb_array_length(content->'pdfDocumentIds')+jsonb_array_length(coalesce(content->'assets','[]'::jsonb))+jsonb_array_length(coalesce(content->'files','[]'::jsonb))>20
      OR octet_length(coalesce(content->>'html',''))>256000
    THEN RAISE EXCEPTION 'Invalid workflow email content' USING ERRCODE='22023'; END IF;
    FOR doc IN SELECT value FROM jsonb_array_elements(content->'documents') LOOP
      IF doc->>'status' IS DISTINCT FROM 'signed' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(j.data->'releasedDocuments','[]'::jsonb)) frozen WHERE frozen=doc
      ) THEN RAISE EXCEPTION 'Only this case''s frozen released documents can be emailed' USING ERRCODE='22023'; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text((content->'pdfDocumentIds')||(content->'linkDocumentIds')) wanted
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(content->'documents') d WHERE d->>'id'=wanted))
    THEN RAISE EXCEPTION 'An attached document is unavailable' USING ERRCODE='22023'; END IF;
    FOR asset IN SELECT value FROM jsonb_array_elements(coalesce(content->'assets','[]'::jsonb)) LOOP
      IF NOT EXISTS(SELECT 1 FROM public.lc_v9_email_asset a WHERE a.id::text=asset->>'id' AND a.tenant_id=t
        AND a.email_template_id=content->>'emailTemplateId' AND a.kind=asset->>'kind' AND a.filename=asset->>'name'
        AND a.mime_type=asset->>'mimeType' AND a.content_hash=asset->>'contentHash' AND octet_length(a.content)=(asset->>'size')::integer)
        OR asset->>'kind'='image' AND length(trim(coalesce(asset->>'alt','')))=0
      THEN RAISE EXCEPTION 'An email asset changed or belongs to another template' USING ERRCODE='22023'; END IF;
      total_bytes:=total_bytes+(asset->>'size')::bigint;
      IF total_bytes>20000000 THEN RAISE EXCEPTION 'Workflow email attachments exceed the total limit' USING ERRCODE='22023'; END IF;
    END LOOP;
    FOR file_ref IN SELECT value FROM jsonb_array_elements(coalesce(content->'files','[]'::jsonb)) LOOP
      IF NOT EXISTS(SELECT 1 FROM public.resignation_journey_file f WHERE f.tenant_id=t AND f.case_id=p_subject
        AND f.id::text=file_ref->>'storageId' AND f.id::text=file_ref->>'id' AND f.name=file_ref->>'name' AND f.content_hash=file_ref->>'contentHash')
      THEN RAISE EXCEPTION 'A required case file is unavailable' USING ERRCODE='22023'; END IF;
      total_bytes:=total_bytes+(SELECT octet_length(f.content) FROM public.resignation_journey_file f WHERE f.tenant_id=t AND f.case_id=p_subject AND f.id::text=file_ref->>'id');
      IF total_bytes>20000000 THEN RAISE EXCEPTION 'Workflow email attachments exceed the total limit' USING ERRCODE='22023'; END IF;
    END LOOP;
  END IF;
  WITH input AS (
    SELECT DISTINCT ON(x.id) x.id,x.n,x.list FROM (
      SELECT id,n,1 AS list FROM unnest(p_to) WITH ORDINALITY a(id,n)
      UNION ALL SELECT id,n,2 AS list FROM unnest(coalesce(p_cc,'{}'::uuid[])) WITH ORDINALITY b(id,n)) x
    WHERE x.id IS NOT NULL ORDER BY x.id,x.list,x.n
  ), checked AS (
    SELECT i.*,EXISTS(SELECT 1 FROM public.app_user u JOIN public.app_external_identity identity ON identity.app_user_id=u.id
      AND identity.revoked_at IS NULL AND identity.issuer LIKE '%/auth/'||t::text
      WHERE u.id=i.id AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AS reachable FROM input i
  ) SELECT coalesce(array_agg(id ORDER BY n) FILTER(WHERE reachable AND list=1),'{}'),
      coalesce(array_agg(id ORDER BY n) FILTER(WHERE reachable AND list=2),'{}'),
      coalesce(array_agg(id ORDER BY list,n) FILTER(WHERE NOT reachable),'{}') INTO to_ids,cc_ids,unreachable FROM checked;
  -- Do not silently promote CC to To when the intended recipient cannot be addressed.
  IF cardinality(to_ids)>0 THEN
    WITH inserted AS (
      INSERT INTO public.automation_email_delivery(tenant_id,module,subject_id,mail_key,payload,created_by)
      SELECT t,'off',p_subject,p_key||':'||g::text,jsonb_build_object('version',1,'module','off','subjectId',p_subject,
        'linkPath','/lifecycle/resignations/'||p_subject::text,'content',content,
        'mail',jsonb_build_object('id',p_key||':'||g::text,'to',to_jsonb(to_ids[g*8+1:g*8+8]),
          'cc',CASE WHEN g=0 THEN to_jsonb(cc_ids) ELSE '[]'::jsonb END,'subject',p_subject_line,'body',coalesce(p_body,''),
          'delivery',jsonb_build_object('version',1,'sender','noreply'))),app.current_user_id()
      FROM generate_series(0,(cardinality(to_ids)-1)/8) g ON CONFLICT(tenant_id,mail_key) DO NOTHING RETURNING 1
    ) SELECT count(*) INTO queued FROM inserted;
  END IF;
  IF queued>0 THEN
    INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
    VALUES(t,'automation-email',p_subject,'automation.email-queued',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,
      app.current_user_id(),j.employment_id,jsonb_build_object('module','off','subjectId',p_subject,'key',p_key,'messages',queued,
        'recipients',cardinality(to_ids)+cardinality(cc_ids),'withoutEmail',cardinality(unreachable)));
  END IF;
  RETURN jsonb_build_object('queued',queued,'to',to_jsonb(to_ids),'cc',to_jsonb(cc_ids),'unreachable',to_jsonb(unreachable));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_email_queue(uuid,text,uuid[],uuid[],text,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resignation_email_queue(uuid,text,uuid[],uuid[],text,text,jsonb) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_target(p_id uuid, p_token uuid, p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module = 'off' AND NOT EXISTS(SELECT 1 FROM public.resignation_journey j WHERE j.id=job.subject_id AND j.tenant_id=job.tenant_id) THEN RETURN NULL; END IF;
  recipients := coalesce(job.payload->'mail'->'to', '[]'::jsonb) || coalesce(job.payload->'mail'->'cc', '[]'::jsonb);
  SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
  SELECT jsonb_agg(jsonb_build_object('userId', r.uid, 'subject', identity.subject, 'issuer', identity.issuer) ORDER BY r.ordinality)
    INTO bindings
    FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid, ordinality)
    JOIN public.app_user u ON u.id::text = r.uid AND u.tenant_id = job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.issuer = p_origin || '/auth/' || job.tenant_id::text AND identity.revoked_at IS NULL;
  bindings := coalesce(bindings, '[]'::jsonb);
  IF total < 1 OR jsonb_array_length(bindings) <> total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b) <> total THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', job.id, 'tenantId', job.tenant_id, 'module', job.module, 'subjectId', job.subject_id, 'payload', job.payload, 'bindings', bindings);
END $$;

--> statement-breakpoint
CREATE FUNCTION app.resignation_email_files(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
  target:=app.automation_email_target(p_id,p_token,p_origin);
  IF target IS NULL OR target->>'module'<>'off' THEN RETURN; END IF;
  RETURN QUERY SELECT f.id,f.name,f.mime_type,encode(f.content,'base64'),f.content_hash
    FROM jsonb_array_elements(coalesce(target->'payload'->'content'->'files','[]'::jsonb)) frozen
    JOIN public.resignation_journey_file f ON f.tenant_id=(target->>'tenantId')::uuid AND f.case_id=(target->>'subjectId')::uuid
      AND f.id::text=frozen->>'id' AND f.id::text=frozen->>'storageId' AND f.name=frozen->>'name' AND f.content_hash=frozen->>'contentHash';
END $$;
--> statement-breakpoint
CREATE FUNCTION app.resignation_email_assets(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,kind text,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
  target:=app.automation_email_target(p_id,p_token,p_origin);
  IF target IS NULL OR target->>'module'<>'off' THEN RETURN; END IF;
  RETURN QUERY SELECT f.id,f.kind,f.filename,f.mime_type,encode(f.content,'base64'),f.content_hash
    FROM jsonb_array_elements(coalesce(target->'payload'->'content'->'assets','[]'::jsonb)) frozen
    JOIN public.lc_v9_email_asset f ON f.tenant_id=(target->>'tenantId')::uuid AND f.id::text=frozen->>'id'
      AND f.email_template_id=target->'payload'->'content'->>'emailTemplateId' AND f.kind=frozen->>'kind'
      AND f.filename=frozen->>'name' AND f.mime_type=frozen->>'mimeType' AND f.content_hash=frozen->>'contentHash';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_email_files(uuid,uuid,text),app.resignation_email_assets(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resignation_email_files(uuid,uuid,text),app.resignation_email_assets(uuid,uuid,text) TO ai_hr_app;
