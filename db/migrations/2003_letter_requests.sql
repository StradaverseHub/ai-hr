-- AI v2 Phase 1, slice 3: employee letter requests. Source allocation 2003 / when1793330001403 in the AI Centre block
-- 2000-2019 (docs/MIGRATION-ALLOCATION.md), renumbered from the never-applied 0961 / when1793330000361 at the Phase 1
-- release integration (3 November 2026). It grants no installation. Production is held.
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
--  - letter_request: the employee creates one, for themselves only, and reads their own only through the column-safe
--    lookup app.letter_requests_own() (their purpose, the status, the issued letter once issued and HR's message to them
--    once declined): there is no employee SELECT policy on the table, so HR's decline reason and who handled a request
--    never reach the employee, not even by a direct query (pre-release review finding 7, 4 November 2026). HR users
--    holding the letters `generate` capability for the request's company read and update it. Nobody else: no manager,
--    other employee, agent or other-tenant policy exists.
--  - Owner-side paths, each narrower than an application read: the definer lookups below read options of the caller's
--    tenant (configuration, no personal data), for a caller holding `generate`, a request's subject name, and for the
--    employee their own requests' safe columns; the issue trigger moves an in-progress request whose linked letter is
--    issued to issued, nothing else; person erasure (core/pdpa.ts -> app.letter_requests_redact, under the admitted,
--    audited review-erasure intent) clears the person's free text and nothing else.
-- Lifecycle (database-owned, app.letter_request_guard): requested -> in_progress (HR prepared a draft from the request's
-- own template for the request's own employee) -> issued (only when that letter is issued, by the trigger on
-- letter_record); requested or in_progress -> declined (HR, with a reason and an optional message to the employee).
-- in_progress may relink to a new draft while the previous one was never issued. issued and declined are final. At most one open request per employee and letter type.
-- Audit: every change appends a domain event (letter-request.*): core/letter-requests.ts in the same transaction for
-- submission, preparation, decline and option changes; the issue trigger for issued. No event carries the purpose, the
-- decline reason, the message to the employee or any letter content. The employee is notified of a decline with no
-- content beyond the status (core/notifications.ts, letter-request.declined); they read HR's optional message with the
-- declined status on My Letters, never the reason.
-- Erasure (pre-release review finding 6, 4 November 2026): the purpose, the decline reason and the message to the
-- employee are free text about the person. Person erasure clears all three on every request of the person and records
-- when (text_erased_at); the request's facts (letter type, status, dates, the issued letter, who handled it) are the HR
-- record and stay, as a chat-confirmed request survives its chat.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: both tables are new; core/letter-requests.ts is their only application writer
-- (core/letters.ts createLetterDraftBatch links a request through it); app.letter_request_issued and
-- app.letter_requests_redact are the only owner-side ones.

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
--    with the declined status (never in an event or a notification). text_erased_at: person erasure cleared the purpose,
--    the reason and the message; a declined request then keeps no reason.
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
 text_erased_at timestamptz,
 CHECK (decline_reason IS NULL OR status='declined'),
 CHECK (status<>'declined' OR decline_reason IS NOT NULL OR text_erased_at IS NOT NULL),
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
-- the lifecycle above. The message is written only with a decline. Person erasure's own transaction (the marker below,
-- owner side only) may clear the purpose, the reason and the message, and nothing else; the database stamps when.
CREATE FUNCTION app.letter_request_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE type_name text;linked_state text;
BEGIN
 IF TG_OP='INSERT' THEN
  NEW.status:='requested';NEW.letter_id:=NULL;NEW.decline_reason:=NULL;NEW.employee_message:=NULL;NEW.handled_by:=NULL;
  NEW.created_at:=now();NEW.status_changed_at:=now();NEW.version:=1;NEW.purpose:=nullif(btrim(NEW.purpose),'');
  type_name:=app._letter_request_type_name(NEW.tenant_id,NEW.company_id,NEW.template_id);
  IF type_name IS NULL THEN RAISE EXCEPTION 'This letter type is not open for employee requests' USING ERRCODE='23514';END IF;
  NEW.letter_type_name:=type_name;NEW.text_erased_at:=NULL;RETURN NEW;
 END IF;
 IF current_user<>'ai_hr_app' AND current_setting('app.letter_request_erasure',true)=OLD.tenant_id::text THEN
  IF (to_jsonb(NEW)-ARRAY['purpose','decline_reason','employee_message','text_erased_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['purpose','decline_reason','employee_message','text_erased_at'])
    OR NEW.purpose IS NOT NULL OR NEW.decline_reason IS NOT NULL OR NEW.employee_message IS NOT NULL THEN
   RAISE EXCEPTION 'Erasure only clears a letter request''s free text' USING ERRCODE='42501';END IF;
  NEW.text_erased_at:=now();RETURN NEW;
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
-- 3b. The employee's own requests: the only way an employee reads them (no employee SELECT policy exists on the table),
--     so HR's decline reason and who handled a request never reach them, even by a direct query. Their own purpose, the
--     status and its times, the issued letter once issued, and HR's message to them once declined. p_client_key narrows
--     to the request a chat card of theirs created (a repeated Confirm is the same request).
CREATE FUNCTION app.letter_requests_own(p_client_key uuid) RETURNS TABLE(id uuid,employment_id uuid,template_id uuid,letter_type_name text,purpose text,status text,
  created_at timestamptz,status_changed_at timestamptz,letter_id uuid,employee_message text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r.id,r.employment_id,r.template_id,r.letter_type_name,r.purpose,r.status,r.created_at,r.status_changed_at,
  CASE WHEN r.status='issued' THEN r.letter_id END,CASE WHEN r.status='declined' THEN r.employee_message END
 FROM public.letter_request r
 WHERE r.tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id))
  AND (p_client_key IS NULL OR (r.client_key=p_client_key AND r.requested_by=app.current_user_id()))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_requests_own(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.letter_requests_own(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 3c. Person erasure. Joins the existing admitted erasure in THIS transaction (app.assistant_own_leave_reviews_redact
--     records the intent; the canonical pii.erased audit is required at commit), exactly as app.teras_chats_redact does.
--     It clears the purpose, the decline reason and the message to the employee on every request of the person's
--     employments, keeps every other fact, and returns the number of requests cleared. It reads no text.
CREATE FUNCTION app._letter_request_erasure_subject(p_tenant uuid,p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i JOIN public.employment e ON e.person_id=i.person_id AND e.tenant_id=i.tenant_id
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=p_tenant AND i.user_id=app.current_user_id() AND e.id=p_employment)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._letter_request_erasure_subject(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- EXECUTE only so an application query's policy check can be planned; it answers only for the caller's own transaction
-- and the erasure policies below also require the table owner as the current user.
GRANT EXECUTE ON FUNCTION app._letter_request_erasure_subject(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.letter_requests_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;n integer;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Letter request erasure admission unavailable' USING ERRCODE='42501';END IF;
 PERFORM set_config('app.letter_request_erasure',i.tenant_id::text,true);
 UPDATE public.letter_request r SET purpose=NULL,decline_reason=NULL,employee_message=NULL
  WHERE r.tenant_id=i.tenant_id AND (r.purpose IS NOT NULL OR r.decline_reason IS NOT NULL OR r.employee_message IS NOT NULL)
   AND app._letter_request_erasure_subject(r.tenant_id,r.employment_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('app.letter_request_erasure','',true);
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.letter_requests_redact(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.letter_requests_redact(uuid) TO ai_hr_app;
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
-- 5. Requests: HR's with `generate` read them; the employee creates their own and reads them only through
--    app.letter_requests_own (section 3b): no employee SELECT policy exists. No other application policy exists.
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
-- The employee's own lookup (app.letter_requests_own): the owner sees exactly the calling login's own requests.
CREATE POLICY letter_request_definer_own_read ON public.letter_request FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=letter_request.employment_id AND e.tenant_id=letter_request.tenant_id AND app.is_self_person(e.person_id)));
--> statement-breakpoint
-- Person erasure: only the table owner as current user (app.letter_requests_redact), only the admitted subject's requests.
CREATE POLICY letter_request_person_erasure_read ON public.letter_request FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._letter_request_erasure_subject(tenant_id,employment_id));
--> statement-breakpoint
CREATE POLICY letter_request_person_erasure ON public.letter_request FOR UPDATE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.letter_request'::regclass))
  AND tenant_id::text=current_setting('app.letter_request_erasure',true) AND app._letter_request_erasure_subject(tenant_id,employment_id))
 WITH CHECK (tenant_id::text=current_setting('app.letter_request_erasure',true));
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
