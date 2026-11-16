-- Shared HR automation email templates (ADR docs/adr/2026-11-15-probation-shared-automation.md, decision 2, build step 3).
-- Tag 5743 / idx 5143 / when 1793330005443 on the board offset (tag T, idx T - 600, when 1793330004800 + (T - 5100)),
-- above 5740 (when 1793330005440).
--
-- 1. automation_email_template_version is APPEND-ONLY, like automation_workflow_version (5740): a save inserts the next
--    revision and nothing updates or deletes a row. The latest revision is the template; earlier revisions are history.
-- 2. Templates are tenant-level and carry a module value (Probation first; On/Off Boarding keep their V9 templates in
--    lc_v9_config and Contract staff keep theirs). Nothing here is company-scoped, so there is no company key.
-- 3. `active = false` turns a template off: a Send email step that uses it is skipped and the skip is noted on the case
--    (runtime: the Probation execution slice). Nothing else changes. `retired` is final.
-- 4. The application reads under row security (only people who can configure the template's module) and writes only
--    through app.automation_email_template_save, which takes the shared workforce barrier, checks authority with
--    app.automation_can_configure (5740), the expected revision and bounded shape, and records a domain_event in the
--    same transaction. Meaning (merge fields, CC recipients) is validated by core/automation-email.ts before the call.
-- New, empty table: no backfill and no populated rows. No existing object, grant or purpose-owned object changes.
CREATE TABLE public.automation_email_template_version (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  template_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 100000),
  module text NOT NULL CHECK (module IN ('onb','off','contract_staff','probation')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  active boolean NOT NULL,
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 500),
  body text NOT NULL CHECK (length(body) <= 20000),
  cc jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc) = 'array'),
  retired boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  saved_by uuid NOT NULL REFERENCES public.app_user(id),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, template_id, revision)
);
--> statement-breakpoint
CREATE INDEX automation_email_template_version_module ON public.automation_email_template_version (tenant_id, module, template_id, revision DESC);
--> statement-breakpoint
ALTER TABLE public.automation_email_template_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_email_template_version FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_email_template_owner ON public.automation_email_template_version FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY automation_email_template_read ON public.automation_email_template_version FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND app.automation_can_configure(module));
--> statement-breakpoint
REVOKE ALL ON public.automation_email_template_version FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.automation_email_template_version TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_template_save(p_template uuid, p_module text, p_name text, p_active boolean, p_subject text, p_body text, p_cc jsonb, p_retired boolean, p_expected integer, p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); prior public.automation_email_template_version; v_revision integer;
BEGIN
  IF t IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'A signed-in tenant user is required' USING ERRCODE='42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF p_template IS NULL OR NOT app.automation_can_configure(p_module) THEN RAISE EXCEPTION 'You cannot configure email templates for this module' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||t::text||':'||p_template::text, 0));
  SELECT * INTO prior FROM public.automation_email_template_version WHERE tenant_id = t AND template_id = p_template ORDER BY revision DESC LIMIT 1;
  IF coalesce(prior.revision, 0) IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This email template changed since you opened it; reload before saving' USING ERRCODE='40001'; END IF;
  IF prior.revision IS NOT NULL AND prior.module <> p_module THEN RAISE EXCEPTION 'An email template cannot move to another module' USING ERRCODE='22023'; END IF;
  IF prior.retired THEN RAISE EXCEPTION 'A retired email template cannot change' USING ERRCODE='22023'; END IF;
  IF p_active IS NULL OR p_retired IS NULL OR length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 200
     OR length(btrim(coalesce(p_subject, ''))) NOT BETWEEN 1 AND 500 OR p_body IS NULL OR length(p_body) > 20000
     OR length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 1 AND 500
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Each type is checked in its own statement before a function that would fail on another type: SQL does not
  -- promise the order in which OR operands are evaluated.
  IF jsonb_typeof(p_cc) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_cc) > 20 OR pg_column_size(p_cc) > 16384 THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE jsonb_typeof(r) IS DISTINCT FROM 'object') THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  -- Every element is now an object, so reading its kind cannot fail.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cc) r WHERE coalesce(r->>'kind', '') NOT IN ('role','routing','group','person','pending'))
  THEN RAISE EXCEPTION 'The email template is incomplete or too large' USING ERRCODE='22023'; END IF;
  v_revision := coalesce(prior.revision, 0) + 1;
  INSERT INTO public.automation_email_template_version (tenant_id, template_id, revision, module, name, active, subject, body, cc, retired, reason, saved_by)
  VALUES (t, p_template, v_revision, p_module, btrim(p_name), p_active, p_subject, p_body, p_cc, p_retired, btrim(p_reason), app.current_user_id());
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (t, 'automation_email_template', p_template,
    CASE WHEN v_revision = 1 THEN 'automation.email_template.created' WHEN p_retired THEN 'automation.email_template.retired' ELSE 'automation.email_template.saved' END,
    'user'::actor_type, app.current_user_id(),
    jsonb_build_object('module', p_module, 'revision', v_revision, 'active', p_active, 'previousActive', prior.active, 'retired', p_retired));
  RETURN v_revision;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text) TO ai_hr_app;
