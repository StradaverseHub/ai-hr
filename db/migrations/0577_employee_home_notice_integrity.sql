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
--> statement-breakpoint
-- Stable authoring scope, not a guess from a recipient's current employer. Existing announcements
-- retain group ownership and their exact publication/audience/content. No acknowledgement is backfilled.
ALTER TABLE public.notice ADD COLUMN owner_company_id uuid REFERENCES public.company(id);
--> statement-breakpoint
CREATE FUNCTION app.can_manage_notice(p_notice uuid) RETURNS boolean LANGUAGE sql STABLE
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT (SELECT app.principal_snapshot_current()) AND EXISTS(
  SELECT 1 FROM public.notice n WHERE n.id=p_notice AND n.tenant_id=app.current_tenant_id()
   AND ((n.owner_company_id IS NULL AND app.is_group_admin())
     OR (n.owner_company_id IS NOT NULL AND app.is_admin_for(n.owner_company_id)))
 );
$$;
REVOKE ALL ON FUNCTION app.can_manage_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_manage_notice(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_notice_owner() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.published_at IS NOT NULL THEN
   RAISE EXCEPTION 'Retain published notices; archive instead' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id,NEW.owner_company_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.owner_company_id) THEN
  RAISE EXCEPTION 'Notice identity and authoring company are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.published_at IS NOT NULL AND
  ROW(NEW.published_at,NEW.published_by_user_id) IS DISTINCT FROM ROW(OLD.published_at,OLD.published_by_user_id) THEN
  RAISE EXCEPTION 'Retain the original notice publication' USING ERRCODE='23514';
 END IF;
 IF NEW.owner_company_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM public.company c WHERE c.id=NEW.owner_company_id AND c.tenant_id=NEW.tenant_id
   AND (TG_OP<>'INSERT' OR c.archived_at IS NULL)
 ) THEN
  RAISE EXCEPTION 'Notice authoring company is unavailable in this tenant' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_notice_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_owner_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notice
 FOR EACH ROW EXECUTE FUNCTION app.guard_notice_owner();
--> statement-breakpoint
ALTER POLICY notice_admin_rls ON public.notice
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND ((owner_company_id IS NULL AND app.is_group_admin())
   OR (owner_company_id IS NOT NULL AND app.is_admin_for(owner_company_id))))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND ((owner_company_id IS NULL AND app.is_group_admin())
   OR (owner_company_id IS NOT NULL AND app.is_admin_for(owner_company_id))));
--> statement-breakpoint
-- The capability function reads only the parent boundary as its owner, avoiding policy recursion
-- between notice's recipient SELECT and notice_recipient's administrator SELECT.
ALTER POLICY notice_recipient_admin_rls ON public.notice_recipient
 USING(tenant_id=app.current_tenant_id() AND app.can_manage_notice(notice_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_manage_notice(notice_id));
--> statement-breakpoint
ALTER POLICY notice_recipient_read_rls ON public.notice
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND published_at IS NOT NULL AND archived_at IS NULL
  AND start_on-1<=current_date AND current_date<=end_on+1
  AND EXISTS(SELECT 1 FROM public.notice_recipient nr JOIN public.employment e ON e.id=nr.employment_id
   WHERE nr.notice_id=notice.id AND nr.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id)));
--> statement-breakpoint
ALTER POLICY notice_recipient_self_rls ON public.notice_recipient
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)));
ALTER POLICY notice_recipient_self_update_rls ON public.notice_recipient
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current())
  AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id)));
--> statement-breakpoint
CREATE FUNCTION app.guard_published_notice_membership() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_published timestamptz;
BEGIN
 -- Serialize membership changes with publication. Recipient marker updates retain their separate guard.
 SELECT n.published_at INTO parent_published FROM public.notice n
  WHERE n.id=CASE WHEN TG_OP='DELETE' THEN OLD.notice_id ELSE NEW.notice_id END FOR UPDATE;
 IF parent_published IS NOT NULL THEN
  RAISE EXCEPTION 'Retain the published notice audience snapshot' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_published_notice_membership() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER published_notice_membership_guard BEFORE INSERT OR DELETE ON public.notice_recipient
 FOR EACH ROW EXECUTE FUNCTION app.guard_published_notice_membership();
