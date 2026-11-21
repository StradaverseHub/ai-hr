-- Forward repair for 5820's PL/pgSQL FOUND-name collision. Earlier SQL and hashes remain unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_access_people(p_search text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.contract_shared_access_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Contract access administration is unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(matches) ORDER BY matches.name,matches.id),'[]'::jsonb) INTO result FROM(
  SELECT u.id,p.full_name AS name FROM public.app_user u JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND length(btrim(p.full_name))>0
   AND (coalesce(p_search,'')='' OR p.full_name ILIKE '%'||left(p_search,100)||'%') ORDER BY p.full_name,u.id LIMIT 50
 ) matches;
 RETURN result;
END $$;
--> statement-breakpoint
-- A public action caption comes from the canonical current step, not a guessed name or a client-selected role.
CREATE OR REPLACE FUNCTION app.contract_shared_letter_actions(p_letter uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;signing public.document_signing_document;can_bind boolean;pending_role text;
BEGIN
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter;
 SELECT * INTO signing FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id;
 can_bind:=app.contract_shared_letter_binding_actor(letter.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(signing.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'kind'='sign' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(signing.data,step));
 IF letter.data->>'state'='routing' AND app.contract_shared_decision_current(letter.case_id,letter.decision_revision) AND NOT app.document_signing_returned(signing.data) THEN
  SELECT CASE WHEN step->>'role'='employee' THEN 'employee' ELSE 'company' END INTO pending_role FROM app.document_signing_pending_steps(signing.data) step
  WHERE step->>'holderId'=app.current_user_id()::text AND step->>'holderPersonId'=app.contract_actor_person(app.current_user_id())::text AND step->>'kind'='sign'
  ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 END IF;
 RETURN jsonb_build_object('canBindEmployee',coalesce(can_bind,false),'pendingRole',pending_role);
END $$;
