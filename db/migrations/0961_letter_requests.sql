-- AI v2 Phase 1, slice 3: employee letter requests. Provisional DEVELOPMENT source allocation 0961 / when1793330000361
-- (docs/MIGRATION-ALLOCATION.md): 0960 is reserved for the parallel loops branch, and a scan of every origin ref and
-- registered worktree on 3 November 2026 found no claim on 0961. It grants no installation, and the journal position is
-- re-frozen at integration. Production is held.
--
-- An employee asks HR for a letter (an employment confirmation letter, for example) from the templates their company has
-- opened for self-request. HR prepares it through the existing generate flow and issues it as today; the request then
-- links to the issued letter. The request carries no letter content and no figure: HR's own template and the letters
-- owner (core/letters.ts) write the letter. The person's purpose is their own short text, read only by them and by HR.
--
-- Who reads and writes (FORCE row-level security on both tables, so the physical owner is bound by the policies too):
--  - letter_request_option ("employees may request", per template, default off): HR users holding the letters
--    `settings` capability for the company set it; holders of read, template, generate or settings read it. Employees
--    never read it directly: app.letter_requestable_templates() answers for their own current employments only.
--  - letter_request: the employee reads their own (the employment is theirs) and creates one, for themselves only;
--    HR users holding the letters `generate` capability for the request's company read and update it. Nobody else: no
--    manager, other employee, agent or other-tenant policy exists.
--  - Owner-side paths, each narrower than an application read: the definer lookups below read options of the caller's
--    tenant (configuration, no personal data) and, for a caller holding `generate`, a request's subject name; the
--    issue trigger moves an in-progress request whose linked letter is issued to issued, nothing else.
-- Lifecycle (database-owned, app.letter_request_guard): requested -> in_progress (HR prepared a draft from the request's
-- own template for the request's own employee) -> issued (only when that letter is issued, by the trigger on
-- letter_record); requested or in_progress -> declined (HR, with a reason and an optional message to the employee).
-- in_progress may relink to a new draft while the previous one was never issued. issued and declined are final. At most one open request per employee and letter type.
-- Audit: every change appends a domain event (letter-request.*): core/letter-requests.ts in the same transaction for
-- submission, preparation, decline and option changes; the issue trigger for issued. No event carries the purpose, the
-- decline reason, the message to the employee or any letter content. The employee is notified of a decline with no
-- content beyond the status (core/notifications.ts, letter-request.declined); they read HR's optional message with the
-- declined status on My Letters, never the reason.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: both tables are new; core/letter-requests.ts is their only application writer
-- (core/letters.ts createLetterDraftBatch links a request through it) and app.letter_request_issued the only owner-side one.

-- 1. Which templates employees may request. One row per template; a missing row is "off".
CREATE TABLE public.letter_request_option (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 template_id uuid NOT NULL REFERENCES public.letter_template(id),
 requestable boolean NOT NULL,
 updated_by uuid NOT NULL REFERENCES public.app_user(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 PRIMARY KEY (tenant_id,template_id)
);
--> statement-breakpoint
CREATE INDEX letter_request_option_company_idx ON public.letter_request_option(tenant_id,company_id) WHERE requestable;
--> statement-breakpoint
-- The template is the company's own (definer: a settings holder may not read letter_template under its RLS).
CREATE FUNCTION app._letter_template_in_company(p_template uuid,p_tenant uuid,p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.letter_template t
  WHERE t.id=p_template AND t.tenant_id=p_tenant AND t.company_id=p_company)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_template_in_company(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._letter_template_in_company(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Database-owned times and versions: an option names its own company's template; afterwards only the flag (and who set
-- it) changes.
CREATE FUNCTION app.letter_request_option_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF app._letter_template_in_company(NEW.template_id,NEW.tenant_id,NEW.company_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'The template is not this company''s' USING ERRCODE='23514';END IF;
  NEW.updated_at:=now();NEW.version:=1;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-'requestable'-'updated_by'-'updated_at'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'requestable'-'updated_by'-'updated_at'-'version') THEN
  RAISE EXCEPTION 'Only whether employees may request a template changes' USING ERRCODE='42501';END IF;
 NEW.updated_at:=now();NEW.version:=OLD.version+1;RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_option_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER letter_request_option_guard BEFORE INSERT OR UPDATE ON public.letter_request_option
 FOR EACH ROW EXECUTE FUNCTION app.letter_request_option_guard();
--> statement-breakpoint
-- The published version of a template: the latest approved version in effect today (Asia/Kuala_Lumpur), of a template
-- that is not deactivated; the same rule the generate flow uses (core/letters.ts generationTemplate). Internal only.
CREATE FUNCTION app._letter_template_published(p_template uuid) RETURNS TABLE(version_id uuid,name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT v.id,v.name FROM public.letter_template t
 JOIN public.letter_template_version v ON v.template_id=t.id AND v.tenant_id=t.tenant_id
 WHERE t.id=p_template AND t.tenant_id=app.current_tenant_id() AND NOT t.deactivated AND v.status='approved'
  AND v.effective_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 ORDER BY v.ordinal DESC LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_template_published(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The name a request records: the template's published name, when the company has opened it for employee requests.
-- NULL otherwise. Reads configuration only.
CREATE FUNCTION app._letter_request_type_name(p_tenant uuid,p_company uuid,p_template uuid) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p.name FROM public.letter_request_option o
 JOIN public.letter_template t ON t.id=o.template_id AND t.tenant_id=o.tenant_id AND t.company_id=o.company_id
 CROSS JOIN LATERAL app._letter_template_published(o.template_id) p
 WHERE p_tenant=app.current_tenant_id() AND o.tenant_id=p_tenant AND o.company_id=p_company AND o.template_id=p_template AND o.requestable
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_request_type_name(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._letter_request_type_name(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- What the calling login may request: for each of its own current employments (not an agent, a current principal, the
-- company not archived), the templates that company opened for employee requests and has published. Names only: the
-- company's legal name tells two employments apart.
CREATE FUNCTION app.letter_requestable_templates() RETURNS TABLE(employment_id uuid,company_id uuid,company_name text,template_id uuid,name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,e.company_id,c.legal_name,o.template_id,p.name
 FROM public.app_user u
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id AND c.archived_at IS NULL
 JOIN public.letter_request_option o ON o.tenant_id=e.tenant_id AND o.company_id=e.company_id AND o.requestable
 JOIN public.letter_template t ON t.id=o.template_id AND t.tenant_id=o.tenant_id AND t.company_id=o.company_id
 CROSS JOIN LATERAL app._letter_template_published(o.template_id) p
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
  AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ORDER BY e.id,p.name,o.template_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_requestable_templates() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.letter_requestable_templates() TO ai_hr_app;
--> statement-breakpoint
-- Letter settings: every published template of the company and whether employees may request it, for a caller holding
-- `settings` there (who may not read templates themselves). Configuration only.
CREATE FUNCTION app.letter_request_option_choices(p_company uuid) RETURNS TABLE(template_id uuid,code text,name text,requestable boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT t.id,t.code,p.name,coalesce(o.requestable,false)
 FROM public.letter_template t
 CROSS JOIN LATERAL app._letter_template_published(t.id) p
 LEFT JOIN public.letter_request_option o ON o.tenant_id=t.tenant_id AND o.template_id=t.id
 WHERE t.tenant_id=app.current_tenant_id() AND t.company_id=p_company AND app.letter_permission(p_company,'settings') IS TRUE
  AND app.current_agent_principal() IS NULL
 ORDER BY p.name,t.id
 LIMIT 200
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_option_choices(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.letter_request_option_choices(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 2. One employee letter request. letter_type_name is the template's published name when it was requested (the
--    employee cannot read templates); purpose is the person's own short text; client_key makes a repeated Confirm of
--    one chat card the same request; decline_reason is HR's and never leaves HR's screens or reaches an event;
--    employee_message is HR's optional message to the employee, written only with a decline and shown to the employee
--    with the declined status (never in an event or a notification).
CREATE TABLE public.letter_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 employment_id uuid NOT NULL REFERENCES public.employment(id),
 requested_by uuid NOT NULL REFERENCES public.app_user(id),
 template_id uuid NOT NULL REFERENCES public.letter_template(id),
 letter_type_name text NOT NULL CHECK (length(letter_type_name) BETWEEN 1 AND 200),
 purpose text CHECK (purpose IS NULL OR length(purpose) BETWEEN 1 AND 300),
 client_key uuid,
 status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','in_progress','issued','declined')),
 letter_id uuid REFERENCES public.letter_record(id),
 decline_reason text CHECK (decline_reason IS NULL OR length(decline_reason) BETWEEN 1 AND 500),
 employee_message text CHECK (employee_message IS NULL OR length(employee_message) BETWEEN 1 AND 500),
 handled_by uuid REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 CHECK ((status='declined')=(decline_reason IS NOT NULL)),
 CHECK (employee_message IS NULL OR status='declined'),
 CHECK (status NOT IN ('in_progress','issued') OR letter_id IS NOT NULL),
 CHECK (status<>'requested' OR (letter_id IS NULL AND handled_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX letter_request_company_idx ON public.letter_request(tenant_id,company_id,status,created_at DESC);
--> statement-breakpoint
CREATE INDEX letter_request_employment_idx ON public.letter_request(tenant_id,employment_id,created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX letter_request_open_uq ON public.letter_request(tenant_id,employment_id,template_id) WHERE status IN ('requested','in_progress');
--> statement-breakpoint
CREATE UNIQUE INDEX letter_request_client_key_uq ON public.letter_request(tenant_id,requested_by,client_key) WHERE client_key IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX letter_request_letter_uq ON public.letter_request(tenant_id,letter_id) WHERE letter_id IS NOT NULL;
--> statement-breakpoint
-- A draft prepared from this request: the request's own tenant, company and employee, from the request's own template.
CREATE FUNCTION app._letter_request_letter_matches(p_letter uuid,p_tenant uuid,p_company uuid,p_employment uuid,p_template uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.letter_record l
  JOIN public.letter_generation_batch b ON b.id=l.batch_id AND b.tenant_id=l.tenant_id
  JOIN public.letter_template_version v ON v.id=b.template_version_id AND v.tenant_id=b.tenant_id
  WHERE l.id=p_letter AND l.tenant_id=p_tenant AND l.company_id=p_company AND l.employment_id=p_employment AND v.template_id=p_template)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_request_letter_matches(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._letter_request_letter_matches(uuid,uuid,uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- A linked letter's workflow state, for the guard and the issue policies (the issuer may not hold `read`). State only.
CREATE FUNCTION app._letter_request_letter_state(p_letter uuid) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT l.state FROM public.letter_record l WHERE l.id=p_letter AND l.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_request_letter_state(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._letter_request_letter_state(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Database-owned lifecycle. On insert: a request starts requested, at the clock's time, for a template its company has
-- opened for employee requests and published; its name is that published name, whatever the writer sent. On update:
-- only the status, the linked letter, the decline reason, the message to the employee and who handled it change, along
-- the lifecycle above. The message is written only with a decline.
CREATE FUNCTION app.letter_request_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE type_name text;linked_state text;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.status:='requested';NEW.letter_id:=NULL;NEW.decline_reason:=NULL;NEW.employee_message:=NULL;NEW.handled_by:=NULL;
  NEW.created_at:=now();NEW.status_changed_at:=now();NEW.version:=1;NEW.purpose:=nullif(btrim(NEW.purpose),'');
  type_name:=app._letter_request_type_name(NEW.tenant_id,NEW.company_id,NEW.template_id);
  IF type_name IS NULL THEN RAISE EXCEPTION 'This letter type is not open for employee requests' USING ERRCODE='23514';END IF;
  NEW.letter_type_name:=type_name;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['status','letter_id','decline_reason','employee_message','handled_by','status_changed_at','version'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','letter_id','decline_reason','employee_message','handled_by','status_changed_at','version']) THEN
  RAISE EXCEPTION 'Only the status of a letter request changes' USING ERRCODE='42501';END IF;
 IF OLD.status IN ('issued','declined') THEN RAISE EXCEPTION 'A letter request that is issued or declined is final' USING ERRCODE='23514';END IF;
 IF NEW.status='in_progress' THEN
  IF NEW.letter_id IS NULL OR NEW.letter_id IS NOT DISTINCT FROM OLD.letter_id OR NEW.decline_reason IS NOT NULL OR NEW.employee_message IS NOT NULL THEN
   RAISE EXCEPTION 'Preparing a letter request links one new draft' USING ERRCODE='23514';END IF;
  IF OLD.letter_id IS NOT NULL AND app._letter_request_letter_state(OLD.letter_id)='issued' THEN
   RAISE EXCEPTION 'The linked letter is already issued' USING ERRCODE='23514';END IF;
  IF app._letter_request_letter_matches(NEW.letter_id,NEW.tenant_id,NEW.company_id,NEW.employment_id,NEW.template_id) IS NOT TRUE
    OR coalesce(app._letter_request_letter_state(NEW.letter_id),'') NOT IN ('draft','submitted','returned','approved') THEN
   RAISE EXCEPTION 'The draft is not this request''s letter' USING ERRCODE='23514';END IF;
  NEW.handled_by:=app.current_user_id();
 ELSIF NEW.status='declined' THEN
  NEW.decline_reason:=nullif(btrim(NEW.decline_reason),'');NEW.employee_message:=nullif(btrim(NEW.employee_message),'');
  IF NEW.decline_reason IS NULL OR NEW.letter_id IS DISTINCT FROM OLD.letter_id THEN
   RAISE EXCEPTION 'Declining a letter request needs a reason and keeps its letter link' USING ERRCODE='23514';END IF;
  NEW.handled_by:=app.current_user_id();
 ELSIF NEW.status='issued' THEN
  linked_state:=app._letter_request_letter_state(OLD.letter_id);
  IF OLD.status<>'in_progress' OR NEW.letter_id IS DISTINCT FROM OLD.letter_id OR linked_state IS DISTINCT FROM 'issued'
    OR NEW.handled_by IS DISTINCT FROM OLD.handled_by OR NEW.decline_reason IS NOT NULL OR NEW.employee_message IS NOT NULL THEN
   RAISE EXCEPTION 'A letter request is issued only with its letter' USING ERRCODE='23514';END IF;
 ELSE
  RAISE EXCEPTION 'Not an allowed letter request change' USING ERRCODE='23514';
 END IF;
 NEW.status_changed_at:=now();NEW.version:=OLD.version+1;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER letter_request_guard BEFORE INSERT OR UPDATE ON public.letter_request
 FOR EACH ROW EXECUTE FUNCTION app.letter_request_guard();
--> statement-breakpoint
-- HR's view of who asked: the employee's name and code, for a caller holding `generate` for the request's company (who
-- may not hold workforce access). Nothing else of the person.
CREATE FUNCTION app.letter_request_subject(p_request uuid) RETURNS TABLE(employee_name text,employee_code text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(nullif(btrim(p.preferred_name),''),p.full_name),e.employee_code
 FROM public.letter_request r
 JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE r.id=p_request AND r.tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND app.letter_permission(r.company_id,'generate') IS TRUE
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_subject(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.letter_request_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 3. A letter prepared from a request is issued: its request becomes issued, with its audit event, whoever issued it
--    (an issuer may not hold `generate`). Definer rights; it changes only in-progress requests linked to that letter.
CREATE FUNCTION app.letter_request_issued() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r record;
BEGIN
 FOR r IN UPDATE public.letter_request q SET status='issued'
   WHERE q.tenant_id=NEW.tenant_id AND q.letter_id=NEW.id AND q.status='in_progress'
   RETURNING q.id,q.employment_id LOOP
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES (NEW.tenant_id,'letter-request',r.id,'letter-request.issued','user',app.current_user_id(),r.employment_id,
   jsonb_build_object('letterId',NEW.id,'from','in_progress','to','issued'));
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_request_issued() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER letter_request_issued AFTER UPDATE OF state ON public.letter_record
 FOR EACH ROW WHEN (NEW.state='issued' AND OLD.state IS DISTINCT FROM 'issued') EXECUTE FUNCTION app.letter_request_issued();
--> statement-breakpoint
-- ── RLS: forced on both tables ──
ALTER TABLE public.letter_request_option ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.letter_request_option FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.letter_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.letter_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- 4. Options: letters staff of the company read them; `settings` holders set them, as themselves.
CREATE POLICY letter_request_option_read ON public.letter_request_option FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND (app.letter_permission(company_id,'settings') OR app.letter_permission(company_id,'generate')
   OR app.letter_permission(company_id,'read') OR app.letter_permission(company_id,'template')));
--> statement-breakpoint
CREATE POLICY letter_request_option_insert ON public.letter_request_option FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND updated_by=app.current_user_id() AND app.letter_permission(company_id,'settings'));
--> statement-breakpoint
CREATE POLICY letter_request_option_update ON public.letter_request_option FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.letter_permission(company_id,'settings'))
 WITH CHECK (tenant_id=app.current_tenant_id() AND updated_by=app.current_user_id() AND app.letter_permission(company_id,'settings'));
--> statement-breakpoint
-- Definer lookups (sections 1 and 2) read the options of the calling session's tenant: configuration flags only.
CREATE POLICY letter_request_option_definer_read ON public.letter_request_option FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request_option'::regclass))
  AND tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- 5. Requests: the employee's own, and HR's with `generate`. No other application policy exists.
CREATE POLICY letter_request_own_read ON public.letter_request FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=letter_request.employment_id AND e.tenant_id=letter_request.tenant_id AND app.is_self_person(e.person_id)));
--> statement-breakpoint
CREATE POLICY letter_request_staff_read ON public.letter_request FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.letter_permission(company_id,'generate'));
--> statement-breakpoint
CREATE POLICY letter_request_own_create ON public.letter_request FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND requested_by=app.current_user_id() AND status='requested'
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=letter_request.employment_id AND e.tenant_id=letter_request.tenant_id
   AND e.company_id=letter_request.company_id AND app.is_self_person(e.person_id)
   AND (e.terminated_on IS NULL OR e.terminated_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)));
--> statement-breakpoint
CREATE POLICY letter_request_staff_update ON public.letter_request FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.letter_permission(company_id,'generate'))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.letter_permission(company_id,'generate'));
--> statement-breakpoint
-- Definer lookup (app.letter_request_subject): the owner sees exactly the requests the calling login could read as HR.
CREATE POLICY letter_request_definer_staff_read ON public.letter_request FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.letter_permission(company_id,'generate'));
--> statement-breakpoint
-- The issue trigger (app.letter_request_issued): only requests linked to a letter that is issued, and only to issued.
CREATE POLICY letter_request_definer_issue_read ON public.letter_request FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id=app.current_tenant_id() AND status IN ('in_progress','issued') AND letter_id IS NOT NULL
  AND app._letter_request_letter_state(letter_id)='issued');
--> statement-breakpoint
CREATE POLICY letter_request_definer_issue ON public.letter_request FOR UPDATE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id=app.current_tenant_id() AND status='in_progress' AND letter_id IS NOT NULL
  AND app._letter_request_letter_state(letter_id)='issued')
 WITH CHECK (tenant_id=app.current_tenant_id() AND status='issued');
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.letter_request_option,public.letter_request FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.letter_request_option TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (requestable,updated_by) ON public.letter_request_option TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.letter_request TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE (status,letter_id,decline_reason,employee_message,handled_by) ON public.letter_request TO ai_hr_app;
