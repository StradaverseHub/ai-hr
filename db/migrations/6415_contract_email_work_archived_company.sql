-- Restore the exact 5922 work-list exclusion of archived companies.
-- The canonical currentness source and historical single-document permissions remain unchanged.
CREATE OR REPLACE FUNCTION app.contract_shared_pending_work_page_source(p_cases uuid[],p_assigned_only boolean) RETURNS TABLE(case_id uuid,employment_id uuid,company_id uuid,subject_id uuid,kind text,step_id text,label text,assigned_name text,eligible boolean,updated_at timestamptz,action_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH actor AS MATERIALIZED(
  SELECT account.id,account.person_id,person.full_name,app.contract_verified_human(account.id) AS verified
  FROM public.app_user account JOIN public.person person ON person.tenant_id=account.tenant_id AND person.id=account.person_id
  WHERE account.tenant_id=app.current_tenant_id() AND account.id=app.current_user_id()),
 email_candidates AS MATERIALIZED(
  SELECT letter.id FROM public.document_signing_assignment target JOIN actor ON actor.verified AND target.user_id=actor.id AND target.person_id=actor.person_id
  JOIN public.contract_shared_letter letter ON letter.tenant_id=target.tenant_id AND letter.signing_document_id=target.document_id
  WHERE p_assigned_only AND target.tenant_id=app.current_tenant_id() AND letter.purpose='email' AND letter.data->>'state'='routing'
  UNION SELECT letter.id FROM actor JOIN public.contract_shared_letter letter ON letter.tenant_id=app.current_tenant_id() AND letter.data->>'subjectPersonId'=actor.person_id::text
  WHERE p_assigned_only AND actor.verified AND letter.purpose='email' AND letter.data->>'state'='routing'
  UNION SELECT letter.id FROM public.contract_shared_letter letter WHERE NOT p_assigned_only AND letter.tenant_id=app.current_tenant_id() AND letter.case_id=ANY(p_cases[1:100]) AND letter.purpose='email' AND letter.data->>'state'='routing'),
 email_documents AS MATERIALIZED(
  SELECT contract.id AS case_id,contract.employment_id,contract.company_id,letter.id AS letter_id,letter.updated_at,document.data AS signing_data,current_email.self_binding_available
  FROM email_candidates candidate JOIN public.contract_shared_letter letter ON letter.tenant_id=app.current_tenant_id() AND letter.id=candidate.id
  JOIN public.contract_case contract ON contract.tenant_id=letter.tenant_id AND contract.id=letter.case_id
  JOIN public.company work_company ON work_company.tenant_id=contract.tenant_id AND work_company.id=contract.company_id AND work_company.archived_at IS NULL
  JOIN public.employment employment ON employment.tenant_id=contract.tenant_id AND employment.id=contract.employment_id AND employment.company_id=contract.company_id AND employment.person_id::text=letter.data->>'subjectPersonId'
  JOIN app.contract_shared_current_email_documents(app.current_tenant_id()) current_email ON current_email.letter_id=letter.id
  JOIN public.document_signing_document document ON document.tenant_id=letter.tenant_id AND document.id=letter.signing_document_id AND document.subject_type='contract' AND document.subject_id=letter.id AND document.employment_id=contract.employment_id AND document.company_id=contract.company_id
  JOIN public.contract_shared_email_document_step pin ON pin.tenant_id=letter.tenant_id AND pin.workflow_run_id=letter.workflow_run_id AND pin.workflow_step_id=letter.workflow_step_id AND pin.case_id=letter.case_id AND pin.company_id=contract.company_id AND pin.subject_person_id=employment.person_id AND pin.documents @> jsonb_build_object(letter.data->>'templateId',letter.id::text)
  WHERE employment.voided_at IS NULL),
 pending_email_steps AS MATERIALIZED(
  SELECT document.*,step.s,actor.id AS actor_id,actor.person_id AS actor_person_id,actor.full_name AS actor_name,actor.verified,
   CASE WHEN p_assigned_only AND step.s->>'kind'='sign' AND step.s->>'role'='employee' AND step.s->>'holderId' IS NULL THEN document.self_binding_available ELSE false END AS self_bind
  FROM email_documents document CROSS JOIN actor
  CROSS JOIN LATERAL(SELECT pending AS s FROM app.document_signing_pending_steps(document.signing_data) pending WHERE NOT app.document_signing_returned(document.signing_data)
   UNION ALL SELECT app.document_signing_owner_step(document.signing_data) WHERE app.document_signing_returned(document.signing_data)) step),
 email_steps AS(SELECT pending.case_id,pending.employment_id,pending.company_id,pending.letter_id AS subject_id,'letter'::text AS kind,pending.s->>'id' AS step_id,pending.s->>'label' AS label,
  CASE WHEN pending.self_bind THEN pending.actor_name ELSE coalesce(person.full_name,pending.s->>'label','Linked account needed') END AS assigned_name,
  pending.verified AND ((pending.s->>'holderId'=pending.actor_id::text AND pending.s->>'holderPersonId'=pending.actor_person_id::text) OR pending.self_bind) AS eligible,
  pending.updated_at,CASE WHEN app.document_signing_returned(pending.signing_data) THEN 'resend' WHEN pending.self_bind THEN 'bindEmployee' ELSE pending.s->>'kind' END AS action_code
  FROM pending_email_steps pending
  LEFT JOIN public.app_user holder ON holder.tenant_id=app.current_tenant_id() AND holder.id::text=pending.s->>'holderId' AND holder.person_id::text=pending.s->>'holderPersonId'
  LEFT JOIN public.person person ON person.tenant_id=holder.tenant_id AND person.id=holder.person_id)
 SELECT ordinary.* FROM app.contract_shared_outcome_work_page_source(p_cases,p_assigned_only) ordinary
 UNION ALL SELECT email.* FROM email_steps email;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_pending_work_page_source(uuid[],boolean) FROM PUBLIC,ai_hr_app;
