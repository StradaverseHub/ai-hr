-- Person-grained celebration choices are disclosure controls, not cosmetic card preferences.
-- No date of birth, birth year, employment anniversary date or peer information is copied here.
-- An absent choice means no personal opt-out; sharing still requires the separate, default-off
-- company/role Home policy and a current authorized audience at each read/send boundary.
CREATE TABLE public.employee_home_person_privacy_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 person_id uuid NOT NULL REFERENCES public.person(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK(ordinal>0),
 hide_birthday boolean NOT NULL,
 hide_anniversary boolean NOT NULL,
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT employee_home_person_privacy_ordinal_uq UNIQUE(tenant_id,person_id,ordinal)
);
--> statement-breakpoint
ALTER TABLE public.employee_home_person_privacy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_home_person_privacy_revision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_home_person_privacy_read ON public.employee_home_person_privacy_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_self_person(person_id));
CREATE POLICY employee_home_person_privacy_insert ON public.employee_home_person_privacy_revision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND app.is_self_person(person_id) AND created_by_user_id=app.current_user_id());
--> statement-breakpoint
GRANT SELECT,INSERT ON public.employee_home_person_privacy_revision TO ai_hr_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.employee_home_person_privacy_revision FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.prepare_employee_home_person_privacy_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_ordinal integer;
BEGIN
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'Retain employee celebration privacy history' USING ERRCODE='23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS NOT TRUE
  OR app.is_self_person(NEW.person_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'The own celebration privacy context is unavailable' USING ERRCODE='42501';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=NEW.person_id AND p.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'The own celebration privacy context is unavailable' USING ERRCODE='42501';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('home-person-privacy:'||NEW.tenant_id::text||':'||NEW.person_id::text,0));
 SELECT ordinal INTO previous_ordinal FROM public.employee_home_person_privacy_revision
  WHERE tenant_id=NEW.tenant_id AND person_id=NEW.person_id ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous_ordinal,0)+1 THEN
  RAISE EXCEPTION 'Celebration privacy changed; reload before saving' USING ERRCODE='23514';
 END IF;
 -- Actor and time attest this command; direct app SQL cannot impersonate another person or backdate it.
 NEW.created_by_user_id:=app.current_user_id();NEW.created_at:=clock_timestamp();
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.prepare_employee_home_person_privacy_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER employee_home_person_privacy_prepare BEFORE INSERT OR UPDATE ON public.employee_home_person_privacy_revision
 FOR EACH ROW EXECUTE FUNCTION app.prepare_employee_home_person_privacy_revision();
--> statement-breakpoint
CREATE FUNCTION app.audit_employee_home_person_privacy_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Person-wide across employments: no arbitrary employment is selected as the audit subject. The
 -- private version is the evidence; the shared event never contains disclosure values or personal dates.
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(NEW.tenant_id,'employee-home-person-privacy',NEW.person_id,'employee-home.person-privacy.updated',
  'user',NEW.created_by_user_id,jsonb_build_object('revisionId',NEW.id,'ordinal',NEW.ordinal));
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.audit_employee_home_person_privacy_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER employee_home_person_privacy_audit AFTER INSERT ON public.employee_home_person_privacy_revision
 FOR EACH ROW EXECUTE FUNCTION app.audit_employee_home_person_privacy_revision();
