-- ADR0126. Explicit current-company Home policy versions, own sharing and WFH requests.
-- No policy/consent means disabled/private. Existing Attendance/Leave remain authoritative.
CREATE UNIQUE INDEX IF NOT EXISTS home_employment_tenant_ref ON employment(id,tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS home_company_tenant_ref ON company(id,tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS home_user_tenant_ref ON app_user(id,tenant_id);
--> statement-breakpoint
CREATE TABLE home_company_policy(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),wfh_enabled boolean NOT NULL DEFAULT false,wfh_approval_required boolean NOT NULL DEFAULT true,
 availability_enabled boolean NOT NULL DEFAULT false,birthdays_enabled boolean NOT NULL DEFAULT false,anniversaries_enabled boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),superseded_at timestamptz,
 FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id),FOREIGN KEY(created_by,tenant_id) REFERENCES app_user(id,tenant_id),
 UNIQUE(company_id,revision),UNIQUE(id,tenant_id,company_id));
CREATE UNIQUE INDEX home_policy_current_uq ON home_company_policy(company_id) WHERE superseded_at IS NULL;
CREATE TABLE home_sharing(
 employment_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenant(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 availability boolean NOT NULL DEFAULT false,birthday boolean NOT NULL DEFAULT false,anniversary boolean NOT NULL DEFAULT false,
 week_starts_on integer NOT NULL DEFAULT 1 CHECK(week_starts_on IN(0,1)),updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(updated_by,tenant_id) REFERENCES app_user(id,tenant_id));
CREATE TABLE home_wfh_request(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL,company_id uuid NOT NULL,policy_id uuid NOT NULL,
 from_date date NOT NULL,to_date date NOT NULL,status text NOT NULL CHECK(status IN('pending','approved','rejected','cancelled')),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 requested_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),decided_by uuid,decided_at timestamptz,
 CHECK(to_date>=from_date AND to_date-from_date<31),CHECK((decided_by IS NULL)=(decided_at IS NULL)),
 FOREIGN KEY(employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(company_id,tenant_id) REFERENCES company(id,tenant_id),
 FOREIGN KEY(policy_id,tenant_id,company_id) REFERENCES home_company_policy(id,tenant_id,company_id),
 FOREIGN KEY(requested_by,tenant_id) REFERENCES app_user(id,tenant_id),FOREIGN KEY(decided_by,tenant_id) REFERENCES app_user(id,tenant_id));
CREATE INDEX home_wfh_subject_date_idx ON home_wfh_request(employment_id,from_date,to_date);
CREATE TABLE home_greeting(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),sender_employment_id uuid NOT NULL,recipient_employment_id uuid NOT NULL,
 sender_user_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('birthday','anniversary')),moment_date date NOT NULL,message text CHECK(length(btrim(message)) BETWEEN 1 AND 500),message_digest text NOT NULL CHECK(message_digest~'^[0-9a-f]{64}$'),redacted_at timestamptz,CHECK((message IS NULL)=(redacted_at IS NOT NULL)),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(sender_employment_id<>recipient_employment_id),FOREIGN KEY(sender_employment_id,tenant_id) REFERENCES employment(id,tenant_id),
 FOREIGN KEY(recipient_employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(sender_user_id,tenant_id) REFERENCES app_user(id,tenant_id));
CREATE INDEX home_greeting_recipient_idx ON home_greeting(recipient_employment_id,created_at);
CREATE TABLE home_insight_dismissal(tenant_id uuid NOT NULL REFERENCES tenant(id),app_user_id uuid NOT NULL,source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 200),business_date date NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,app_user_id,source_key,business_date),FOREIGN KEY(app_user_id,tenant_id) REFERENCES app_user(id,tenant_id));
--> statement-breakpoint
-- Exact dated company/tenure proof; no employment.current-company compatibility fallback.
-- This SQL backstop mirrors the canonical strict dated-company owner, not the legacy payroll resolver.
CREATE FUNCTION app.home_company_on(subject uuid,d date) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN count(a.id)=1 THEN (array_agg(a.company_id))[1] END
 FROM public.employment e LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=d AND(a.valid_to IS NULL OR a.valid_to>d)
 WHERE e.id=subject AND e.tenant_id=app.current_tenant_id() AND e.hired_on<=d AND(e.terminated_on IS NULL OR e.terminated_on>=d);
$$;
CREATE FUNCTION app.home_own_live(subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=subject AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND(LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND app.home_company_on(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) IS NOT NULL);
$$;
-- One explicit audience: live own same-company department peers. No recursive management or arbitrary company scopes.
CREATE FUNCTION app.home_peer(viewer uuid,subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT viewer<>subject AND app.home_own_live(viewer) AND app.home_company_on(viewer,t.d)=app.home_company_on(subject,t.d)
 AND EXISTS(SELECT 1 FROM public.assignment va JOIN public.assignment sa ON sa.department_id=va.department_id AND sa.tenant_id=va.tenant_id
 JOIN public.employment e ON e.id=sa.employment_id AND e.tenant_id=sa.tenant_id
 WHERE va.employment_id=viewer AND sa.employment_id=subject AND va.tenant_id=app.current_tenant_id() AND va.department_id IS NOT NULL
 AND va.superseded_at IS NULL AND sa.superseded_at IS NULL AND va.valid_from<=t.d AND(sa.valid_to IS NULL OR sa.valid_to>t.d) AND sa.valid_from<=t.d AND(va.valid_to IS NULL OR va.valid_to>t.d)
 AND e.blacklisted_at IS NULL AND (LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>=t.d))
 FROM(SELECT(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date d)t;
$$;
CREATE FUNCTION app.home_can_decide(subject uuid,co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND NOT app.home_own_live(subject) AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject AND e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL AND(LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) AND app.home_company_on(subject,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)=co
 AND(app.is_admin_for(co) OR EXISTS(SELECT 1 FROM app.attendance_workflow_manager(subject) manager JOIN public.employment own ON own.id=manager.employment_id AND own.tenant_id=app.current_tenant_id() JOIN public.app_user u ON u.person_id=own.person_id AND u.tenant_id=own.tenant_id WHERE u.id=app.current_user_id()));
$$;
--> statement-breakpoint
ALTER TABLE home_company_policy ENABLE ROW LEVEL SECURITY;ALTER TABLE home_company_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY home_policy_read ON home_company_policy FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.is_admin_for(company_id) OR EXISTS(SELECT 1 FROM public.employment e WHERE app.home_own_live(e.id) AND app.home_company_on(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)=company_id)));
CREATE POLICY home_policy_insert ON home_company_policy FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.is_admin_for(company_id));
CREATE POLICY home_policy_update ON home_company_policy FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
ALTER TABLE home_sharing ENABLE ROW LEVEL SECURITY;ALTER TABLE home_sharing FORCE ROW LEVEL SECURITY;
CREATE POLICY home_sharing_self ON home_sharing FOR ALL USING(tenant_id=app.current_tenant_id() AND app.home_own_live(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.home_own_live(employment_id) AND updated_by=app.current_user_id());
ALTER TABLE home_wfh_request ENABLE ROW LEVEL SECURITY;ALTER TABLE home_wfh_request FORCE ROW LEVEL SECURITY;
CREATE POLICY home_wfh_read ON home_wfh_request FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.home_own_live(employment_id) OR app.home_can_decide(employment_id,company_id)));
CREATE POLICY home_wfh_create ON home_wfh_request FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.home_own_live(employment_id) AND requested_by=app.current_user_id());
CREATE POLICY home_wfh_decide ON home_wfh_request FOR UPDATE USING(tenant_id=app.current_tenant_id() AND(app.home_own_live(employment_id) OR app.home_can_decide(employment_id,company_id))) WITH CHECK(tenant_id=app.current_tenant_id() AND(app.home_own_live(employment_id) OR app.home_can_decide(employment_id,company_id)));
ALTER TABLE home_greeting ENABLE ROW LEVEL SECURITY;ALTER TABLE home_greeting FORCE ROW LEVEL SECURITY;
CREATE POLICY home_greeting_read ON home_greeting FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.home_own_live(sender_employment_id) OR app.home_own_live(recipient_employment_id)));
CREATE POLICY home_greeting_send ON home_greeting FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND sender_user_id=app.current_user_id() AND app.home_own_live(sender_employment_id));
ALTER TABLE home_insight_dismissal ENABLE ROW LEVEL SECURITY;ALTER TABLE home_insight_dismissal FORCE ROW LEVEL SECURITY;
CREATE POLICY home_dismissal_self ON home_insight_dismissal FOR ALL USING(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
REVOKE ALL ON home_company_policy,home_sharing,home_wfh_request,home_greeting,home_insight_dismissal FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON home_company_policy,home_sharing,home_wfh_request TO ai_hr_app;
GRANT SELECT,INSERT ON home_greeting,home_insight_dismissal TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_owns_company(co uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND app.home_own_live(e.id) AND app.home_company_on(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)=co);
$$;
DROP POLICY home_policy_read ON home_company_policy;
CREATE POLICY home_policy_read ON home_company_policy FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.is_admin_for(company_id) OR app.home_owns_company(company_id)));
--> statement-breakpoint
-- Only purpose-specific minimal projections can cross ordinary Personnel RLS, never raw DOB/contact/pay.
CREATE FUNCTION app.home_moments(viewer uuid,from_day date,to_day date)
RETURNS TABLE(employment_id uuid,full_name text,moment_date date,kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.home_own_live(viewer) OR from_day<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR to_day<from_day OR to_day-from_day>7 THEN RETURN;END IF;
 RETURN QUERY SELECT e.id,p.full_name,d.day::date,k.kind FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.home_sharing sh ON sh.employment_id=e.id AND sh.tenant_id=e.tenant_id
 JOIN public.home_company_policy policy ON policy.company_id=app.home_company_on(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND policy.tenant_id=e.tenant_id AND policy.superseded_at IS NULL
 CROSS JOIN generate_series(from_day::timestamp,to_day::timestamp,interval '1 day')d(day)
 CROSS JOIN(VALUES('birthday'::text),('anniversary'::text))k(kind)
 WHERE e.tenant_id=app.current_tenant_id() AND app.home_peer(viewer,e.id)
 AND((k.kind='birthday' AND policy.birthdays_enabled AND sh.birthday AND to_char(p.date_of_birth,'MM-DD')=to_char(d.day,'MM-DD'))
 OR(k.kind='anniversary' AND policy.anniversaries_enabled AND sh.anniversary AND e.hired_on<d.day::date AND to_char(e.hired_on,'MM-DD')=to_char(d.day,'MM-DD')))
 ORDER BY d.day,e.id,k.kind LIMIT 101;
END;$$;
CREATE FUNCTION app.home_availability(viewer uuid)
RETURNS TABLE(employment_id uuid,full_name text,status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,p.full_name,CASE
 WHEN EXISTS(SELECT 1 FROM public.leave_request_date rd JOIN public.leave_request lr ON lr.id=rd.leave_request_id AND lr.tenant_id=rd.tenant_id WHERE lr.employment_id=e.id AND lr.tenant_id=e.tenant_id AND lr.status='approved' AND rd.status='approved' AND rd.leave_date=t.d) THEN 'leave'
 WHEN EXISTS(SELECT 1 FROM public.leave_request lr WHERE lr.employment_id=e.id AND lr.tenant_id=e.tenant_id AND lr.status='approved' AND lr.start_date<=t.d AND lr.end_date>=t.d) THEN 'unknown'
 WHEN EXISTS(SELECT 1 FROM public.home_wfh_request w WHERE w.employment_id=e.id AND w.tenant_id=e.tenant_id AND w.company_id=policy.company_id AND w.status='approved' AND w.from_date<=t.d AND w.to_date>=t.d) AND policy.wfh_enabled THEN 'wfh'
 WHEN EXISTS(SELECT 1 FROM public.attendance a JOIN public.attendance_clock_capture c ON c.employment_id=a.employment_id AND c.tenant_id=a.tenant_id AND c.attendance_date=a.attendance_date WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.attendance_date=t.d AND a.check_in_at IS NOT NULL AND a.check_out_at IS NULL AND c.direction='in' AND c.clocking_location_id IS NOT NULL AND c.geofencing_required IS TRUE AND NOT EXISTS(SELECT 1 FROM public.attendance_clock_capture newer WHERE newer.employment_id=c.employment_id AND newer.attendance_date=c.attendance_date AND newer.tenant_id=c.tenant_id AND newer.server_recorded_at>c.server_recorded_at)) THEN 'office'
 ELSE 'unknown' END
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.home_sharing sh ON sh.employment_id=e.id AND sh.tenant_id=e.tenant_id AND sh.availability
 CROSS JOIN(SELECT(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date d)t
 JOIN public.home_company_policy policy ON policy.company_id=app.home_company_on(e.id,t.d) AND policy.tenant_id=e.tenant_id AND policy.superseded_at IS NULL AND policy.availability_enabled
 WHERE e.tenant_id=app.current_tenant_id() AND app.home_peer(viewer,e.id) ORDER BY p.full_name,e.id LIMIT 101;
$$;
--> statement-breakpoint
CREATE FUNCTION app.home_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy public.home_company_policy;company_on uuid;d date;
BEGIN
 -- Only the bounded erasure helper has UPDATE privilege. No caller flag or mutable-history grant.
 IF TG_TABLE_NAME='home_greeting' AND TG_OP='UPDATE' THEN
  IF OLD.tenant_id=app.current_tenant_id() AND app.is_admin() AND OLD.redacted_at IS NULL AND NEW.redacted_at=now() AND NEW.message IS NULL
   AND (to_jsonb(NEW)-ARRAY['message','redacted_at'])=(to_jsonb(OLD)-ARRAY['message','redacted_at'])
   AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=OLD.tenant_id AND e.id IN(OLD.sender_employment_id,OLD.recipient_employment_id) AND app.is_admin_for(e.company_id))
  THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Greeting evidence is immutable';
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Home history is retained';END IF;
 IF NEW.tenant_id<>app.current_tenant_id() OR app.current_user_id() IS NULL OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Home authority unavailable';END IF;
 IF TG_TABLE_NAME='home_company_policy' THEN
  IF NOT app.is_admin_for(NEW.company_id) THEN RAISE EXCEPTION 'Company administration required';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('home-policy:'||NEW.tenant_id||':'||NEW.company_id,0));
  IF TG_OP='INSERT' THEN NEW.created_at:=now();END IF;
  IF TG_OP='UPDATE' THEN NEW.superseded_at:=now();IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR (to_jsonb(NEW)-'superseded_at')<>(to_jsonb(OLD)-'superseded_at') THEN RAISE EXCEPTION 'Policy versions are immutable';END IF;
  ELSIF NEW.created_by<>app.current_user_id() OR NEW.superseded_at IS NOT NULL OR NEW.revision<>COALESCE((SELECT max(revision)+1 FROM public.home_company_policy WHERE company_id=NEW.company_id AND tenant_id=NEW.tenant_id),1) THEN RAISE EXCEPTION 'Policy version changed';END IF;
 ELSIF TG_TABLE_NAME='home_sharing' THEN
  NEW.updated_at:=now();
  IF NOT app.home_own_live(NEW.employment_id) OR NEW.updated_by<>app.current_user_id() THEN RAISE EXCEPTION 'Own sharing only';END IF;
  IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'Initial sharing revision required';END IF;
  IF TG_OP='UPDATE' AND(NEW.employment_id<>OLD.employment_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'Sharing revision changed';END IF;
 ELSIF TG_TABLE_NAME='home_wfh_request' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('home-wfh:'||NEW.tenant_id||':'||NEW.employment_id,0));
  SELECT * INTO policy FROM public.home_company_policy WHERE company_id=NEW.company_id AND tenant_id=NEW.tenant_id AND superseded_at IS NULL FOR SHARE NOWAIT;
  IF TG_OP='INSERT' THEN
   NEW.created_at:=now();
   IF NOT app.home_own_live(NEW.employment_id) OR policy.id IS NULL OR NOT policy.wfh_enabled OR NEW.policy_id<>policy.id OR NEW.requested_by<>app.current_user_id() OR NEW.revision<>1 OR NEW.from_date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NEW.to_date>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date+366 OR NEW.status<>CASE WHEN policy.wfh_approval_required THEN 'pending' ELSE 'approved' END OR NEW.decided_by IS NOT NULL THEN RAISE EXCEPTION 'Home-working policy unavailable';END IF;
  ELSE
   IF (to_jsonb(NEW)-ARRAY['status','revision','decided_by','decided_at'])<>(to_jsonb(OLD)-ARRAY['status','revision','decided_by','decided_at']) OR NEW.revision<>OLD.revision+1 OR OLD.status NOT IN('pending','approved') THEN RAISE EXCEPTION 'Request binding changed';END IF;
   IF NEW.status='cancelled' THEN IF OLD.status='approved' AND OLD.from_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'An effective arrangement cannot be cancelled retrospectively';END IF;IF NOT app.home_own_live(NEW.employment_id) OR NEW.decided_by<>app.current_user_id() THEN RAISE EXCEPTION 'Own cancellation only';END IF;
   ELSIF OLD.status<>'pending' OR NEW.status NOT IN('approved','rejected') OR NOT app.home_can_decide(NEW.employment_id,NEW.company_id) OR NEW.decided_by<>app.current_user_id() OR policy.id IS NULL OR NOT policy.wfh_enabled OR policy.id<>NEW.policy_id THEN RAISE EXCEPTION 'Decision authority or policy changed';END IF;
   IF NEW.status='approved' AND NEW.from_date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Home-working approval cannot backdate an arrangement';END IF;
   NEW.decided_at:=now();
   IF NEW.decided_at IS NULL THEN RAISE EXCEPTION 'Decision evidence required';END IF;
  END IF;
  IF NEW.status IN('pending','approved') THEN
   FOR d IN SELECT generate_series(NEW.from_date::timestamp,NEW.to_date::timestamp,interval '1 day')::date LOOP
    company_on:=app.home_company_on(NEW.employment_id,d);IF company_on IS DISTINCT FROM NEW.company_id THEN RAISE EXCEPTION 'Dated company unavailable';END IF;
   END LOOP;
   IF EXISTS(SELECT 1 FROM public.home_wfh_request w WHERE w.tenant_id=NEW.tenant_id AND w.employment_id=NEW.employment_id AND w.id<>NEW.id AND w.status IN('pending','approved') AND w.from_date<=NEW.to_date AND w.to_date>=NEW.from_date) THEN RAISE EXCEPTION 'Home-working request overlaps';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='home_greeting' THEN
  NEW.created_at:=now();
  IF NEW.redacted_at IS NOT NULL OR NEW.message IS NULL THEN RAISE EXCEPTION 'Greeting content required';END IF;
  NEW.message_digest:=encode(public.digest(convert_to(NEW.message,'UTF8'),'sha256'),'hex');
  PERFORM p.id FROM public.person p WHERE p.tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=p.tenant_id AND e.id IN(NEW.sender_employment_id,NEW.recipient_employment_id)) ORDER BY p.id FOR SHARE NOWAIT;
  PERFORM id FROM public.employment WHERE id=NEW.recipient_employment_id AND tenant_id=NEW.tenant_id FOR SHARE NOWAIT;
  PERFORM employment_id FROM public.home_sharing WHERE employment_id=NEW.recipient_employment_id AND tenant_id=NEW.tenant_id FOR SHARE NOWAIT;
  PERFORM id FROM public.home_company_policy WHERE company_id=app.home_company_on(NEW.recipient_employment_id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND tenant_id=NEW.tenant_id AND superseded_at IS NULL FOR SHARE NOWAIT;
  IF TG_OP<>'INSERT' OR NEW.sender_user_id<>app.current_user_id() OR NOT EXISTS(SELECT 1 FROM app.home_moments(NEW.sender_employment_id,NEW.moment_date,NEW.moment_date)m WHERE m.employment_id=NEW.recipient_employment_id AND m.kind=NEW.kind) THEN RAISE EXCEPTION 'Greeting recipient unavailable';END IF;
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER home_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON home_company_policy FOR EACH ROW EXECUTE FUNCTION app.home_guard();
CREATE TRIGGER home_sharing_guard BEFORE INSERT OR UPDATE OR DELETE ON home_sharing FOR EACH ROW EXECUTE FUNCTION app.home_guard();
CREATE TRIGGER home_wfh_guard BEFORE INSERT OR UPDATE OR DELETE ON home_wfh_request FOR EACH ROW EXECUTE FUNCTION app.home_guard();
CREATE TRIGGER home_greeting_guard BEFORE INSERT OR UPDATE OR DELETE ON home_greeting FOR EACH ROW EXECUTE FUNCTION app.home_guard();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.home_company_on(uuid,date),app.home_guard(),app.home_own_live(uuid),app.home_peer(uuid,uuid),app.home_can_decide(uuid,uuid),app.home_owns_company(uuid),app.home_moments(uuid,date,date),app.home_availability(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.home_own_live(uuid),app.home_can_decide(uuid,uuid),app.home_owns_company(uuid),app.home_moments(uuid,date,date),app.home_availability(uuid) TO ai_hr_app;

--> statement-breakpoint
ALTER TABLE notice ADD COLUMN pinned boolean NOT NULL DEFAULT false,ADD COLUMN category text NOT NULL DEFAULT 'general' CHECK(category IN('general','holiday','benefits','policy')),ADD COLUMN requires_acknowledgement boolean NOT NULL DEFAULT false;
UPDATE notice SET requires_acknowledgement=true WHERE popup_enabled AND popup_frequency='until_acknowledged';
CREATE UNIQUE INDEX IF NOT EXISTS home_notice_tenant_ref ON notice(id,tenant_id);
CREATE TABLE notice_acknowledgement(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),notice_id uuid NOT NULL,employment_id uuid NOT NULL,app_user_id uuid NOT NULL,
 content_digest text NOT NULL CHECK(content_digest~'^[0-9a-f]{64}$'),title_snapshot text,body_snapshot text CHECK(octet_length(body_snapshot)<=262144),redacted_at timestamptz,CHECK((redacted_at IS NULL AND title_snapshot IS NOT NULL AND body_snapshot IS NOT NULL) OR (redacted_at IS NOT NULL AND title_snapshot IS NULL AND body_snapshot IS NULL)),acknowledged_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(notice_id,tenant_id) REFERENCES notice(id,tenant_id),FOREIGN KEY(employment_id,tenant_id) REFERENCES employment(id,tenant_id),FOREIGN KEY(app_user_id,tenant_id) REFERENCES app_user(id,tenant_id),UNIQUE(notice_id,employment_id,content_digest));
CREATE FUNCTION app.notice_content_digest(title text,body text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$SELECT encode(public.digest(convert_to(jsonb_build_array(title,body)::text,'UTF8'),'sha256'),'hex');$$;
CREATE FUNCTION app.home_notice_ack_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n public.notice;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.tenant_id=app.current_tenant_id() AND app.is_admin() AND OLD.redacted_at IS NULL AND NEW.redacted_at=now() AND NEW.title_snapshot IS NULL AND NEW.body_snapshot IS NULL
   AND (to_jsonb(NEW)-ARRAY['title_snapshot','body_snapshot','redacted_at'])=(to_jsonb(OLD)-ARRAY['title_snapshot','body_snapshot','redacted_at'])
   AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=OLD.employment_id AND e.tenant_id=OLD.tenant_id AND app.is_admin_for(e.company_id))
  THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Acknowledgement evidence is immutable';
 END IF;
 IF NEW.redacted_at IS NOT NULL THEN RAISE EXCEPTION 'Acknowledgement content required';END IF;
 IF TG_OP<>'INSERT' OR NEW.tenant_id<>app.current_tenant_id() OR NEW.app_user_id<>app.current_user_id() OR NOT app.home_own_live(NEW.employment_id) THEN RAISE EXCEPTION 'Own explicit acknowledgement required';END IF;
 PERFORM p.id FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id FOR SHARE OF p NOWAIT;
 SELECT * INTO n FROM public.notice WHERE id=NEW.notice_id AND tenant_id=NEW.tenant_id FOR SHARE;
 IF n.id IS NULL OR n.published_at IS NULL OR n.archived_at IS NOT NULL OR NOT n.requires_acknowledgement OR n.start_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR n.end_on<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Notice acknowledgement unavailable';END IF;
 PERFORM id FROM public.notice_recipient WHERE notice_id=NEW.notice_id AND employment_id=NEW.employment_id AND tenant_id=NEW.tenant_id FOR SHARE;
 IF NOT FOUND OR NEW.content_digest<>app.notice_content_digest(n.title,n.body) OR NEW.title_snapshot<>n.title OR NEW.body_snapshot<>n.body OR NEW.acknowledged_at<>now() THEN RAISE EXCEPTION 'Notice content or audience changed';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER home_notice_ack_guard BEFORE INSERT OR UPDATE OR DELETE ON notice_acknowledgement FOR EACH ROW EXECUTE FUNCTION app.home_notice_ack_guard();
ALTER TABLE notice_acknowledgement ENABLE ROW LEVEL SECURITY;ALTER TABLE notice_acknowledgement FORCE ROW LEVEL SECURITY;
CREATE POLICY notice_ack_read ON notice_acknowledgement FOR SELECT USING(tenant_id=app.current_tenant_id() AND(app.home_own_live(employment_id) OR app.is_admin()));
CREATE POLICY notice_ack_insert ON notice_acknowledgement FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id() AND app.home_own_live(employment_id));
REVOKE ALL ON notice_acknowledgement FROM PUBLIC,ai_hr_app;GRANT SELECT,INSERT ON notice_acknowledgement TO ai_hr_app;
REVOKE ALL ON FUNCTION app.home_notice_ack_guard(),app.notice_content_digest(text,text) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.notice_content_digest(text,text) TO ai_hr_app;
--> statement-breakpoint
-- Current consent permits upcoming minimal team dates, never retroactive private leave history.
CREATE FUNCTION app.home_team_calendar(viewer uuid,from_day date,to_day date)
RETURNS TABLE(employment_id uuid,full_name text,entry_date date,kind text,status text,source_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.home_own_live(viewer) OR to_day<from_day OR to_day-from_day>61 THEN RETURN;END IF;
 RETURN QUERY WITH peers AS(
  SELECT e.id,p.full_name,policy.company_id,policy.wfh_enabled FROM public.employment e
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.home_sharing sh ON sh.employment_id=e.id AND sh.tenant_id=e.tenant_id AND sh.availability
  JOIN public.home_company_policy policy ON policy.company_id=app.home_company_on(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND policy.tenant_id=e.tenant_id AND policy.superseded_at IS NULL AND policy.availability_enabled
  WHERE e.tenant_id=app.current_tenant_id() AND app.home_peer(viewer,e.id)
 ),entries AS(
 SELECT peers.id,peers.full_name,rd.leave_date day,'teamLeave'::text kind,rd.status::text status,lr.id source_id
 FROM peers JOIN public.leave_request lr ON lr.employment_id=peers.id AND lr.tenant_id=app.current_tenant_id() AND lr.status IN('pending','approved')
 JOIN public.leave_request_date rd ON rd.leave_request_id=lr.id AND rd.tenant_id=lr.tenant_id AND rd.status IN('pending','approved')
 WHERE rd.leave_date BETWEEN GREATEST(from_day,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND to_day AND app.home_company_on(peers.id,rd.leave_date)=peers.company_id AND app.home_company_on(viewer,rd.leave_date)=peers.company_id
 UNION ALL
 SELECT peers.id,peers.full_name,d.day::date,'teamWfh'::text,w.status,w.id
 FROM peers JOIN public.home_wfh_request w ON w.employment_id=peers.id AND w.tenant_id=app.current_tenant_id() AND w.company_id=peers.company_id AND w.status IN('pending','approved') AND peers.wfh_enabled
 CROSS JOIN LATERAL generate_series(GREATEST(w.from_date,from_day,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)::timestamp,LEAST(w.to_date,to_day)::timestamp,interval '1 day')d(day)
 WHERE app.home_company_on(viewer,d.day::date)=peers.company_id AND app.home_company_on(peers.id,d.day::date)=peers.company_id
 ) SELECT entries.id,entries.full_name,entries.day,entries.kind,entries.status,entries.source_id FROM entries ORDER BY entries.day,entries.id,entries.kind,entries.source_id LIMIT 1001;
END;$$;
REVOKE ALL ON FUNCTION app.home_team_calendar(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_team_calendar(uuid,date,date) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.home_received_greetings(viewer uuid)
RETURNS TABLE(id uuid,sender_name text,message text,moment_date date,kind text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT g.id,p.full_name,g.message,g.moment_date,g.kind,g.created_at FROM public.home_greeting g
 JOIN public.employment e ON e.id=g.sender_employment_id AND e.tenant_id=g.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE g.tenant_id=app.current_tenant_id() AND g.recipient_employment_id=viewer AND app.home_own_live(viewer) AND g.redacted_at IS NULL
 ORDER BY g.created_at DESC,g.id LIMIT 51;
$$;
REVOKE ALL ON FUNCTION app.home_received_greetings(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.home_received_greetings(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Canonical erasure extension: private text only; digests, identity, actor and time survive.
-- A single person may have several employments. All its sender/recipient copies are addressed exactly.
CREATE FUNCTION app.home_redact_person_text(subject_employment uuid) RETURNS TABLE(greetings integer,acknowledgements integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_person uuid;subject_company uuid;g_count integer;a_count integer;
BEGIN
 SELECT e.person_id,e.company_id INTO subject_person,subject_company FROM public.employment e WHERE e.id=subject_employment AND e.tenant_id=app.current_tenant_id();
 IF subject_person IS NULL OR NOT app.is_admin() OR NOT app.is_admin_for(subject_company)
  OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 THEN RAISE EXCEPTION 'Subject erasure authority required' USING ERRCODE='42501';END IF;
 PERFORM id FROM public.person WHERE id=subject_person AND tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
 SELECT count(*) INTO g_count FROM public.home_greeting g WHERE g.tenant_id=app.current_tenant_id() AND g.redacted_at IS NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=subject_person AND e.tenant_id=g.tenant_id AND e.id IN(g.sender_employment_id,g.recipient_employment_id));
 SELECT count(*) INTO a_count FROM public.notice_acknowledgement a JOIN public.employment e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id WHERE e.person_id=subject_person AND a.tenant_id=app.current_tenant_id() AND a.redacted_at IS NULL;
 IF g_count>10000 OR a_count>10000 THEN RAISE EXCEPTION 'Subject text erasure exceeds synchronous bound';END IF;
 UPDATE public.home_greeting g SET message=NULL,redacted_at=now() WHERE g.tenant_id=app.current_tenant_id() AND g.redacted_at IS NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=subject_person AND e.tenant_id=g.tenant_id AND e.id IN(g.sender_employment_id,g.recipient_employment_id));
 GET DIAGNOSTICS g_count=ROW_COUNT;
 UPDATE public.notice_acknowledgement a SET title_snapshot=NULL,body_snapshot=NULL,redacted_at=now() WHERE a.tenant_id=app.current_tenant_id() AND a.redacted_at IS NULL AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=a.employment_id AND e.tenant_id=a.tenant_id AND e.person_id=subject_person);
 GET DIAGNOSTICS a_count=ROW_COUNT;
 RETURN QUERY SELECT g_count,a_count;
END;$$;
REVOKE ALL ON FUNCTION app.home_redact_person_text(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_redact_person_text(uuid) TO ai_hr_app;
--> statement-breakpoint
-- FORCE RLS also applies to the restricted migration/definer owner. Only that concrete role receives
-- these purpose-scoped policies; ai_hr_app receives no table UPDATE and cannot assume this role.
DO $owner_policies$
BEGIN
 EXECUTE format('CREATE POLICY home_sharing_projection_owner_read ON public.home_sharing FOR SELECT TO %I USING (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employment viewer WHERE viewer.tenant_id=home_sharing.tenant_id AND app.home_own_live(viewer.id) AND (viewer.id=home_sharing.employment_id OR app.home_peer(viewer.id,home_sharing.employment_id))))',current_user);
 EXECUTE format('CREATE POLICY home_wfh_projection_owner_read ON public.home_wfh_request FOR SELECT TO %I USING (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.employment viewer WHERE viewer.tenant_id=home_wfh_request.tenant_id AND app.home_own_live(viewer.id) AND (viewer.id=home_wfh_request.employment_id OR app.home_peer(viewer.id,home_wfh_request.employment_id))))',current_user);
 EXECUTE format('CREATE POLICY home_greeting_erasure_owner_read ON public.home_greeting FOR SELECT TO %I USING (tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=home_greeting.tenant_id AND e.id IN(home_greeting.sender_employment_id,home_greeting.recipient_employment_id) AND app.is_admin_for(e.company_id)))',current_user);
 EXECUTE format('CREATE POLICY home_greeting_erasure_owner_update ON public.home_greeting FOR UPDATE TO %I USING (tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=home_greeting.tenant_id AND e.id IN(home_greeting.sender_employment_id,home_greeting.recipient_employment_id) AND app.is_admin_for(e.company_id))) WITH CHECK (tenant_id=app.current_tenant_id() AND message IS NULL AND redacted_at IS NOT NULL)',current_user);
 EXECUTE format('CREATE POLICY notice_ack_erasure_owner_read ON public.notice_acknowledgement FOR SELECT TO %I USING (tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=notice_acknowledgement.employment_id AND e.tenant_id=notice_acknowledgement.tenant_id AND app.is_admin_for(e.company_id)))',current_user);
 EXECUTE format('CREATE POLICY notice_ack_erasure_owner_update ON public.notice_acknowledgement FOR UPDATE TO %I USING (tenant_id=app.current_tenant_id() AND app.is_admin() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=notice_acknowledgement.employment_id AND e.tenant_id=notice_acknowledgement.tenant_id AND app.is_admin_for(e.company_id))) WITH CHECK (tenant_id=app.current_tenant_id() AND title_snapshot IS NULL AND body_snapshot IS NULL AND redacted_at IS NOT NULL)',current_user);
END;$owner_policies$;
