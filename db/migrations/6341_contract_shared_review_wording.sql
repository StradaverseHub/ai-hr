-- Completing a review saves its case wording in the same service transaction as the canonical action.
-- This receipt binds retries of the original UI revision/patch to the resulting canonical content revision.
CREATE TABLE public.contract_shared_review_admission (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),letter_id uuid NOT NULL,action_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES public.app_user(id),actor_person_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=1064960),
 content_revision integer NOT NULL CHECK(content_revision>0),content_hash text NOT NULL CHECK(content_hash~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,letter_id,action_id),
 FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id)
);
REVOKE ALL ON public.contract_shared_review_admission FROM PUBLIC,ai_hr_app;
ALTER TABLE public.contract_shared_review_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_review_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_review_admission_owner ON public.contract_shared_review_admission TO ai_hr_owner USING(true) WITH CHECK(true);
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_review_prepare(p_letter uuid,p_step text,p_action_id uuid,p_action text,p_comment text,p_hash text,p_revision integer,p_blocks jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE letter public.contract_shared_letter;document public.document_signing_document;admission public.contract_shared_review_admission;actor_person uuid;
 command jsonb;receipt jsonb;prepared jsonb;fingerprint text;next_revision integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 actor_person:=app.contract_actor_person(app.current_user_id());
 IF actor_person IS NULL OR p_action NOT IN('reviewed','approved') OR jsonb_typeof(p_blocks) IS DISTINCT FROM 'object'
 OR octet_length(p_blocks::text)>1048576 OR length(coalesce(p_comment,''))>5000 THEN RAISE EXCEPTION 'Invalid review wording command' USING ERRCODE='22023';END IF;
 IF app.document_signing_subject_access('contract',p_letter,'read') IS NOT TRUE THEN RAISE EXCEPTION 'This letter is unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.contract_shared_lock_source((SELECT case_id FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter));
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND id=p_letter FOR UPDATE;
 SELECT * INTO document FROM public.document_signing_document WHERE tenant_id=letter.tenant_id AND id=letter.signing_document_id FOR UPDATE;
 command:=jsonb_build_object('stepId',p_step,'action',p_action,'comment',btrim(coalesce(p_comment,'')),'hash',p_hash,'revision',p_revision,'blocks',p_blocks);
 SELECT * INTO admission FROM public.contract_shared_review_admission WHERE tenant_id=letter.tenant_id AND letter_id=p_letter AND action_id=p_action_id;
 IF admission.action_id IS NOT NULL THEN
  IF admission.actor_user_id IS DISTINCT FROM app.current_user_id() OR admission.actor_person_id IS DISTINCT FROM actor_person OR admission.request IS DISTINCT FROM command
  THEN RAISE EXCEPTION 'Review command reference was already used' USING ERRCODE='40001';END IF;
  SELECT action INTO receipt FROM jsonb_array_elements(document.data->'actions') action WHERE action->>'id'=p_action_id::text;
  IF receipt IS NULL OR receipt->>'actorId' IS DISTINCT FROM app.current_user_id()::text OR receipt->>'actorPersonId' IS DISTINCT FROM actor_person::text
  OR receipt->>'contentRevision' IS DISTINCT FROM admission.content_revision::text OR receipt->>'contentHash' IS DISTINCT FROM admission.content_hash
  OR receipt->>'stepId' IS DISTINCT FROM p_step OR receipt->>'action' IS DISTINCT FROM p_action OR receipt->>'comment' IS DISTINCT FROM btrim(coalesce(p_comment,'')) OR receipt->'signature' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'The atomic review receipt is unavailable' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('duplicate',true,'signingDocumentId',document.id,'revision',admission.content_revision,'hash',admission.content_hash);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(document.data->'actions') action WHERE action->>'id'=p_action_id::text)
 THEN RAISE EXCEPTION 'Review command reference was already used' USING ERRCODE='40001';END IF;
 -- Existing edit authority, allowed block keys, signature lock and original content CAS remain authoritative.
 PERFORM app.contract_shared_letter_edit(p_letter,p_revision,p_hash,p_blocks);
 SELECT (data->>'contentRevision')::integer,encode(sha256(convert_to(app.contract_shared_letter_snapshot(id)::text,'UTF8')),'hex') INTO next_revision,fingerprint
 FROM public.contract_shared_letter WHERE tenant_id=letter.tenant_id AND id=p_letter;
 prepared:=app.contract_shared_letter_action_prepare(p_letter,p_step,p_action_id::text,p_action,btrim(coalesce(p_comment,'')),fingerprint,next_revision,'null'::jsonb);
 INSERT INTO public.contract_shared_review_admission(tenant_id,letter_id,action_id,actor_user_id,actor_person_id,request,content_revision,content_hash)
 VALUES(letter.tenant_id,p_letter,p_action_id,app.current_user_id(),actor_person,command,next_revision,fingerprint);
 RETURN prepared||jsonb_build_object('revision',next_revision,'hash',fingerprint);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_review_prepare(uuid,text,uuid,text,text,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_review_prepare(uuid,text,uuid,text,text,text,integer,jsonb) TO ai_hr_app;
