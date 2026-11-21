-- One private set-based currentness projection; no application grant or action authority.
-- SECURITY INVOKER without a SET clause permits PostgreSQL to inline the relational source.
-- Callers retain their existing SECURITY DEFINER owner/ACL; all referenced relations are qualified.
CREATE FUNCTION app.contract_shared_current_email_documents(p_tenant uuid) RETURNS TABLE(letter_id uuid,self_binding_available boolean)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH companies AS MATERIALIZED(
  SELECT company.id FROM public.company company JOIN public.tenant tenant ON tenant.id=company.tenant_id
  WHERE company.tenant_id=p_tenant AND tenant.status IN('active','trial')
   AND EXISTS(SELECT 1 FROM public.tenant_module module WHERE module.tenant_id=company.tenant_id AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>pg_catalog.now()) AND (module.company_id IS NULL OR module.company_id=company.id))),
 actor AS MATERIALIZED(SELECT app.current_user_id() AS id,app.contract_actor_person(app.current_user_id()) AS person_id),
 verified_accounts AS MATERIALIZED(SELECT pg_catalog.count(*) AS total FROM public.app_user account CROSS JOIN actor WHERE account.tenant_id=p_tenant AND account.person_id=actor.person_id AND app.contract_verified_human(account.id))
 SELECT letter.id,
  coalesce(employment.person_id=actor.person_id AND accounts.total=1 AND run.module='contract_staff' AND run.subject_id=pin.case_id AND run.status='waiting' AND run.waiting_for=pin.id
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
 WHERE letter.tenant_id=p_tenant AND p_tenant=app.current_tenant_id() AND letter.purpose='email' AND employment.person_id::text=letter.data->>'subjectPersonId' AND employment.voided_at IS NULL
  AND CASE WHEN pin.documents->>(letter.data->>'templateId')=letter.id::text THEN true WHEN document.id IS NULL THEN app.contract_shared_effect_held(letter.case_id,letter.workflow_run_id,letter.workflow_step_id,'sendEmail') ELSE false END
  AND (letter.decision_revision=0 OR (flow.data->'decision'->>'revision')::integer=letter.decision_revision OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(flow.data->'decisionHistory') decision WHERE (decision->>'revision')::integer=letter.decision_revision))
$$;
ALTER FUNCTION app.contract_shared_current_email_documents(uuid) OWNER TO ai_hr_owner;
REVOKE ALL ON FUNCTION app.contract_shared_current_email_documents(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Same native OID/signature and existing ACL. This is still a currentness predicate, not an action grant.
CREATE OR REPLACE FUNCTION app.contract_shared_email_document_current(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.contract_shared_current_email_documents(app.current_tenant_id()) current_email WHERE current_email.letter_id=p_letter)
$$;
--> statement-breakpoint
-- Preserve the specifically approved self-account prerequisite under the same native owner/ACL.
CREATE OR REPLACE FUNCTION app.contract_shared_email_self_binding_available(p_letter uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT current_email.self_binding_available FROM app.contract_shared_current_email_documents(app.current_tenant_id()) current_email JOIN public.contract_shared_letter letter ON letter.tenant_id=app.current_tenant_id() AND letter.id=current_email.letter_id WHERE current_email.letter_id=p_letter AND letter.data->>'state'='routing'),false)
$$;
--> statement-breakpoint
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
