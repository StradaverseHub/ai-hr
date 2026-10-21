-- Employee Home consumes the existing resolved Notice audience. Viewing/dismissing a notice may
-- update markers, never the identity of the recipient snapshot. The existing self UPDATE policy
-- proves only employment ownership: without this guard an employee could redirect their own row
-- to another notice and thereby satisfy that notice's recipient SELECT policy.
-- No backfill or audience re-resolution: historical snapshot membership remains unchanged.
CREATE OR REPLACE FUNCTION app.guard_notice_recipient_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.notice_id, NEW.employment_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.notice_id, OLD.employment_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Notice recipient identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'notice_recipient_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_notice_recipient_identity() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
DROP TRIGGER IF EXISTS notice_recipient_identity_guard ON public.notice_recipient;
--> statement-breakpoint
CREATE TRIGGER notice_recipient_identity_guard
BEFORE UPDATE ON public.notice_recipient
FOR EACH ROW EXECUTE FUNCTION app.guard_notice_recipient_identity();
--> statement-breakpoint
-- Same editable Dashboard Card Master for existing tenants; no second Home preference/config store.
-- Existing customer definitions retain their exact values. New tenant provisioning uses the same keys.
INSERT INTO public.dashboard_card_config
 (tenant_id,card_key,name,card_type,status,employee_selectable,default_display,mandatory,display_order,href,audience)
SELECT t.id,v.card_key,v.name,v.card_type,'active',v.card_key<>'summary',true,v.card_key='summary',v.display_order,NULL,'{employee}'::text[]
FROM public.tenant t CROSS JOIN (VALUES
 ('summary','My Day at a Glance','information',1),
 ('today','Your Day','information',2),
 ('calendar','My Calendar','information',3),
 ('notices','Notice Board','information',4),
 ('tasks','Waiting for You','action',5),
 ('timeOff','Time Off','information',6),
 ('team','Who’s Around','information',7),
 ('celebrations','Little Moments','information',8)
) v(card_key,name,card_type,display_order)
ON CONFLICT (tenant_id,card_key) DO NOTHING;
--> statement-breakpoint
CREATE TABLE public.employee_home_configuration_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL REFERENCES public.company(id),
 audience_role text NOT NULL CHECK(audience_role IN ('employee','manager','hr_admin')),
 ordinal integer NOT NULL CHECK(ordinal>0),
 configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND configuration->'version'='1'::jsonb AND octet_length(configuration::text)<=262144),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT employee_home_configuration_ordinal_uq UNIQUE(tenant_id,company_id,audience_role,ordinal)
);
--> statement-breakpoint
ALTER TABLE public.employee_home_configuration_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_home_configuration_revision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employee_home_configuration_read ON public.employee_home_configuration_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND
  (app.is_admin_for(company_id) OR EXISTS(
   SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE u.id=app.current_user_id() AND e.tenant_id=employee_home_configuration_revision.tenant_id
    AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND e.blacklisted_at IS NULL
    AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
     OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    AND (e.company_id=employee_home_configuration_revision.company_id OR EXISTS(
     SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id
      AND a.company_id=employee_home_configuration_revision.company_id AND a.superseded_at IS NULL
      AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    ))
  )));
CREATE POLICY employee_home_configuration_insert ON public.employee_home_configuration_revision FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id)
  AND created_by_user_id=app.current_user_id());
--> statement-breakpoint
GRANT SELECT,INSERT ON public.employee_home_configuration_revision TO ai_hr_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.employee_home_configuration_revision FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_employee_home_configuration_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_ordinal integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Retain immutable employee Home configuration history' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('home-config:'||NEW.tenant_id::text||':'||NEW.company_id::text||':'||NEW.audience_role,0));
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current()
  OR NOT app.is_admin_for(NEW.company_id) OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Employee Home configuration is outside company administrator scope' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id AND c.archived_at IS NULL) THEN
  RAISE EXCEPTION 'Choose an active company in this tenant' USING ERRCODE='23514';END IF;
 SELECT ordinal INTO previous_ordinal FROM public.employee_home_configuration_revision
  WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND audience_role=NEW.audience_role ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous_ordinal,0)+1 THEN
  RAISE EXCEPTION 'Employee Home configuration changed; reload before saving' USING ERRCODE='23514';END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_employee_home_configuration_revision() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER employee_home_configuration_immutable_guard BEFORE INSERT OR UPDATE OR DELETE ON public.employee_home_configuration_revision
 FOR EACH ROW EXECUTE FUNCTION app.guard_employee_home_configuration_revision();
