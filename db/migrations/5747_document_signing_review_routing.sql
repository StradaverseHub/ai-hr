-- Document signing: Review steps, the document owner, send back and re-send, the edit lock and content visibility
-- (ADR docs/adr/2026-11-15-probation-shared-automation.md, build step 3; handoff A2; lib/document-signing-model.ts).
-- Tag 5747 / idx 5147 / when 1793330005447 on the board offset (tag T, idx T - 600, when 1793330004800 + (T - 5100)),
-- assigned by the Probation Confirmation build lead for lane D1.
--
-- Storage does not change: document_signing_document.data already holds the route and the append-only action history.
-- This migration replaces four ai_hr_owner functions of migration 0948 in place (same signatures, owners and grants) and
-- adds read-only helpers:
--  * Step kind `review`; at most one step flagged `owner`; an optional `meantFor` note; optional document `routing`.
--  * Actions `reviewed` (Review step) and `approved` (Approve step of a template-routing document) are decisions without a
--    signature; `resent` lets the owner send a returned document round again unchanged.
--  * Rounds: only actions of the current content after its latest `resent` count. A `returned` action in the current
--    round holds the document with its owner, so a send-back clears every completed step, signatures included, without
--    removing history. A document without `resent` actions behaves exactly as before.
--  * A document carrying `routing` (generated from a template version with a non-empty routing) may be revised only by
--    its owner or the pending Review step, never after the first signature of the round, and its route and routing
--    metadata never change on revision.
-- Existing documents never carry `routing`, `review` steps or the new actions, so their behaviour is unchanged. The
-- Probation subject adapter (app.probation_signing_*) is not changed here; it still refuses every action after a return.
-- No table, row, grant or purpose-owned object changes.
CREATE FUNCTION app.document_signing_round_actions(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH history AS (
  SELECT a, n FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'actions')='array' THEN p_data->'actions' ELSE '[]'::jsonb END) WITH ORDINALITY x(a,n)
  WHERE a->>'contentRevision'=p_data->>'contentRevision' AND a->>'contentHash'=p_data->>'contentHash'
 )
 SELECT a FROM history WHERE n>coalesce((SELECT max(n) FROM history WHERE a->>'action'='resent'),0) ORDER BY n
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_step_fulfilled(p_document jsonb,p_step jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_signing_round_actions(p_document) action
  WHERE action->>'action'='signed' AND (action->>'stepId'=p_step->>'id' OR coalesce(action->'coveredStepIds','[]')?(p_step->>'id'))
   OR action->>'action'='declined' AND p_step->>'kind'='acknowledge' AND action->>'stepId'=p_step->>'id'
   OR action->>'action'='reviewed' AND p_step->>'kind'='review' AND action->>'stepId'=p_step->>'id'
   OR action->>'action'='approved' AND p_step->>'kind'='approve' AND action->>'stepId'=p_step->>'id')
$$;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_returned(p_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.document_signing_round_actions(p_data) a WHERE a->>'action'='returned')
$$;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_locked(p_data jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT app.document_signing_returned(p_data) AND EXISTS(SELECT 1 FROM app.document_signing_round_actions(p_data) a WHERE a->>'action'='signed')
$$;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_pending_steps(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH steps AS (
  SELECT s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'route'->'steps')='array' THEN p_data->'route'->'steps' ELSE '[]'::jsonb END) s
  WHERE s->>'required'='true' AND NOT app.document_signing_step_fulfilled(p_data,s)
 )
 SELECT s FROM steps
 WHERE NOT app.document_signing_returned(p_data) AND s->>'coveredByStepId' IS NULL
  AND (s->>'stage')::integer=(SELECT min((t.s->>'stage')::integer) FROM steps t)
$$;
--> statement-breakpoint
-- The flagged owner step, or with none flagged the first Review step (lowest stage, then route order), or NULL.
CREATE FUNCTION app.document_signing_owner_step(p_data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT x FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'route'->'steps')='array' THEN p_data->'route'->'steps' ELSE '[]'::jsonb END) WITH ORDINALITY y(x,n)
 WHERE x->'owner'='true'::jsonb OR x->>'kind'='review'
 ORDER BY coalesce(x->'owner'='true'::jsonb,false) DESC,(x->>'stage')::integer,n LIMIT 1
$$;
--> statement-breakpoint
-- The owner: that step's holder (none when the step has no holder); with no such step the case owner the subject
-- adapter froze into `routing`.
CREATE FUNCTION app.document_signing_owner(p_data jsonb) RETURNS uuid
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s jsonb:=app.document_signing_owner_step(p_data);
BEGIN
 IF s IS NOT NULL THEN RETURN nullif(s->>'holderId','')::uuid; END IF;
 IF jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 RETURN nullif(p_data->'routing'->>'caseOwnerId','')::uuid;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.document_signing_can_edit(p_data jsonb,p_user uuid) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_typeof(p_data->'routing')='object' AND p_user IS NOT NULL AND CASE
  WHEN app.document_signing_returned(p_data) THEN app.document_signing_owner(p_data)=p_user
  WHEN app.document_signing_locked(p_data) OR NOT EXISTS(SELECT 1 FROM app.document_signing_pending_steps(p_data)) THEN false
  ELSE app.document_signing_owner(p_data)=p_user OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(p_data) s WHERE s->>'kind'='review' AND s->>'holderId'=p_user::text)
 END,false)
$$;
--> statement-breakpoint
-- Readers ask this before showing content. Everyone with read access to the subject sees the routing and status.
-- `p_released` is the subject's fact (for Probation: the letter was released).
CREATE FUNCTION app.document_signing_content_visible(p_id uuid,p_released boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d document_signing_document;u uuid:=app.current_user_id();
BEGIN
 SELECT * INTO d FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.document_signing_subject_access(d.subject_type,d.subject_id,'read') IS NOT TRUE THEN RETURN false; END IF;
 IF jsonb_typeof(d.data->'routing') IS DISTINCT FROM 'object' OR p_released IS TRUE THEN RETURN true; END IF;
 IF u IS NULL THEN RETURN false; END IF;
 RETURN coalesce(app.document_signing_owner(d.data)=u,false)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') a WHERE a->>'actorId'=u::text)
  OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data) s WHERE s->>'holderId'=u::text);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.document_signing_round_actions(jsonb),app.document_signing_returned(jsonb),app.document_signing_locked(jsonb),app.document_signing_pending_steps(jsonb),app.document_signing_owner_step(jsonb),app.document_signing_owner(jsonb),app.document_signing_can_edit(jsonb,uuid),app.document_signing_content_visible(uuid,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.document_signing_round_actions(jsonb),app.document_signing_returned(jsonb),app.document_signing_locked(jsonb),app.document_signing_pending_steps(jsonb),app.document_signing_owner_step(jsonb),app.document_signing_owner(jsonb),app.document_signing_can_edit(jsonb,uuid),app.document_signing_content_visible(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_validate(p_data jsonb,p_rules jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE step jsonb;covered jsonb;target jsonb;role text;manager uuid;
BEGIN
 IF jsonb_typeof(p_data->'route'->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(p_data->'route'->'steps') NOT BETWEEN 1 AND 30
 OR jsonb_typeof(p_data->'actions') IS DISTINCT FROM 'array' OR jsonb_typeof(p_rules->'requiredRoles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid signing route'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_data->'route'->'steps'))<>(SELECT count(DISTINCT s->>'id') FROM jsonb_array_elements(p_data->'route'->'steps') s) THEN RAISE EXCEPTION 'Duplicate signing steps'; END IF;
 IF p_data ? 'routing' THEN
  IF jsonb_typeof(p_data->'routing') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
  IF jsonb_typeof(p_data->'routing'->'templateId') IS DISTINCT FROM 'string' OR jsonb_typeof(p_data->'routing'->'templateVersion') IS DISTINCT FROM 'number'
  OR jsonb_typeof(p_data->'routing'->'caseOwnerId') NOT IN ('string','null') THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
  IF p_data->'routing'->>'caseOwnerId' IS NOT NULL AND p_data->'routing'->>'caseOwnerId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid template routing'; END IF;
 END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->'owner'='true'::jsonb)>1 THEN RAISE EXCEPTION 'Only one step can own the document'; END IF;
 FOR step IN SELECT * FROM jsonb_array_elements(p_data->'route'->'steps') LOOP
  IF coalesce(step->>'id','')='' OR coalesce(step->>'role','')='' OR coalesce(step->>'kind','') NOT IN ('sign','acknowledge','approve','review') OR jsonb_typeof(step->'stage') IS DISTINCT FROM 'number' OR (step->>'stage')::integer<0 OR jsonb_typeof(step->'required') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid signing step'; END IF;
  IF step ? 'owner' AND jsonb_typeof(step->'owner') IS DISTINCT FROM 'boolean' OR step ? 'meantFor' AND jsonb_typeof(step->'meantFor') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid signing step'; END IF;
  IF step->>'holderId' IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(coalesce(p_data->'actions','[]')) prior
  WHERE (prior->>'stepId'=step->>'id' OR coalesce(prior->'coveredStepIds','[]')?(step->>'id')) AND prior->>'action' IN('signed','declined','reviewed','approved')
   AND prior->>'contentRevision'=p_data->>'contentRevision' AND prior->>'contentHash'=p_data->>'contentHash'
   AND (prior->>'actorId'=step->>'holderId' AND prior->>'actorPersonId'=step->>'holderPersonId' OR prior->>'action'='declined' AND step->>'kind'='acknowledge' AND prior->>'representedId'=coalesce(step->>'representedId',step->>'holderId'))
 ) AND NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=(step->>'holderId')::uuid AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND u.person_id IS NOT NULL AND step->>'holderPersonId'=u.person_id::text AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Invalid signer'; END IF;
  covered:=coalesce(step->'coveredStepIds','[]');
  IF jsonb_typeof(covered) IS DISTINCT FROM 'array' OR jsonb_array_length(covered)>1 OR jsonb_array_length(covered)>0 AND step->>'coveredByStepId' IS NOT NULL THEN RAISE EXCEPTION 'Invalid combined approval coverage';END IF;
  IF step->>'coveredByStepId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') owner WHERE owner->>'id'=step->>'coveredByStepId' AND coalesce(owner->'coveredStepIds','[]')?(step->>'id')) THEN RAISE EXCEPTION 'Covered approval has no signing step';END IF;
  IF jsonb_array_length(covered)=1 THEN
   SELECT value INTO target FROM jsonb_array_elements(p_data->'route'->'steps') WHERE value->>'id'=covered->>0;
   IF target IS NULL OR target->>'coveredByStepId' IS DISTINCT FROM step->>'id' OR step->>'kind'<>'approve' OR target->>'kind'<>'approve' OR step->>'role'=target->>'role'
    OR step->>'required'<>'true' OR target->>'required'<>'true' OR step->>'holderId' IS NULL OR target->>'holderId' IS DISTINCT FROM step->>'holderId'
    OR step->>'holderPersonId' IS NULL OR target->>'holderPersonId' IS DISTINCT FROM step->>'holderPersonId' OR (step->>'stage')::integer>=(target->>'stage')::integer
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') intervening WHERE intervening->>'required'='true' AND intervening->>'id' NOT IN(step->>'id',target->>'id') AND (intervening->>'stage')::integer BETWEEN (step->>'stage')::integer AND (target->>'stage')::integer)
   THEN RAISE EXCEPTION 'One verified signature can cover only adjacent approval roles held by the same actual person';END IF;
  END IF;
 END LOOP;
 FOR role IN SELECT jsonb_array_elements_text(p_rules->'requiredRoles') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=role AND s->>'required'='true') THEN RAISE EXCEPTION 'Required signing role cannot be removed'; END IF;
 END LOOP;
 IF p_rules->>'independentApprovalFromRole' IS NOT NULL THEN
  SELECT (s->>'holderPersonId')::uuid INTO manager FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'role'=p_rules->>'independentApprovalFromRole' AND s->>'required'='true' LIMIT 1;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') s WHERE s->>'kind'='approve' AND s->>'required'='true' AND s->>'role'<>p_rules->>'independentApprovalFromRole' AND (s->>'holderId' IS NULL OR manager IS NULL OR (s->>'holderPersonId')::uuid<>manager)) THEN RAISE EXCEPTION 'A distinct approving person is required'; END IF;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_store(p_id uuid,p_employment uuid,p_company uuid,p_subject uuid,p_data jsonb,p_rules jsonb,p_expected integer,p_operation text,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old document_signing_document;new_revision integer;expected_rules jsonb;route_allowed boolean;content jsonb;resolved_route jsonb;actor uuid:=app.current_user_id();
BEGIN
 IF coalesce(p_operation,'') NOT IN ('create','revise','reroute','canonical_refresh') OR NOT app.document_signing_subject_access('probation',p_subject,p_operation) THEN RAISE EXCEPTION 'Signing operation not permitted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND company_id=p_company) THEN RAISE EXCEPTION 'Invalid signing subject'; END IF;
 IF p_data->>'tenantId' IS DISTINCT FROM app.current_tenant_id()::text OR p_data->>'companyId' IS DISTINCT FROM p_company::text OR p_data->>'subjectId' IS DISTINCT FROM p_subject::text OR p_data->>'subjectType' IS DISTINCT FROM 'probation' THEN RAISE EXCEPTION 'Signing subject mismatch'; END IF;
 IF to_regprocedure('app.probation_signing_guardrails(uuid)') IS NULL OR to_regprocedure('app.probation_signing_route_allowed(uuid,jsonb)') IS NULL OR to_regprocedure('app.probation_signing_content(uuid)') IS NULL THEN RAISE EXCEPTION 'Signing subject adapter is unavailable'; END IF;
 EXECUTE 'SELECT app.probation_signing_content($1)' INTO content USING p_subject;
 IF content IS NULL OR content->>'companyId' IS DISTINCT FROM p_company::text OR content->>'employmentId' IS DISTINCT FROM p_employment::text OR content->>'contentHash' IS DISTINCT FROM p_data->>'contentHash' OR content->>'contentRevision' IS DISTINCT FROM p_data->>'contentRevision' THEN RAISE EXCEPTION 'Signing content changed'; END IF;
 EXECUTE 'SELECT app.probation_signing_guardrails($1)' INTO expected_rules USING p_subject;
 EXECUTE 'SELECT app.probation_signing_route_allowed($1,$2)' INTO route_allowed USING p_subject,p_data->'route';
 IF expected_rules IS NULL OR expected_rules<>p_rules OR NOT coalesce(route_allowed,false) THEN RAISE EXCEPTION 'Signing subject policy or current route changed'; END IF;
 IF coalesce(p_data->>'contentHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_data->'contentRevision') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid content fingerprint or revision'; END IF;
 PERFORM app.document_signing_validate(p_data,p_rules);
 SELECT * INTO old FROM document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF p_operation='create' THEN
  IF FOUND OR p_expected IS DISTINCT FROM 0 OR p_data->'actions' IS DISTINCT FROM '[]'::jsonb OR p_data->>'contentRevision' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Invalid initial signing revision'; END IF;
  INSERT INTO document_signing_document(id,tenant_id,company_id,employment_id,subject_type,subject_id,data,guardrails) VALUES(p_id,app.current_tenant_id(),p_company,p_employment,'probation',p_subject,p_data,p_rules);
  new_revision:=1;
 ELSE
  IF NOT FOUND OR old.subject_id<>p_subject OR old.employment_id<>p_employment OR old.company_id<>p_company OR old.revision IS DISTINCT FROM p_expected OR old.guardrails<>p_rules OR btrim(coalesce(p_reason,''))='' THEN RAISE EXCEPTION 'Signing revision changed or reason missing'; END IF;
  IF p_data->'actions' IS DISTINCT FROM old.data->'actions' THEN RAISE EXCEPTION 'Signing history is immutable'; END IF;
  -- The template routing a document was generated with is frozen.
  IF p_data->'routing' IS DISTINCT FROM old.data->'routing' THEN RAISE EXCEPTION 'The template routing of a document cannot change'; END IF;
  IF p_operation='canonical_refresh' THEN
   IF to_regprocedure('app.probation_signing_refresh_route(uuid)') IS NULL THEN RAISE EXCEPTION 'Canonical refresh policy is unavailable';END IF;
   EXECUTE 'SELECT app.probation_signing_refresh_route($1)' INTO resolved_route USING p_subject;
   IF resolved_route IS NULL OR p_data->'route' IS DISTINCT FROM resolved_route OR (p_data-'route') IS DISTINCT FROM (old.data-'route') OR p_data->'route' IS NOT DISTINCT FROM old.data->'route' THEN
    RAISE EXCEPTION 'Canonical refresh may only adopt the exact current pending route';
   END IF;
  END IF;
  IF p_operation='revise' THEN
   IF (p_data->>'contentRevision')::integer<>(old.data->>'contentRevision')::integer+1 OR p_data->>'contentHash'=old.data->>'contentHash' THEN RAISE EXCEPTION 'Invalid content revision'; END IF;
   IF jsonb_typeof(old.data->'routing')='object' THEN
    IF NOT app.document_signing_can_edit(old.data,actor) THEN RAISE EXCEPTION 'The content is locked or it is not your turn to edit it'; END IF;
    IF p_data->'route' IS DISTINCT FROM old.data->'route' THEN RAISE EXCEPTION 'A routed document keeps the routing it was generated with'; END IF;
   END IF;
  ELSE
   IF p_data->>'contentRevision'<>old.data->>'contentRevision' OR p_data->>'contentHash'<>old.data->>'contentHash' THEN RAISE EXCEPTION 'Rerouting cannot change signed content'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') s WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'route'->'steps') n WHERE (n-CASE WHEN p_operation='canonical_refresh' THEN ARRAY['holderId','holderPersonId','representedId','coveredStepIds','coveredByStepId'] ELSE ARRAY['holderId','holderPersonId','representedId'] END)=(s-CASE WHEN p_operation='canonical_refresh' THEN ARRAY['holderId','holderPersonId','representedId','coveredStepIds','coveredByStepId'] ELSE ARRAY['holderId','holderPersonId','representedId'] END))) OR jsonb_array_length(p_data->'route'->'steps')<>jsonb_array_length(old.data->'route'->'steps') THEN RAISE EXCEPTION 'Rerouting cannot remove or change required steps'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(old.data->'route'->'steps') original
    JOIN jsonb_array_elements(p_data->'route'->'steps') proposed ON original->>'id'=proposed->>'id'
    WHERE app.document_signing_step_fulfilled(old.data,original) AND original<>proposed)
   THEN RAISE EXCEPTION 'Completed signatures cannot be reassigned'; END IF;
  END IF;
  new_revision:=old.revision+1;
  UPDATE document_signing_document SET data=p_data,revision=new_revision,updated_at=now() WHERE id=old.id;
 END IF;
 INSERT INTO document_signing_revision(document_id,tenant_id,revision,data,actor_user_id,actor_kind,reason) VALUES(p_id,app.current_tenant_id(),new_revision,p_data,actor,CASE WHEN actor IS NULL THEN 'system' ELSE 'user' END,coalesce(nullif(btrim(p_reason),''),'Created signing route'));
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload) VALUES(app.current_tenant_id(),'document-signing',p_id,CASE p_operation WHEN 'create' THEN 'document-signing.created' WHEN 'revise' THEN 'document-signing.revised' ELSE 'document-signing.rerouted' END,CASE WHEN actor IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,actor,p_employment,jsonb_build_object('documentId',p_id,'revision',new_revision,'operation',p_operation));
 RETURN p_id;
END $$;
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
  SELECT s INTO step FROM jsonb_array_elements(d.data->'route'->'steps') s WHERE s->>'id'=p_action->>'stepId' AND (s->>'stage')::integer=stage AND s->>'coveredByStepId' IS NULL;
  IF step IS NULL OR (v_kind<>'declined' AND step->>'holderId' IS DISTINCT FROM app.current_user_id()::text) OR p_action->>'role' IS DISTINCT FROM step->>'role' OR p_action->>'representedId' IS DISTINCT FROM coalesce(step->>'representedId',step->>'holderId') THEN RAISE EXCEPTION 'Only the assigned pending signer may act'; END IF;
  IF app.document_signing_step_fulfilled(d.data,step) THEN RAISE EXCEPTION 'Signature already recorded'; END IF;
  coverage:=CASE WHEN v_kind='signed' THEN coalesce(step->'coveredStepIds','[]') ELSE '[]'::jsonb END;
  IF coalesce(p_action->'coveredStepIds','[]') IS DISTINCT FROM coverage THEN RAISE EXCEPTION 'The signature role coverage differs from the authoritative pending route';END IF;
  IF v_kind='declined' THEN
   IF step->>'kind'<>'acknowledge' OR step->>'holderPersonId'=v_person::text OR btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'An independent recorded refusal confirmation is required'; END IF;
  ELSIF v_kind='returned' THEN
   IF btrim(coalesce(p_action->>'comment',''))='' OR p_action->'signature' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'A return reason is required'; END IF;
  ELSIF v_kind IN ('reviewed','approved') THEN
   -- Review, and Approve on a template-routing document, are decisions without a signature.
   IF p_action->'signature' IS DISTINCT FROM 'null'::jsonb OR v_kind='reviewed' AND step->>'kind'<>'review' OR v_kind='approved' AND (step->>'kind'<>'approve' OR NOT routed) THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
  ELSIF v_kind='signed' THEN
   IF step->>'kind'='review' OR routed AND step->>'kind'='approve' THEN RAISE EXCEPTION 'This step takes a different action'; END IF;
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
