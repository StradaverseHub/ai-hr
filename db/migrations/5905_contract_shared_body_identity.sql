-- A relinked login may retain Case View; that does not make it the original unreleased document actor.
-- Preserve the other subjects and released-letter visibility, and require both identities for Contract routing.
CREATE OR REPLACE FUNCTION app.document_signing_content_visible(p_id uuid,p_released boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.document_signing_document;u uuid:=app.current_user_id();v_person uuid;v_owner jsonb;
BEGIN
 SELECT * INTO d FROM public.document_signing_document WHERE id=p_id AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.document_signing_subject_access(d.subject_type,d.subject_id,'read') IS NOT TRUE THEN RETURN false;END IF;
 IF jsonb_typeof(d.data->'routing') IS DISTINCT FROM 'object' OR p_released IS TRUE THEN RETURN true;END IF;
 IF u IS NULL THEN RETURN false;END IF;
 IF d.subject_type='contract' THEN
  v_person:=app.contract_actor_person(u);
  IF v_person IS NULL THEN RETURN false;END IF;
  v_owner:=app.document_signing_owner_step(d.data);
  RETURN coalesce(v_owner->>'holderId'=u::text AND v_owner->>'holderPersonId'=v_person::text,false)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'actorId'=u::text AND action->>'actorPersonId'=v_person::text)
   OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data) step WHERE step->>'holderId'=u::text AND step->>'holderPersonId'=v_person::text);
 END IF;
 RETURN coalesce(app.document_signing_owner(d.data)=u,false)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'actorId'=u::text)
  OR EXISTS(SELECT 1 FROM app.document_signing_pending_steps(d.data) step WHERE step->>'holderId'=u::text);
END $$;
