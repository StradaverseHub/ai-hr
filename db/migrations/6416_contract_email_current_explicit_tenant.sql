-- One canonical private source for both scoped metadata and explicitly tenant-bound native senders.
-- actor_person already requires verification; the explicit boolean below documents that existing boundary.
-- No new authority, application grant, source selection or Form PII projection is introduced.
CREATE OR REPLACE FUNCTION app.contract_shared_current_email_documents(p_tenant uuid) RETURNS TABLE(letter_id uuid,self_binding_available boolean)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH companies AS MATERIALIZED(
  SELECT company.id FROM public.company company JOIN public.tenant tenant ON tenant.id=company.tenant_id
  WHERE company.tenant_id=p_tenant AND tenant.status IN('active','trial')
   AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=company.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>pg_catalog.now()) AND (module.company_id IS NULL OR module.company_id=company.id))),
 actor AS MATERIALIZED(SELECT app.current_user_id() AS id,app.contract_actor_person(app.current_user_id()) AS person_id,app.contract_verified_human(app.current_user_id()) AS verified),
 verified_accounts AS MATERIALIZED(SELECT pg_catalog.count(*) AS total FROM public.app_user account CROSS JOIN actor WHERE account.tenant_id=p_tenant AND account.person_id=actor.person_id AND app.contract_verified_human(account.id))
 SELECT letter.id,
  coalesce(actor.verified AND employment.person_id=actor.person_id AND accounts.total=1 AND run.module='contract_staff' AND run.subject_id=pin.case_id AND run.status='waiting' AND run.waiting_for=pin.id
   AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(document.data->'route'->'steps') step WHERE step->>'role'='employee' AND step->>'holderId' IS NULL AND NOT app.document_signing_step_fulfilled(document.data,step)),false)
 FROM public.contract_shared_letter letter
 JOIN public.contract_shared_case flow ON flow.tenant_id=letter.tenant_id AND flow.case_id=letter.case_id
 JOIN public.contract_case contract ON contract.tenant_id=letter.tenant_id AND contract.id=letter.case_id
 JOIN public.employment employment ON employment.tenant_id=contract.tenant_id AND employment.id=contract.employment_id AND employment.company_id=contract.company_id
 JOIN companies ON companies.id=contract.company_id
 JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=letter.tenant_id AND pin.case_id=letter.case_id AND pin.workflow_run_id=letter.workflow_run_id AND pin.workflow_step_id=letter.workflow_step_id AND pin.company_id=contract.company_id AND pin.subject_person_id=employment.person_id AND pin.decision_revision=letter.decision_revision AND pin.email_template_id::text=letter.data->'emailTemplateRef'->>'id' AND pin.email_revision::text=letter.data->'emailTemplateRef'->>'revision'
 LEFT JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id
 LEFT JOIN public.automation_run run ON run.tenant_id=pin.tenant_id AND run.id=pin.workflow_run_id
 CROSS JOIN actor CROSS JOIN verified_accounts accounts
 WHERE letter.tenant_id=p_tenant AND letter.purpose='email' AND employment.person_id::text=letter.data->>'subjectPersonId' AND employment.voided_at IS NULL
  AND CASE WHEN pin.documents->>(letter.data->>'templateId')=letter.id::text THEN true WHEN document.id IS NULL THEN app.contract_shared_effect_held(letter.case_id,letter.workflow_run_id,letter.workflow_step_id,'sendEmail') ELSE false END
  AND (letter.decision_revision=0 OR (flow.data->'decision'->>'revision')::integer=letter.decision_revision OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(flow.data->'decisionHistory') decision WHERE (decision->>'revision')::integer=letter.decision_revision))
$$;
ALTER FUNCTION app.contract_shared_current_email_documents(uuid) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.contract_shared_current_email_documents(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_current(p_tenant uuid,p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.contract_shared_current_email_documents(p_tenant) current_email WHERE current_email.letter_id=p_letter)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_email_document_current(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_current(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_shared_email_document_current(app.current_tenant_id(),p_letter)
$$;
