-- Employee Home consumes the existing resolved Notice audience. Viewing/dismissing a notice may
-- update markers, never the identity of the recipient snapshot. The existing self UPDATE policy
-- proves only employment ownership: without this guard an employee could redirect their own row
-- to another notice and thereby satisfy that notice's recipient SELECT policy.
-- No backfill or audience re-resolution: historical snapshot membership remains unchanged.
-- Acquire the related DDL locks together without holding a partial set while a publisher,
-- projector or email revalidator finishes in its own query order. A failed NOWAIT attempt rolls
-- back this subtransaction's locks; existing work can finish before the next bounded attempt.
DO $$
DECLARE deadline timestamptz:=clock_timestamp()+interval '30 seconds';
BEGIN
 LOOP
  BEGIN
   LOCK TABLE public.notification_cursor,public.notice,public.notice_recipient,public.domain_event
    IN ACCESS EXCLUSIVE MODE NOWAIT;
   EXIT;
  EXCEPTION WHEN lock_not_available THEN
   IF clock_timestamp()>=deadline THEN
    RAISE EXCEPTION 'Notice migration could not acquire its complete lock set; retry after active work finishes'
     USING ERRCODE='55P03';
   END IF;
  END;
  PERFORM pg_sleep(0.1);
 END LOOP;
END;
$$;
--> statement-breakpoint
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
 IF TG_OP='INSERT' AND NOT EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id
 ) THEN
  RAISE EXCEPTION 'Notice recipient employment is outside this tenant' USING ERRCODE='23514';
 END IF;
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
--> statement-breakpoint
-- Authentication and explicit SET ROLE are the connection authority. current_user alone could be
-- the owner of an intervening SECURITY DEFINER function and cannot establish this capability.
CREATE FUNCTION app.notice_projection_connection_owner() RETURNS boolean LANGUAGE sql STABLE
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH actor AS (
  SELECT session_user::text AS login,
   coalesce(nullif(nullif(current_setting('role',true),'none'),''),session_user::text) AS effective
 )
 SELECT login<>'ai_hr_app' AND effective<>'ai_hr_app' AND coalesce((
  SELECT count(*)=3 AND bool_and(
   (p.rolsuper OR p.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.effective::name,c.relowner,'USAGE')))
   AND (s.rolsuper OR s.rolbypassrls OR (NOT c.relforcerowsecurity AND pg_has_role(a.login::name,c.relowner,'USAGE'))))
  FROM pg_catalog.pg_roles p CROSS JOIN pg_catalog.pg_roles s CROSS JOIN pg_catalog.pg_class c
  WHERE p.rolname=a.effective::name AND s.rolname=a.login::name
   AND c.oid IN ('public.notice_recipient'::regclass,'public.domain_event'::regclass,'public.notification_cursor'::regclass)
 ),false) FROM actor a;
$$;
REVOKE ALL ON FUNCTION app.notice_projection_connection_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_projection_connection_owner() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_notice_event_scope() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owner_company uuid; storage_owner boolean;
BEGIN
 SELECT n.owner_company_id INTO owner_company FROM public.notice n
  WHERE n.id=NEW.aggregate_id AND n.tenant_id=NEW.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notice event parent is unavailable' USING ERRCODE='23514'; END IF;
 storage_owner:=app.notice_projection_connection_owner();
 IF NEW.event_type='notice.acknowledged' THEN
  IF NEW.actor_type<>'user' OR NOT app.notice_ack_event_valid(NEW.id,NEW.aggregate_id,NEW.actor_id,NEW.subject_employment_id,NEW.payload) THEN
   RAISE EXCEPTION 'Notice acknowledgement event requires its actual receipt' USING ERRCODE='42501';
  END IF;
 ELSIF NOT storage_owner AND NOT app.can_manage_notice(NEW.aggregate_id) THEN
  RAISE EXCEPTION 'Notice event is outside current authoring authority' USING ERRCODE='42501';
 END IF;
 IF NOT storage_owner AND (NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM app.current_user_id()) THEN
  RAISE EXCEPTION 'Notice event must name the actual author' USING ERRCODE='42501';
 END IF;
 IF NEW.payload IS NOT NULL AND jsonb_typeof(NEW.payload)<>'object' THEN
  RAISE EXCEPTION 'Notice event payload must be an object' USING ERRCODE='23514';
 END IF;
 NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)||jsonb_build_object('companyId',owner_company);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_notice_event_scope() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER a_notice_event_scope_guard BEFORE INSERT ON public.domain_event
 FOR EACH ROW WHEN(NEW.aggregate_type='notice' OR NEW.event_type LIKE 'notice.%')
 EXECUTE FUNCTION app.guard_notice_event_scope();
--> statement-breakpoint
CREATE FUNCTION app.notice_event_readable(p_notice uuid,p_payload jsonb) RETURNS boolean LANGUAGE plpgsql STABLE
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_tenant uuid; owner_company uuid; encoded text;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 SELECT n.tenant_id,n.owner_company_id INTO parent_tenant,owner_company FROM public.notice n WHERE n.id=p_notice;
 IF FOUND THEN
  IF parent_tenant IS DISTINCT FROM app.current_tenant_id() THEN RETURN false; END IF;
  RETURN (owner_company IS NULL AND app.is_group_admin()) OR
   (owner_company IS NOT NULL AND app.is_admin_for(owner_company));
 END IF;
 -- A new deleted draft has scope stamped from its real parent before deletion. An older orphan
 -- without that evidence remains group-only; current employee placements cannot establish its history.
 IF p_payload?'companyId' THEN
  IF p_payload->'companyId'='null'::jsonb THEN RETURN app.is_group_admin(); END IF;
  encoded:=p_payload->>'companyId';
  IF encoded~*'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN
   RETURN EXISTS(SELECT 1 FROM public.company c WHERE c.id=encoded::uuid
    AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id));
  END IF;
  RETURN false;
 END IF;
 RETURN app.is_group_admin();
END;
$$;
REVOKE ALL ON FUNCTION app.notice_event_readable(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_event_readable(uuid,jsonb) TO ai_hr_app;
CREATE POLICY notice_scoped_audit_read ON public.domain_event AS RESTRICTIVE FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND
  ((aggregate_type<>'notice' AND event_type NOT LIKE 'notice.%') OR app.notice_event_readable(aggregate_id,payload)));
--> statement-breakpoint
CREATE FUNCTION app.guard_notification_global_cursor() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changes_global boolean;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.tenant_id) IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id) THEN
  RAISE EXCEPTION 'Notification cursor identity is immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN changes_global:=NEW.last_sequence IS NOT NULL;
 ELSIF TG_OP='DELETE' THEN changes_global:=OLD.last_sequence IS NOT NULL;
 ELSE changes_global:=NEW.last_sequence IS DISTINCT FROM OLD.last_sequence;
 END IF;
 IF changes_global AND NOT app.notice_projection_connection_owner()
  AND NOT (app.principal_snapshot_current() AND app.is_group_admin()) THEN
  RAISE EXCEPTION 'Complete tenant notification projection authority is required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_notification_global_cursor() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notification_global_cursor_guard BEFORE INSERT OR UPDATE OR DELETE ON public.notification_cursor
 FOR EACH ROW EXECUTE FUNCTION app.guard_notification_global_cursor();
--> statement-breakpoint
ALTER TABLE public.notice
 ADD COLUMN summary text NOT NULL DEFAULT '',
 ADD COLUMN category text CHECK(category IS NULL OR length(btrim(category)) BETWEEN 1 AND 80),
 ADD COLUMN pinned boolean NOT NULL DEFAULT false,
 ADD COLUMN requires_acknowledgement boolean NOT NULL DEFAULT false,
 ADD COLUMN content_version integer NOT NULL DEFAULT 0 CHECK(content_version>=0),
 ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE TABLE public.notice_attachment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 notice_id uuid NOT NULL REFERENCES public.notice(id) ON DELETE CASCADE,upload_key uuid NOT NULL DEFAULT gen_random_uuid(),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180 AND file_name !~ '[[:cntrl:]/\\]'),
 mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','image/png','image/jpeg','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation')),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=10485760),
 content bytea NOT NULL CHECK(octet_length(content)=byte_length),
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notice_attachment_parent_idx ON public.notice_attachment(tenant_id,notice_id);
CREATE UNIQUE INDEX notice_attachment_upload_once_uq ON public.notice_attachment(tenant_id,notice_id,created_by_user_id,upload_key);
--> statement-breakpoint
CREATE TABLE public.notice_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 notice_id uuid NOT NULL REFERENCES public.notice(id),ordinal integer NOT NULL CHECK(ordinal>0),
 title text NOT NULL,body text NOT NULL,summary text NOT NULL,start_on date NOT NULL,end_on date NOT NULL,
 show_end_date boolean NOT NULL,requires_acknowledgement boolean NOT NULL,attachment_ids uuid[] NOT NULL,
 origin text NOT NULL CHECK(origin IN ('rollout','publication','edit','maintenance')),
 author_user_id uuid REFERENCES public.app_user(id),retained_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT notice_revision_author_check CHECK((origin IN ('rollout','maintenance') AND author_user_id IS NULL) OR (origin IN ('publication','edit') AND author_user_id IS NOT NULL)),
 CONSTRAINT notice_revision_ordinal_uq UNIQUE(tenant_id,notice_id,ordinal)
);
--> statement-breakpoint
CREATE TABLE public.notice_acknowledgement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 notice_id uuid NOT NULL REFERENCES public.notice(id),revision_id uuid NOT NULL REFERENCES public.notice_revision(id),content_version integer NOT NULL CHECK(content_version>0),
 recipient_id uuid NOT NULL REFERENCES public.notice_recipient(id),employment_id uuid NOT NULL REFERENCES public.employment(id),
 actor_user_id uuid NOT NULL REFERENCES public.app_user(id),acknowledged_at timestamptz NOT NULL DEFAULT now(),
 source_event_id uuid NOT NULL UNIQUE,request_context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(request_context)='object' AND octet_length(request_context::text)<=1024),
 recorded_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CONSTRAINT notice_acknowledgement_once_uq UNIQUE(revision_id,recipient_id)
);
CREATE INDEX notice_acknowledgement_parent_idx ON public.notice_acknowledgement(tenant_id,notice_id);
--> statement-breakpoint
-- This retains today's content at rollout. It does not claim that this was the content originally sent,
-- that a particular editor wrote it, or that any employee acknowledged it.
UPDATE public.notice SET content_version=1 WHERE published_at IS NOT NULL;
INSERT INTO public.notice_revision(tenant_id,notice_id,ordinal,title,body,summary,start_on,end_on,show_end_date,requires_acknowledgement,attachment_ids,origin)
 SELECT tenant_id,id,1,title,body,summary,start_on,end_on,show_end_date,requires_acknowledgement,attachment_ids,'rollout'
 FROM public.notice WHERE published_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.notice_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notice_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notice_acknowledgement ENABLE ROW LEVEL SECURITY;
CREATE POLICY notice_revision_author_read ON public.notice_revision FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.can_manage_notice(notice_id));
CREATE POLICY notice_acknowledgement_read ON public.notice_acknowledgement FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND
  (app.can_manage_notice(notice_id) OR EXISTS(SELECT 1 FROM public.employment e
   WHERE e.id=employment_id AND e.tenant_id=notice_acknowledgement.tenant_id AND app.is_self_person(e.person_id))));
CREATE POLICY notice_attachment_author ON public.notice_attachment FOR ALL
 USING(tenant_id=app.current_tenant_id() AND app.can_manage_notice(notice_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_manage_notice(notice_id) AND created_by_user_id=app.current_user_id());
CREATE POLICY notice_attachment_recipient ON public.notice_attachment FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND EXISTS(
  SELECT 1 FROM public.notice n JOIN public.notice_recipient nr ON nr.notice_id=n.id AND nr.tenant_id=n.tenant_id
  JOIN public.employment e ON e.id=nr.employment_id AND e.tenant_id=nr.tenant_id
  WHERE n.id=notice_attachment.notice_id AND n.tenant_id=notice_attachment.tenant_id
   AND notice_attachment.id=ANY(n.attachment_ids) AND app.is_self_person(e.person_id)
   AND n.published_at IS NOT NULL AND n.archived_at IS NULL
   AND n.start_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND n.end_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 ));
GRANT SELECT ON public.notice_revision,public.notice_acknowledgement TO ai_hr_app;
GRANT SELECT,INSERT ON public.notice_attachment TO ai_hr_app;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.notice_revision,public.notice_acknowledgement FROM PUBLIC,ai_hr_app;
REVOKE UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.notice_attachment FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_notice_retained_record() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='notice_attachment' AND TG_OP='DELETE' AND NOT EXISTS(
  SELECT 1 FROM public.notice_revision r WHERE r.notice_id=OLD.notice_id AND OLD.id=ANY(r.attachment_ids)
 ) THEN RETURN OLD;END IF;
 RAISE EXCEPTION 'Retain immutable Notice content and acknowledgement evidence' USING ERRCODE='23514';
END;
$$;
REVOKE ALL ON FUNCTION app.guard_notice_retained_record() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_revision_immutable BEFORE UPDATE OR DELETE ON public.notice_revision
 FOR EACH ROW EXECUTE FUNCTION app.guard_notice_retained_record();
CREATE TRIGGER notice_acknowledgement_immutable BEFORE UPDATE OR DELETE ON public.notice_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION app.guard_notice_retained_record();
CREATE TRIGGER notice_attachment_immutable BEFORE UPDATE OR DELETE ON public.notice_attachment
 FOR EACH ROW EXECUTE FUNCTION app.guard_notice_retained_record();
--> statement-breakpoint
CREATE FUNCTION app.prepare_notice_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
 IF cardinality(NEW.attachment_ids)>5 OR cardinality(NEW.attachment_ids)<>(SELECT count(DISTINCT a) FROM unnest(NEW.attachment_ids) a)
  OR EXISTS(SELECT 1 FROM unnest(NEW.attachment_ids) a WHERE a IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.notice_attachment f WHERE f.id=a AND f.notice_id=NEW.id AND f.tenant_id=NEW.tenant_id)) THEN
  RAISE EXCEPTION 'Choose at most five attachments owned by this Notice' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.published_at IS NOT NULL AND NOT app.notice_projection_connection_owner() THEN
   RAISE EXCEPTION 'Publish a saved Notice draft through the audience workflow' USING ERRCODE='23514';
  END IF;
  NEW.content_version:=CASE WHEN NEW.published_at IS NULL THEN 0 ELSE 1 END;RETURN NEW;
 END IF;
 changed:=ROW(NEW.title,NEW.body,NEW.summary,NEW.start_on,NEW.end_on,NEW.show_end_date,NEW.requires_acknowledgement,NEW.attachment_ids)
  IS DISTINCT FROM ROW(OLD.title,OLD.body,OLD.summary,OLD.start_on,OLD.end_on,OLD.show_end_date,OLD.requires_acknowledgement,OLD.attachment_ids);
 IF OLD.published_at IS NULL THEN NEW.content_version:=CASE WHEN NEW.published_at IS NULL THEN 0 ELSE 1 END;
 ELSE NEW.content_version:=OLD.content_version+CASE WHEN changed THEN 1 ELSE 0 END;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.prepare_notice_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_revision_pointer BEFORE INSERT OR UPDATE ON public.notice
 FOR EACH ROW EXECUTE FUNCTION app.prepare_notice_revision();
--> statement-breakpoint
CREATE FUNCTION app.capture_notice_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE kind text; author uuid;
BEGIN
 IF NEW.published_at IS NULL OR (TG_OP='UPDATE' AND NEW.content_version=OLD.content_version) THEN RETURN NEW;END IF;
 IF app.principal_snapshot_current() AND app.can_manage_notice(NEW.id) THEN
  author:=app.current_user_id();kind:=CASE WHEN TG_OP='INSERT' OR OLD.published_at IS NULL THEN 'publication' ELSE 'edit' END;
 ELSIF app.notice_projection_connection_owner() THEN kind:='maintenance';
 ELSE RAISE EXCEPTION 'Current Notice authoring authority is required' USING ERRCODE='42501';END IF;
 INSERT INTO public.notice_revision(tenant_id,notice_id,ordinal,title,body,summary,start_on,end_on,show_end_date,requires_acknowledgement,attachment_ids,origin,author_user_id)
 VALUES(NEW.tenant_id,NEW.id,NEW.content_version,NEW.title,NEW.body,NEW.summary,NEW.start_on,NEW.end_on,NEW.show_end_date,NEW.requires_acknowledgement,NEW.attachment_ids,kind,author);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.capture_notice_revision() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_revision_capture AFTER INSERT OR UPDATE ON public.notice
 FOR EACH ROW EXECUTE FUNCTION app.capture_notice_revision();
--> statement-breakpoint
-- A receipt can be created only by this purpose-bound command. It locks the same Notice parent as
-- content edits, verifies the actual current principal and employment snapshot, and commits its event
-- in the same transaction. No callback, proposed actor, timestamp or client-controlled privilege flag.
CREATE FUNCTION app.acknowledge_notice(p_notice uuid,p_version integer,p_employment uuid,p_context jsonb DEFAULT '{}')
 RETURNS TABLE(receipt_id uuid,content_version integer,acknowledged_at timestamptz) LANGUAGE plpgsql
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n public.notice%ROWTYPE;r public.notice_revision%ROWTYPE;recipient public.notice_recipient%ROWTYPE;
 receipt public.notice_acknowledgement%ROWTYPE; event_id uuid:=gen_random_uuid();day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND app.is_self_person(e.person_id)
 ) THEN RAISE EXCEPTION 'Notice acknowledgement is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO n FROM public.notice WHERE id=p_notice AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notice acknowledgement is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO recipient FROM public.notice_recipient WHERE notice_id=n.id AND tenant_id=n.tenant_id AND employment_id=p_employment;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notice acknowledgement is unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM public.notice_revision WHERE notice_id=n.id AND tenant_id=n.tenant_id AND ordinal=p_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notice content changed; reload before acknowledging' USING ERRCODE='23514';END IF;
 SELECT * INTO receipt FROM public.notice_acknowledgement WHERE revision_id=r.id AND recipient_id=recipient.id;
 IF FOUND THEN RETURN QUERY SELECT receipt.id,r.ordinal,receipt.acknowledged_at;RETURN;END IF;
 IF p_version IS DISTINCT FROM n.content_version OR NOT n.requires_acknowledgement OR n.published_at IS NULL OR n.archived_at IS NOT NULL
  OR n.start_on>day OR n.end_on<day THEN
  RAISE EXCEPTION 'Notice content changed or is no longer available; reload before acknowledging' USING ERRCODE='23514';
 END IF;
 IF p_context IS NULL OR jsonb_typeof(p_context)<>'object' OR octet_length(p_context::text)>1024
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_context) k WHERE k NOT IN ('reportedChannel','reportedUserAgent'))
  OR EXISTS(SELECT 1 FROM jsonb_each(p_context) x WHERE jsonb_typeof(x.value)<>'string') THEN
  RAISE EXCEPTION 'Notice acknowledgement request context is invalid' USING ERRCODE='23514';END IF;
 INSERT INTO public.notice_acknowledgement(tenant_id,notice_id,revision_id,content_version,recipient_id,employment_id,actor_user_id,source_event_id,request_context)
 VALUES(n.tenant_id,n.id,r.id,r.ordinal,recipient.id,p_employment,app.current_user_id(),event_id,p_context) RETURNING * INTO receipt;
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(event_id,n.tenant_id,'notice',n.id,'notice.acknowledged','user',app.current_user_id(),p_employment,
  jsonb_build_object('receiptId',receipt.id,'contentVersion',r.ordinal));
 RETURN QUERY SELECT receipt.id,r.ordinal,receipt.acknowledged_at;
END;
$$;
REVOKE ALL ON FUNCTION app.acknowledge_notice(uuid,integer,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.acknowledge_notice(uuid,integer,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.notice_ack_event_valid(p_event uuid,p_notice uuid,p_actor uuid,p_employment uuid,p_payload jsonb)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND p_actor=app.current_user_id() AND EXISTS(
  SELECT 1 FROM public.notice_acknowledgement a JOIN public.notice_revision r ON r.id=a.revision_id AND r.tenant_id=a.tenant_id
  WHERE a.source_event_id=p_event AND a.notice_id=p_notice AND a.tenant_id=app.current_tenant_id()
   AND a.actor_user_id=p_actor AND a.employment_id=p_employment AND a.recorded_xid=pg_current_xact_id()
   AND p_payload->>'receiptId'=a.id::text AND p_payload->'contentVersion'=to_jsonb(r.ordinal)
 );
$$;
REVOKE ALL ON FUNCTION app.notice_ack_event_valid(uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_ack_event_valid(uuid,uuid,uuid,uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER POLICY notice_scoped_audit_read ON public.domain_event
 USING(tenant_id=app.current_tenant_id() AND
  ((aggregate_type<>'notice' AND event_type NOT LIKE 'notice.%') OR app.notice_event_readable(aggregate_id,payload)
   OR (event_type='notice.acknowledged' AND (SELECT app.principal_snapshot_current()) AND EXISTS(
    SELECT 1 FROM public.notice_acknowledgement a WHERE a.source_event_id=domain_event.id AND a.tenant_id=domain_event.tenant_id
     AND a.actor_user_id=app.current_user_id()))));
--> statement-breakpoint
-- Keep each new evidence relationship physically tenant/parent/version-consistent as well as
-- purpose-bound at its writer. The receipt precedes its event inside one command, so only that FK
-- is deferred until the transaction commits; interrupted commands cannot leave unaudited evidence.
ALTER TABLE public.notice ADD CONSTRAINT notice_identity_tenant_uq UNIQUE(id,tenant_id);
ALTER TABLE public.notice_recipient ADD CONSTRAINT notice_recipient_evidence_identity_uq UNIQUE(id,notice_id,tenant_id,employment_id);
ALTER TABLE public.notice_revision ADD CONSTRAINT notice_revision_evidence_identity_uq UNIQUE(id,notice_id,tenant_id,ordinal);
ALTER TABLE public.notice_revision ADD CONSTRAINT notice_revision_parent_tenant_fk FOREIGN KEY(notice_id,tenant_id) REFERENCES public.notice(id,tenant_id);
ALTER TABLE public.notice_attachment ADD CONSTRAINT notice_attachment_parent_tenant_fk FOREIGN KEY(notice_id,tenant_id) REFERENCES public.notice(id,tenant_id) ON DELETE CASCADE;
ALTER TABLE public.notice_acknowledgement ADD CONSTRAINT notice_acknowledgement_revision_identity_fk
 FOREIGN KEY(revision_id,notice_id,tenant_id,content_version) REFERENCES public.notice_revision(id,notice_id,tenant_id,ordinal);
ALTER TABLE public.notice_acknowledgement ADD CONSTRAINT notice_acknowledgement_recipient_identity_fk
 FOREIGN KEY(recipient_id,notice_id,tenant_id,employment_id) REFERENCES public.notice_recipient(id,notice_id,tenant_id,employment_id);
ALTER TABLE public.notice_acknowledgement ADD CONSTRAINT notice_acknowledgement_event_fk
 FOREIGN KEY(source_event_id) REFERENCES public.domain_event(id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION app.guard_notice_attachment_insert() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.can_manage_notice(NEW.notice_id) OR NEW.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Current Notice authoring authority is required for attachments' USING ERRCODE='42501';END IF;
 NEW.created_at:=clock_timestamp();RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_notice_attachment_insert() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER notice_attachment_insert_evidence BEFORE INSERT ON public.notice_attachment
 FOR EACH ROW EXECUTE FUNCTION app.guard_notice_attachment_insert();
--> statement-breakpoint
-- The sender's display identity is Notice metadata. Do not widen app_user/person policies merely to
-- display it to a live recipient. This function exposes only the named notice's actual publisher.
CREATE FUNCTION app.notice_sender_display_name(p_notice uuid) RETURNS text LANGUAGE plpgsql STABLE
 SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result text;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN NULL;END IF;
 SELECT p.full_name INTO result FROM public.notice n
 JOIN public.app_user u ON u.id=n.published_by_user_id AND u.tenant_id=n.tenant_id
 JOIN public.person p ON p.id=u.person_id AND p.tenant_id=n.tenant_id
 WHERE n.id=p_notice AND n.tenant_id=app.current_tenant_id() AND (app.can_manage_notice(n.id) OR
  (n.published_at IS NOT NULL AND n.archived_at IS NULL
   AND n.start_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND n.end_on>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND EXISTS(SELECT 1 FROM public.notice_recipient nr JOIN public.employment e ON e.id=nr.employment_id AND e.tenant_id=nr.tenant_id
    WHERE nr.notice_id=n.id AND nr.tenant_id=n.tenant_id AND app.is_self_person(e.person_id))));
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.notice_sender_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notice_sender_display_name(uuid) TO ai_hr_app;
