-- ADR-0151 §4.5 (amendment 2026-10-29): one named agent principal per tenant for the nightly orchestrator
-- pass, replacing the anonymous group-wide hr_admin context. Reserved as 0672 between the active ADR-0151
-- sessions on 29 Oct 2026; the journal index and `when` are assigned at journaling.
--
-- The principal is not a login: no app_user row, no role_assignment, no credential. An agent transaction
-- carries NO grants, so every is_admin*/login policy branch is false for it. It gets only the additive
-- policies below, for the two specialists it runs (readiness reminders, claims triage), and two
-- presence-only readers that return whether a readiness field is present, never its value.
CREATE TABLE app.ai_agent_principal (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenant(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE app.ai_agent_principal ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.ai_agent_principal FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Every existing tenant gets its principal now; the nightly sweep creates one for a later tenant on the
-- owner connection. Creating a principal grants nothing: an agent runs only behind an attributed switch.
INSERT INTO app.ai_agent_principal(tenant_id) SELECT id FROM public.tenant ON CONFLICT (tenant_id) DO NOTHING;
--> statement-breakpoint
-- The principal named by this transaction, or NULL. Only when the setting names this tenant's own row, no
-- login is set and no grant is carried: an agent context can never also be an administrator or a person.
CREATE FUNCTION app.current_agent_principal() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.id FROM app.ai_agent_principal p
 WHERE nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
  AND p.id=nullif(current_setting('app.agent_principal_id',true),'')::uuid
  AND p.tenant_id=app.current_tenant_id()
  AND app.current_user_id() IS NULL
  AND NOT EXISTS(SELECT 1 FROM app.current_grants())
  AND coalesce(nullif(current_setting('app.roles',true),''),'')=''
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.current_agent_principal() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.current_agent_principal() TO ai_hr_app;
--> statement-breakpoint
-- Cases: the orchestrator opens, observes and closes readiness cases for active employments of its tenant.
CREATE POLICY hr_orchestration_case_agent ON public.hr_orchestration_case FOR ALL TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=hr_orchestration_case.employment_id AND e.tenant_id=app.current_tenant_id()))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=hr_orchestration_case.employment_id AND e.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
-- Employment rows (company, person, payment method, termination) to find leavers and HR recipients. Pay,
-- statutory numbers and bank details live in other tables and stay unreadable.
CREATE POLICY employment_agent_read ON public.employment FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
-- Its own reminder ledger only.
CREATE POLICY agent_proposal_agent_read ON public.agent_proposal FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND proposal_type='readiness_fix');
--> statement-breakpoint
CREATE POLICY agent_proposal_agent_settle ON public.agent_proposal FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND proposal_type='readiness_fix')
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND proposal_type='readiness_fix' AND decided_by_user_id IS NULL);
--> statement-breakpoint
CREATE POLICY agent_proposal_agent_kind ON public.agent_proposal AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK (app.current_agent_principal() IS NULL OR (proposal_type='readiness_fix' AND decided_by_user_id IS NULL));
--> statement-breakpoint
-- Reminder de-duplication reads its own earlier receipts; attribution reads who last switched each of its
-- two specialists on or off (the key and value only travel on that event).
CREATE POLICY domain_event_agent_read ON public.domain_event FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND (event_type='readiness.nudge-raised'
  OR (event_type='tenant-setting.changed' AND aggregate_type='tenant-setting' AND aggregate_id=tenant_id
   AND payload->>'key' IN ('notifications.readiness_nudge_enabled','claims.input_triage_enabled'))));
--> statement-breakpoint
-- Every agent effect is attributable: actor_type agent, actor_id the principal, a closed list of event
-- types, and a payload stamp naming the principal and at least one administrator's switch-on event.
CREATE POLICY domain_event_agent_stamp ON public.domain_event AS RESTRICTIVE FOR INSERT TO ai_hr_app
 WITH CHECK (app.current_agent_principal() IS NULL OR (
  actor_type='agent' AND actor_id=app.current_agent_principal()
  AND (event_type IN ('orchestrator.readiness-checked','orchestrator.pass-finished','readiness.nudge-raised')
   OR event_type ~ '^orchestrator\.case-(needs_input|needs_review|verified|inactive|reopened)$')
  AND jsonb_typeof(payload->'agent')='object'
  AND payload->'agent'->>'principalId'=actor_id::text
  AND jsonb_typeof(payload->'agent'->'enabledBy')='array'
  AND jsonb_array_length(payload->'agent'->'enabledBy')>0
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'agent'->'enabledBy') x
   WHERE jsonb_typeof(x)<>'object' OR x->>'feature' NOT IN ('readiness_reminders','claims_triage')
    OR coalesce(x->>'userId','') !~ '^[0-9a-f-]{36}$' OR coalesce(x->>'eventId','') !~ '^[0-9a-f-]{36}$')));
--> statement-breakpoint
-- Presence-only readiness source: per active employment, whether each readiness field is present. Values
-- (identity, tax, EPF, SOCSO, bank numbers, pay) never leave this function. Mirrors gapsForRecord's blank().
CREATE FUNCTION app.agent_readiness_presence(p_employment_ids uuid[]) RETURNS TABLE(
 employment_id uuid,person_id uuid,full_name text,employee_code text,company text,payment_method text,
 has_ic boolean,has_passport boolean,has_tax boolean,has_epf boolean,has_socso boolean,has_bank boolean,
 has_compensation boolean,has_statutory_profile boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_agent_principal() IS NULL THEN RAISE EXCEPTION 'Agent source unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT e.id,e.person_id,p.full_name,e.employee_code,c.legal_name,e.payment_method::text,
  coalesce(s.ic_number ~ '\S',false),coalesce(s.passport_number ~ '\S',false),coalesce(s.tax_number ~ '\S',false),
  coalesce(s.epf_number ~ '\S',false),coalesce(s.socso_number ~ '\S',false),coalesce(s.bank_account_no ~ '\S',false),
  EXISTS(SELECT 1 FROM public.compensation x WHERE x.employment_id=e.id),s.person_id IS NOT NULL
 FROM public.employment e
 JOIN public.person p ON p.id=e.person_id
 JOIN public.company c ON c.id=e.company_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.terminated_on IS NULL
  AND (p_employment_ids IS NULL OR e.id=ANY(p_employment_ids));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_readiness_presence(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agent_readiness_presence(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Pending profile corrections by request: only the NAMES of fields carrying a nonblank proposed value
-- (legacy keys for v1 requests, registry field ids for v2). Proposed values never leave this function.
CREATE FUNCTION app.agent_pending_profile_corrections(p_employment_ids uuid[]) RETURNS TABLE(
 request_id uuid,employment_id uuid,legacy_keys text[],field_ids text[])
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_agent_principal() IS NULL THEN RAISE EXCEPTION 'Agent source unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT r.id,r.employment_id,
  array(SELECT item.key FROM jsonb_each(CASE WHEN jsonb_typeof(r.proposed)='object' AND r.proposed->>'v' IS DISTINCT FROM '2'
    THEN r.proposed ELSE '{}'::jsonb END) item
   WHERE jsonb_typeof(item.value)='string' AND nullif(btrim(item.value #>> '{}'),'') IS NOT NULL),
  array(SELECT item->>'fieldId' FROM jsonb_array_elements(CASE WHEN r.proposed->>'v'='2' AND jsonb_typeof(r.proposed->'fields')='array'
    THEN r.proposed->'fields' ELSE '[]'::jsonb END) item
   WHERE jsonb_typeof(item->'value')='string' AND nullif(btrim(item->>'value'),'') IS NOT NULL)
 FROM public.profile_change_request r
 JOIN public.employment e ON e.id=r.employment_id AND e.person_id=r.person_id AND e.tenant_id=r.tenant_id
 WHERE r.tenant_id=app.current_tenant_id() AND r.status='pending' AND r.employment_id=ANY(p_employment_ids)
 ORDER BY r.created_at DESC,r.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.agent_pending_profile_corrections(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.agent_pending_profile_corrections(uuid[]) TO ai_hr_app;
