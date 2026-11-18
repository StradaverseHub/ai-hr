-- Preserve the public start OID. Its former implementation remains private and cannot bypass this guard.
DO $$DECLARE source text;BEGIN
 source:=pg_get_functiondef('app.automation_email_start(uuid,uuid,text,jsonb)'::regprocedure);
 source:=replace(source,'FUNCTION app.automation_email_start(', 'FUNCTION app.automation_email_start_before_materialization(');
 EXECUTE source;
END $$;
REVOKE ALL ON FUNCTION app.automation_email_start_before_materialization(uuid,uuid,text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Metadata only, private to the sender. Existing native receipt and personal-document owners authorize every row.
CREATE FUNCTION app.automation_email_materialization(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;assets jsonb;docs jsonb;versions jsonb;item jsonb;readiness jsonb;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);IF target IS NULL OR target->>'module'='off' THEN RETURN NULL;END IF;
 assets:=coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb);docs:=coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb);
 IF jsonb_typeof(assets) IS DISTINCT FROM 'array' OR jsonb_typeof(docs) IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 IF (SELECT count(*) FROM app.automation_email_assets(p_id,p_token,p_origin))<>jsonb_array_length(assets) THEN RETURN NULL;END IF;
 IF app.automation_email_documents(p_id,p_token,p_origin) IS DISTINCT FROM docs THEN RETURN NULL;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(docs) LOOP
  IF to_regprocedure('app.contract_shared_email_document_readiness(uuid)') IS NULL THEN RETURN NULL;END IF;
  EXECUTE 'select app.contract_shared_email_document_readiness($1)' INTO readiness USING (item->>'id')::uuid;
  IF readiness->'ready' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL;END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'revision',l.data->>'contentRevision','subjectPersonId',l.data->>'subjectPersonId',
  'letterHash',encode(sha256(convert_to(l.data::text,'UTF8')),'hex'),'signingHash',encode(sha256(convert_to(s.data::text,'UTF8')),'hex')) ORDER BY l.id),'[]'::jsonb) INTO versions
 FROM jsonb_array_elements(docs) ref JOIN public.contract_shared_letter l ON l.tenant_id=(target->>'tenantId')::uuid AND l.id=(ref->>'id')::uuid
 JOIN public.document_signing_document s ON s.tenant_id=l.tenant_id AND s.id=l.signing_document_id;
 IF jsonb_array_length(versions)<>jsonb_array_length(docs) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('version',1,'id',p_id,'template',target->'payload'->'mail'->'richBody'->'sourceTemplate','assets',assets,'documents',docs,'documentVersions',versions,'bindings',target->'bindings');
END $$;
REVOKE ALL ON FUNCTION app.automation_email_materialization(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_start(p_id uuid,p_token uuid,p_origin text,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;expected jsonb;docs jsonb;letter_id uuid;
BEGIN
 target:=app.automation_email_target(p_id,p_token,p_origin);IF target IS NULL THEN RETURN false;END IF;
 IF target->>'module'<>'off' AND (jsonb_array_length(coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb))>0 OR jsonb_array_length(coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb))>0) THEN
  -- Same source-first order as canonical Contract document writers; no business state is changed.
  IF target->>'module'='contract_staff' THEN
   PERFORM 1 FROM public.employment e JOIN public.contract_case c ON c.tenant_id=e.tenant_id AND c.employment_id=e.id WHERE c.tenant_id=(target->>'tenantId')::uuid AND c.id=(target->>'subjectId')::uuid FOR SHARE OF e;
   docs:=coalesce(target->'payload'->'mail'->'delivery'->'documents','[]'::jsonb);
   FOR letter_id IN SELECT (value->>'id')::uuid FROM jsonb_array_elements(docs) ORDER BY value->>'id' LOOP
    IF to_regprocedure('app.contract_shared_email_document_lock(uuid)') IS NOT NULL THEN
     EXECUTE 'select app.contract_shared_email_document_lock($1)' USING letter_id;
    ELSE
     PERFORM 1 FROM public.contract_shared_letter l WHERE l.tenant_id=(target->>'tenantId')::uuid AND l.id=letter_id FOR UPDATE;
     PERFORM 1 FROM public.document_signing_document s JOIN public.contract_shared_letter l ON l.tenant_id=s.tenant_id AND l.signing_document_id=s.id WHERE l.tenant_id=(target->>'tenantId')::uuid AND l.id=letter_id FOR UPDATE OF s;
    END IF;
   END LOOP;
  END IF;
  PERFORM 1 FROM public.automation_email_delivery WHERE id=p_id AND lease_token=p_token FOR UPDATE;
  expected:=app.automation_email_materialization(p_id,p_token,p_origin);
  IF expected IS NULL OR p_proof->'sharedMaterialization' IS DISTINCT FROM expected THEN RETURN false;END IF;
 END IF;
 RETURN app.automation_email_start_before_materialization(p_id,p_token,p_origin,p_proof);
END $$;
REVOKE ALL ON FUNCTION app.automation_email_start(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_start(uuid,uuid,text,jsonb) TO ai_hr_app;
