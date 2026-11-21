-- Narrow self-binding proof. This is not a rerouting permission: the private expected route must ALREADY
-- be the native bind command's exact NULL -> actual employee account/person replacement. App callers cannot
-- write that private policy; generic signer replacement alone therefore never satisfies this proof.
CREATE FUNCTION app.contract_shared_email_self_binding_held(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH subject AS MATERIALIZED(
  SELECT l.data AS metadata,document.data AS signing,employment.person_id
  FROM public.contract_shared_letter l JOIN public.contract_case c ON c.tenant_id=l.tenant_id AND c.id=l.case_id
  JOIN public.employment employment ON employment.tenant_id=c.tenant_id AND employment.id=c.employment_id
  JOIN public.document_signing_document document ON document.tenant_id=l.tenant_id AND document.id=l.signing_document_id AND document.subject_type='contract' AND document.subject_id=l.id
  WHERE l.tenant_id=app.current_tenant_id() AND l.id=p_letter AND l.purpose='email' AND l.data->>'state'='routing'
  AND app.contract_shared_email_document_current(l.id) AND app.contract_verified_human(app.current_user_id())
  AND employment.person_id=app.contract_actor_person(app.current_user_id()) AND employment.person_id::text=l.data->>'subjectPersonId'
  AND (SELECT count(*) FROM public.app_user account WHERE account.tenant_id=l.tenant_id AND account.person_id=employment.person_id AND app.contract_verified_human(account.id))=1
 ),expected AS(
  SELECT metadata,signing,jsonb_set(signing->'route','{steps}',
   (SELECT jsonb_agg(CASE WHEN step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(signing,step)
    THEN step||jsonb_build_object('holderId',app.current_user_id(),'holderPersonId',person_id) ELSE step END ORDER BY n)
    FROM jsonb_array_elements(signing->'route'->'steps') WITH ORDINALITY steps(step,n))) AS route FROM subject
 ) SELECT coalesce(bool_or(metadata->'signingPolicy'->'route'=route AND route IS DISTINCT FROM signing->'route'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(signing->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(signing,step))),false) FROM expected
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_self_binding_held(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
