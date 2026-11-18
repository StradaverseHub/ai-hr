-- Any frozen template-route holder may return a document with a reason. The return immediately invalidates
-- earlier decisions/signatures in the current round while preserving the complete immutable action audit.
CREATE OR REPLACE FUNCTION app.document_signing_round_actions(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH history AS (
  SELECT a,n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'actions')='array' THEN p_data->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY x(a,n)
  WHERE a->>'contentRevision'=p_data->>'contentRevision' AND a->>'contentHash'=p_data->>'contentHash'
 )
 SELECT a FROM history WHERE n>coalesce((SELECT max(n) FROM history WHERE a->>'action'='resent'),0)
  AND (jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'object' OR n>=coalesce((SELECT max(n) FROM history WHERE a->>'action'='returned'),0)) ORDER BY n
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_act(p_id uuid,p_action jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;step jsonb;prior jsonb;stage integer;v_action jsonb;v_name text;v_person uuid;new_data jsonb;content jsonb;route_allowed boolean;coverage jsonb;routed boolean;v_kind text;v_owner uuid;
BEGIN
 -- All subject writers lock the source part before the signing document.
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR to_regprocedure('app.probation_signing_content(uuid)') IS NULL OR to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'Signing subject unavailable'; END IF;
 EXECUTE 'SELECT app.probation_signing_content($1)' INTO content USING d.subject_id;
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.document_signing_subject_access(d.subject_type,d.subject_id,CASE WHEN p_action->>'action'='declined' THEN 'decline' ELSE 'sign' END) THEN RAISE EXCEPTION 'Signing action not permitted'; END IF;
 IF jsonb_typeof(p_action) IS DISTINCT FROM 'object' OR jsonb_typeof(p_action->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'stepId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_action->'contentRevision') IS DISTINCT FROM 'number' OR coalesce(p_action->>'id','')='' OR coalesce(p_action->>'stepId','')='' OR length(p_action->>'id')>200 OR jsonb_typeof(p_action->'comment') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing action shape'; END IF;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM d.company_id::text OR content->>'employmentId' IS DISTINCT FROM d.employment_id::text OR content->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM d.data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO route_allowed USING d.subject_id,d.data->'route';
 IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'Current signing holders changed'; END IF;
 SELECT person_id INTO v_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
 IF v_person IS NULL OR p_action->>'actorPersonId' IS DISTINCT FROM v_person::text THEN RAISE EXCEPTION 'Verified signer person changed'; END IF;
 IF p_action->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR p_action->>'contentHash' IS DISTINCT FROM d.data->>'contentHash' OR p_action->'contentRevision' IS DISTINCT FROM d.data->'contentRevision' THEN RAISE EXCEPTION 'Signer or document revision changed'; END IF;
 SELECT a INTO prior FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'id'=p_action->>'id';
 IF prior IS NOT NULL THEN
  IF (prior-'at'-'actorName')=(p_action-'at'-'actorName') THEN RETURN d.data; END IF;
  RAISE EXCEPTION 'Signing action reference already used';
 END IF;
 routed:=coalesce(jsonb_typeof(d.data->'routing')='object',false);
 v_kind:=coalesce(p_action->>'action','');
 IF v_kind='resent' THEN
  -- The owner sends a returned template-routing document round again unchanged.
  v_owner:=app.document_signing_owner(d.data);
  IF NOT routed OR NOT app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'Only a document that was sent back can be sent round again'; END IF;
  IF v_owner IS NULL OR v_owner<>app.current_user_id() THEN RAISE EXCEPTION 'Only the owner of the document can send it round again'; END IF;
  IF p_action->>'role' IS DISTINCT FROM 'owner' OR p_action->>'representedId' IS DISTINCT FROM app.current_user_id()::text OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR p_action ? 'coveredStepIds'
  OR p_action->>'stepId' IS DISTINCT FROM coalesce(app.document_signing_owner_step(d.data)->>'id','owner')
  THEN RAISE EXCEPTION 'Invalid re-send'; END IF;
  coverage:='[]'::jsonb;
  step:=jsonb_build_object('id',p_action->>'stepId');
 ELSE
  IF app.document_signing_returned(d.data) THEN RAISE EXCEPTION 'The document was sent back to its owner'; END IF;
  SELECT min((s->>'stage')::integer) INTO stage FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(d.data,s);
  IF routed AND v_kind='returned' THEN
   SELECT s INTO step FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'id'=p_action->>'stepId';
  ELSE
   SELECT s INTO step FROM app.document_signing_pending_steps(d.data) s WHERE s->>'id'=p_action->>'stepId';
  END IF;
  IF step IS NULL OR (v_kind<>'declined' AND step->>'holderId' IS DISTINCT FROM app.current_user_id()::text) OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned pending signer may act'; END IF;
  IF NOT(routed AND v_kind='returned') AND app.document_signing_step_fulfilled(d.data,step) THEN RAISE EXCEPTION 'Signature already recorded'; END IF;
  coverage:=CASE WHEN v_kind='signed' THEN coalesce(step->'coveredStepIds','[]') ELSE '[]'::jsonb END;
  IF coalesce(p_action->'coveredStepIds','[]') IS DISTINCT FROM coverage THEN RAISE EXCEPTION 'The signature role coverage differs from the authoritative pending route';END IF;
  IF v_kind='declined' THEN
   IF step->>'kind'<>'acknowledge' OR step->>'holderPersonId'=v_person::text OR btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An independent recorded refusal confirmation is required'; END IF;
  ELSIF v_kind='returned' THEN
   IF btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A return reason is required'; END IF;
  ELSIF v_kind IN ('reviewed','approved') THEN
   -- Review, and Approve on a template-routing document, are decisions without a signature.
   IF p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR v_kind='reviewed' AND step->>'kind'<>'review' OR v_kind='approved' AND (step->>'kind'<>'approve' OR NOT (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb)) THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
  ELSIF v_kind='signed' THEN
   IF step->>'kind'='review' OR (routed OR step->'signature' IS NOT DISTINCT FROM 'false'::jsonb) AND step->>'kind'='approve' THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
   IF app.document_signature_valid(p_action->'signature') IS NOT TRUE THEN RAISE EXCEPTION 'A valid signature and consent are required';END IF;
  ELSE RAISE EXCEPTION 'Invalid signing action'; END IF;
  IF v_kind IN ('signed','approved') AND step->>'kind'='approve' AND d.guardrails->>'independentApprovalFromRole' IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'role'=d.guardrails->>'independentApprovalFromRole' AND a->>'action'='signed' AND a->>'actorPersonId'=v_person::text AND a->>'contentRevision'=d.data->>'contentRevision' AND a->>'contentHash'=d.data->>'contentHash') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'route'->'steps') other_step WHERE other_step->>'kind'='approve' AND other_step->>'required'='true' AND other_step->>'holderPersonId'<>v_person::text) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
 -- A subject owner must validate action payloads as well as the shared route and actor.
 -- In particular, an employee acknowledgement cannot replace the saved review comment.
 IF d.subject_type='probation' THEN
  IF to_regprocedure('app.probation_signing_action_allowed(uuid,jsonb)') IS NULL THEN RAISE EXCEPTION 'Signing subject action policy unavailable';END IF;
  EXECUTE 'SELECT app.probation_signing_action_allowed($1,$2)' INTO route_allowed USING d.subject_id,p_action;
  IF route_allowed IS NOT TRUE THEN RAISE EXCEPTION 'The current subject does not permit this signing action';END IF;
 END IF;
 SELECT p.full_name INTO v_name FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id();
 IF v_name IS NULL THEN RAISE EXCEPTION 'Verified signer name is missing'; END IF;
 v_action:=(p_action-'coveredStepIds')||CASE WHEN jsonb_array_length(coverage)>0 THEN jsonb_build_object('coveredStepIds',coverage) ELSE '{}'::jsonb END||jsonb_build_object('actorName',v_name,'actorPersonId',v_person,'at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 new_data:=jsonb_set(d.data,'{actions}',(d.data->'actions')||jsonb_build_array(v_action));
 UPDATE document_signing_document SET data=new_data,revision=revision+1,updated_at=now() WHERE id=d.id;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,reason) VALUES(d.id,d.tenant_id,d.revision+1,new_data,app.current_user_id(),CASE v_kind WHEN 'resent' THEN 'Sent the document round again' ELSE 'Recorded signing action' END);
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(d.tenant_id,'document-signing',d.id,CASE v_kind WHEN 'signed' THEN 'document-signing.signed' WHEN 'declined' THEN 'document-signing.acknowledgement-declined' WHEN 'reviewed' THEN 'document-signing.reviewed' WHEN 'approved' THEN 'document-signing.approved' WHEN 'resent' THEN 'document-signing.resent' ELSE 'document-signing.returned' END,'user',app.current_user_id(),d.employment_id,jsonb_build_object('documentId',d.id,'revision',d.revision+1,'stepId',step->>'id'));
 RETURN new_data;
END $$;
