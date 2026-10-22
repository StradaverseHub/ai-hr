-- Explicit Employee Home greeting delivery and private erasable message content.
-- Requires the ascending union through 0585, including the canonical Access/privacy owner in 0579.
-- No deployment-time data seed, automatic greeting or email delivery.
-- One occurrence owner for reading and explicit Send. PERSON stays private.
CREATE FUNCTION app._home_celebration_occurrences(p_employment uuid)
 RETURNS TABLE(peer_employment_id uuid,peer_person_id uuid,peer_display_name text,
  occurrence_date date,occurrence_kind text,service_years integer,page_cursor text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
  WHERE oid='public.employee_home_person_privacy_revision'::regclass)) THEN
  RAISE EXCEPTION 'Home privacy context unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 WITH cohort AS MATERIALIZED (SELECT * FROM app._home_peer_cohort(p_employment,'celebration')),
 days AS (SELECT today+n AS d FROM generate_series(0,7) n),
 candidates AS (
  SELECT c.employment_id,c.person_id,c.display_name,days.d,'birthday'::text AS kind,NULL::integer AS years
  FROM cohort c JOIN public.person p ON p.id=c.person_id AND p.tenant_id=app.current_tenant_id()
  JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=p.tenant_id CROSS JOIN days
  LEFT JOIN LATERAL (SELECT v.hide_birthday,v.hide_anniversary FROM public.employee_home_person_privacy_revision v
   WHERE v.tenant_id=p.tenant_id AND v.person_id=p.id ORDER BY v.ordinal DESC LIMIT 1) privacy ON true
  WHERE to_char(p.date_of_birth,'MM-DD')=to_char(days.d,'MM-DD') AND NOT coalesce(privacy.hide_birthday,false)
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
    OR days.d<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
  UNION ALL
  SELECT c.employment_id,c.person_id,c.display_name,days.d,'anniversary'::text,
   extract(year FROM days.d)::integer-extract(year FROM e.hired_on)::integer
  FROM cohort c JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=app.current_tenant_id() CROSS JOIN days
  LEFT JOIN LATERAL (SELECT v.hide_birthday,v.hide_anniversary FROM public.employee_home_person_privacy_revision v
   WHERE v.tenant_id=e.tenant_id AND v.person_id=e.person_id ORDER BY v.ordinal DESC LIMIT 1) privacy ON true
  WHERE to_char(e.hired_on,'MM-DD')=to_char(days.d,'MM-DD') AND extract(year FROM days.d)>extract(year FROM e.hired_on)
   AND NOT coalesce(privacy.hide_anniversary,false)
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
    OR days.d<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
 ), events AS MATERIALIZED (
  SELECT person_id,min(employment_id::text)::uuid AS employment_id,min(display_name) AS display_name,d,kind,
   CASE WHEN min(years)=max(years) THEN min(years) ELSE NULL END AS years,
   d::text||'|'||kind||'|'||min(employment_id::text) AS cursor
  FROM candidates GROUP BY person_id,d,kind

 ) SELECT events.employment_id,events.person_id,events.display_name,events.d,events.kind,events.years,events.cursor
 FROM events ORDER BY events.cursor;
END;
$$;
REVOKE ALL ON FUNCTION app._home_celebration_occurrences(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.home_celebration_page(p_employment uuid,p_after text DEFAULT NULL,p_limit integer DEFAULT 20)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy_scope text; result jsonb; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 -- An ownership drift must fail closed. Otherwise FORCE RLS could conceal a saved opt-out and
 -- make the absence look like permission to share. No BYPASSRLS or owner membership is granted.
 IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
  WHERE oid='public.employee_home_person_privacy_revision'::regclass)) THEN
  RAISE EXCEPTION 'Home privacy context unavailable' USING ERRCODE='42501';
 END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>50 OR (p_after IS NOT NULL AND
  p_after!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}\|(birthday|anniversary)\|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') THEN
  RAISE EXCEPTION 'Invalid Home sharing page' USING ERRCODE='22023';
 END IF;
 SELECT sharing_scope INTO policy_scope FROM app._home_peer_policy(p_employment,'celebration');
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 IF policy_scope='off' THEN
  RETURN jsonb_build_object('scope','off','from',today::text,'to',(today+7)::text,'total',0,'items','[]'::jsonb,'nextCursor',NULL);
 END IF;
 WITH events AS MATERIALIZED (
  SELECT peer_employment_id AS employment_id,peer_display_name AS display_name,occurrence_date AS d,
   occurrence_kind AS kind,service_years AS years,page_cursor AS cursor
  FROM app._home_celebration_occurrences(p_employment)
 ), page AS MATERIALIZED (
  SELECT * FROM events WHERE p_after IS NULL OR cursor>p_after ORDER BY cursor LIMIT p_limit+1
 ), shown AS (SELECT * FROM page ORDER BY cursor LIMIT p_limit)
 SELECT CASE WHEN p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM events WHERE cursor=p_after) THEN NULL
  ELSE jsonb_build_object('scope',policy_scope,'from',today::text,'to',(today+7)::text,'total',(SELECT count(*) FROM events),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',employment_id,'name',display_name,'date',d::text,'kind',kind,'years',years) ORDER BY cursor) FROM shown),'[]'::jsonb),
   'nextCursor',CASE WHEN (SELECT count(*) FROM page)>p_limit THEN (SELECT cursor FROM shown ORDER BY cursor DESC LIMIT 1) ELSE NULL END) END
 INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'Home sharing page changed; reload' USING ERRCODE='42501';END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.home_celebration_page(uuid,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_celebration_page(uuid,text,integer) TO ai_hr_app;

--> statement-breakpoint
-- Private command/content storage. None of these tables grants the application direct access.
-- In particular, an HR/manager principal cannot select a colleague's free-text message.
CREATE TABLE app.home_greeting (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 sender_user_id uuid NOT NULL REFERENCES public.app_user(id),sender_person_id uuid NOT NULL REFERENCES public.person(id),
 sender_employment_id uuid NOT NULL REFERENCES public.employment(id),recipient_person_id uuid NOT NULL REFERENCES public.person(id),
 recipient_employment_id uuid NOT NULL REFERENCES public.employment(id),nonce uuid NOT NULL,
 occurrence_kind text NOT NULL CHECK(occurrence_kind IN ('birthday','anniversary')),occurrence_date date NOT NULL,
 source_event_id uuid NOT NULL UNIQUE REFERENCES public.domain_event(id) DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL,UNIQUE(tenant_id,sender_user_id,nonce),CHECK(sender_person_id<>recipient_person_id)
);
--> statement-breakpoint
CREATE TABLE app.home_greeting_content (
 greeting_id uuid PRIMARY KEY REFERENCES app.home_greeting(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 message text,message_hash text,erased_at timestamptz,
 CHECK((message IS NOT NULL AND message_hash IS NOT NULL AND erased_at IS NULL)
  OR (message IS NULL AND message_hash IS NULL AND erased_at IS NOT NULL))
);
--> statement-breakpoint
-- A send admission is transient. Its deferred trigger proves the exact event and generic in-app
-- projection before deleting it. It is never a caller-controlled GUC or a reusable authorization token.
CREATE TABLE app.home_greeting_send_intent (
 greeting_id uuid PRIMARY KEY REFERENCES app.home_greeting(id),xact_id xid8 NOT NULL,
 tenant_id uuid NOT NULL,user_id uuid NOT NULL,notification_id uuid
);
--> statement-breakpoint
ALTER TABLE app.home_greeting ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.home_greeting_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.home_greeting_send_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.home_greeting,app.home_greeting_content,app.home_greeting_send_intent FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_send_begin(p_employment uuid,p_recipient uuid,p_kind text,p_date date,p_nonce uuid,p_message text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();own_person uuid;target_person uuid;
 policy record;audience text;saved app.home_greeting%ROWTYPE;content app.home_greeting_content%ROWTYPE;
 greeting uuid:=gen_random_uuid();event_id uuid:=gen_random_uuid();at_time timestamptz;person_to_lock uuid;
 digest text:=encode(sha256(convert_to(p_message,'UTF8')),'hex');
BEGIN
 -- Join the exact Access/profile barriers before any Person row or Home privacy lock.
 PERFORM app.access_profile_policy_write_lock();
 IF u IS NULL OR app.principal_snapshot_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 IF p_employment IS NULL OR p_recipient IS NULL OR p_employment=p_recipient OR p_nonce IS NULL
  OR p_nonce='00000000-0000-0000-0000-000000000000'::uuid OR p_date IS NULL
  OR p_kind IS NULL OR p_kind NOT IN ('birthday','anniversary') OR p_message IS NULL
  OR length(p_message)<1 OR length(p_message)>500 OR btrim(p_message)= ''
  OR p_message ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN
  RAISE EXCEPTION 'Invalid greeting command' USING ERRCODE='22023';END IF;
 SELECT * INTO policy FROM app._home_peer_policy(p_employment,'celebration');
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 own_person:=policy.viewer_person_id;audience:=app.own_home_dashboard_role(p_employment);
 PERFORM pg_advisory_xact_lock(hashtextextended('home-config:'||t::text||':'||policy.company_id::text||':'||audience,0));
 -- Access serializes relationship/identity writers; this lock serializes same-nonce retries.
 PERFORM pg_advisory_xact_lock(hashtextextended('home-greeting-command:'||t::text||':'||u::text||':'||p_nonce::text,0));
 SELECT * INTO saved FROM app.home_greeting g WHERE g.tenant_id=t AND g.sender_user_id=u AND g.nonce=p_nonce;
 IF FOUND THEN
  IF saved.sender_employment_id<>p_employment OR saved.sender_person_id<>own_person
   OR saved.recipient_employment_id<>p_recipient OR saved.occurrence_kind<>p_kind OR saved.occurrence_date<>p_date THEN
   RAISE EXCEPTION 'Greeting command changed' USING ERRCODE='22023';END IF;
  SELECT * INTO content FROM app.home_greeting_content c WHERE c.greeting_id=saved.id AND c.tenant_id=t;
  IF NOT FOUND OR (content.erased_at IS NULL AND content.message_hash IS DISTINCT FROM digest) THEN
   RAISE EXCEPTION 'Greeting command changed' USING ERRCODE='22023';END IF;
  -- An erased receipt is terminal: neither content nor notification is recreated.
  RETURN jsonb_build_object('version',1,'employmentId',p_employment,'nonce',p_nonce,'greetingId',saved.id,
   'state',CASE WHEN content.erased_at IS NULL THEN 'sent' ELSE 'erased' END);
 END IF;
 -- This lookup supplies a lock target only. The canonical occurrence owner below rechecks every
 -- current audience/opt-out/occasion fact after waiting on both exact existing privacy locks.
 SELECT e.person_id INTO target_person FROM public.employment e WHERE e.id=p_recipient AND e.tenant_id=t;
 IF target_person IS NULL OR target_person=own_person THEN
  RAISE EXCEPTION 'Celebration no longer available' USING ERRCODE='42501';END IF;
 FOR person_to_lock IN SELECT value FROM unnest(ARRAY[own_person,target_person]) value ORDER BY value LOOP
  PERFORM 1 FROM public.person p WHERE p.id=person_to_lock AND p.tenant_id=t FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 FOR person_to_lock IN SELECT value FROM unnest(ARRAY[own_person,target_person]) value ORDER BY value LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('home-person-privacy:'||t::text||':'||person_to_lock::text,0));
 END LOOP;
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id IN (own_person,target_person)) THEN
  RAISE EXCEPTION 'Greeting content is being erased' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT 1 FROM app._home_celebration_occurrences(p_employment) c WHERE c.peer_employment_id=p_recipient
  AND c.peer_person_id=target_person AND c.occurrence_kind=p_kind AND c.occurrence_date=p_date) THEN
  RAISE EXCEPTION 'Celebration no longer available' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 INSERT INTO app.home_greeting VALUES(greeting,t,u,own_person,p_employment,target_person,p_recipient,p_nonce,p_kind,p_date,event_id,at_time);
 INSERT INTO app.home_greeting_send_intent VALUES(greeting,pg_current_xact_id(),t,u,NULL);
 INSERT INTO app.home_greeting_content VALUES(greeting,t,p_message,digest,NULL);
 INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(event_id,t,'employee-home-greeting',greeting,'employee-home.greeting.sent','user',u,p_recipient,
  jsonb_build_object('greetingId',greeting));
 RETURN jsonb_build_object('version',1,'employmentId',p_employment,'nonce',p_nonce,'greetingId',greeting,'state','sent');
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_send_begin(uuid,uuid,text,date,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_send_begin(uuid,uuid,text,date,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Only an active exact command can project a notification. A retry of an already committed command
-- returns no projection target. The recipient, event and body are never taken from posted fields.
CREATE FUNCTION app.home_greeting_projection_target(p_greeting uuid)
 RETURNS TABLE(source_event_id uuid,recipient_employment_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT g.source_event_id,g.recipient_employment_id FROM app.home_greeting g
 JOIN app.home_greeting_send_intent i ON i.greeting_id=g.id AND i.tenant_id=g.tenant_id
 WHERE g.id=p_greeting AND g.tenant_id=app.current_tenant_id() AND i.xact_id=pg_current_xact_id()
  AND i.user_id=app.current_user_id() AND g.sender_user_id=i.user_id AND i.notification_id IS NULL
  AND app.principal_snapshot_current();
$$;
REVOKE ALL ON FUNCTION app.home_greeting_projection_target(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_projection_target(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_notification_allowed(p_tenant uuid,p_event uuid,p_recipient uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND app.principal_snapshot_current() AND EXISTS(
  SELECT 1 FROM app.home_greeting g JOIN app.home_greeting_send_intent i ON i.greeting_id=g.id AND i.tenant_id=g.tenant_id
  WHERE g.tenant_id=p_tenant AND g.source_event_id=p_event AND g.recipient_employment_id=p_recipient
   AND i.xact_id=pg_current_xact_id() AND i.user_id=app.current_user_id() AND i.notification_id IS NULL);
$$;
REVOKE ALL ON FUNCTION app.home_greeting_notification_allowed(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_notification_allowed(uuid,uuid,uuid) TO ai_hr_app;
CREATE POLICY notification_home_greeting_insert ON public.notification FOR INSERT
 WITH CHECK(kind='employee-home.greeting' AND app.home_greeting_notification_allowed(tenant_id,source_event_id,recipient_employment_id));
--> statement-breakpoint
CREATE FUNCTION app.guard_home_greeting_notification() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g app.home_greeting%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.kind='employee-home.greeting' AND (to_jsonb(NEW)-'read_at') IS DISTINCT FROM (to_jsonb(OLD)-'read_at') THEN
   RAISE EXCEPTION 'Greeting notification is immutable' USING ERRCODE='42501';END IF;
  IF OLD.kind IS DISTINCT FROM NEW.kind AND NEW.kind='employee-home.greeting' THEN
   RAISE EXCEPTION 'Greeting notification is immutable' USING ERRCODE='42501';END IF;
  IF OLD.kind<>'employee-home.greeting' AND EXISTS(SELECT 1 FROM app.home_greeting g WHERE g.source_event_id=NEW.source_event_id) THEN
   RAISE EXCEPTION 'Greeting notification is immutable' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO g FROM app.home_greeting WHERE source_event_id=NEW.source_event_id;
 IF NOT FOUND AND NEW.kind<>'employee-home.greeting' THEN RETURN NEW;END IF;
 IF NOT FOUND OR NEW.kind<>'employee-home.greeting' OR NEW.tenant_id IS DISTINCT FROM g.tenant_id
  OR NEW.recipient_employment_id IS DISTINCT FROM g.recipient_employment_id
  OR NEW.title IS DISTINCT FROM 'employeeHome.greetingNotification.title'
  OR NEW.body IS DISTINCT FROM 'employeeHome.greetingNotification.body' OR NEW.severity<>'info'
  OR NEW.link_path IS DISTINCT FROM '/me/greetings/'||g.id::text OR NEW.read_at IS NOT NULL
  OR app.home_greeting_notification_allowed(NEW.tenant_id,NEW.source_event_id,NEW.recipient_employment_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'Greeting notification unavailable' USING ERRCODE='42501';END IF;
 -- Do not permit a caller-selected timestamp. Capture the receipt AFTER INSERT, so the
 -- application RLS WITH CHECK still sees the unconsumed admission after this BEFORE trigger.
 NEW.created_at:=g.created_at;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_home_greeting_notification() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER home_greeting_notification_guard BEFORE INSERT OR UPDATE ON public.notification
 FOR EACH ROW EXECUTE FUNCTION app.guard_home_greeting_notification();
--> statement-breakpoint
CREATE FUNCTION app.capture_home_greeting_notification() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.kind='employee-home.greeting' THEN
  UPDATE app.home_greeting_send_intent i SET notification_id=NEW.id FROM app.home_greeting g
   WHERE i.greeting_id=g.id AND g.source_event_id=NEW.source_event_id AND g.tenant_id=NEW.tenant_id
    AND i.xact_id=pg_current_xact_id() AND i.user_id=app.current_user_id() AND i.notification_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Greeting notification unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.capture_home_greeting_notification() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER home_greeting_notification_capture AFTER INSERT ON public.notification
 FOR EACH ROW EXECUTE FUNCTION app.capture_home_greeting_notification();
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_send_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_send_intent%ROWTYPE;g app.home_greeting%ROWTYPE;
BEGIN
 SELECT * INTO i FROM app.home_greeting_send_intent WHERE greeting_id=NEW.greeting_id;
 SELECT * INTO g FROM app.home_greeting WHERE id=NEW.greeting_id;
 IF i.xact_id IS DISTINCT FROM pg_current_xact_id() OR i.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR i.user_id IS DISTINCT FROM app.current_user_id() OR app.principal_snapshot_current() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=g.source_event_id AND e.tenant_id=g.tenant_id
   AND e.aggregate_type='employee-home-greeting' AND e.aggregate_id=g.id AND e.event_type='employee-home.greeting.sent'
   AND e.actor_type='user' AND e.actor_id=g.sender_user_id AND e.subject_employment_id=g.recipient_employment_id
   AND e.payload=jsonb_build_object('greetingId',g.id))
  OR NOT EXISTS(SELECT 1 FROM public.notification n WHERE n.id=i.notification_id AND n.tenant_id=g.tenant_id
   AND n.source_event_id=g.source_event_id AND n.kind='employee-home.greeting' AND n.recipient_employment_id=g.recipient_employment_id)
  OR NOT EXISTS(SELECT 1 FROM app.home_greeting_content c WHERE c.greeting_id=g.id AND c.tenant_id=g.tenant_id) THEN
  RAISE EXCEPTION 'Greeting delivery incomplete' USING ERRCODE='42501';END IF;
 DELETE FROM app.home_greeting_send_intent WHERE greeting_id=g.id;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_send_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER home_greeting_send_complete AFTER INSERT ON app.home_greeting_send_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.home_greeting_send_complete();
--> statement-breakpoint
CREATE FUNCTION app.guard_home_greeting_event() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.event_type='employee-home.greeting.sent' OR NEW.aggregate_type='employee-home-greeting' THEN
  IF NOT EXISTS(SELECT 1 FROM app.home_greeting g JOIN app.home_greeting_send_intent i ON i.greeting_id=g.id
   WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=NEW.tenant_id AND i.tenant_id=app.current_tenant_id()
    AND i.user_id=app.current_user_id() AND NEW.id=g.source_event_id AND NEW.aggregate_id=g.id
    AND NEW.aggregate_type='employee-home-greeting' AND NEW.event_type='employee-home.greeting.sent'
    AND NEW.actor_type='user' AND NEW.actor_id=i.user_id AND NEW.subject_employment_id=g.recipient_employment_id
    AND NEW.payload=jsonb_build_object('greetingId',g.id)) THEN
   RAISE EXCEPTION 'Greeting event unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_home_greeting_event() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER home_greeting_event_guard BEFORE INSERT ON public.domain_event
 FOR EACH ROW EXECUTE FUNCTION app.guard_home_greeting_event();

--> statement-breakpoint
-- Untyped greeting text is private, erasable content. Like the existing vault, every valid privacy
-- erasure scope clears this untyped content; the original forty-field/retention declaration is unchanged.
CREATE TABLE app.home_greeting_erasure_intent (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,employment_id uuid NOT NULL,
 scope text NOT NULL,request_ref_hash text NOT NULL,reason_hash text NOT NULL,at_time timestamptz NOT NULL,
 cleared integer NOT NULL CHECK(cleared>=0),event_id uuid REFERENCES public.domain_event(id),
 PRIMARY KEY(xact_id,tenant_id,user_id,person_id)
);
--> statement-breakpoint
CREATE TABLE app.home_greeting_erasure_effect (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,
 greeting_id uuid NOT NULL REFERENCES app.home_greeting(id),before_hash text NOT NULL,after_hash text NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,person_id,greeting_id),
 FOREIGN KEY(xact_id,tenant_id,user_id,person_id) REFERENCES app.home_greeting_erasure_intent(xact_id,tenant_id,user_id,person_id)
);
--> statement-breakpoint
ALTER TABLE app.home_greeting_erasure_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.home_greeting_erasure_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.home_greeting_erasure_intent,app.home_greeting_erasure_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_erasure_begin(p_employment uuid,p_scope text,p_request_ref text,p_reason text) RETURNS timestamptz
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();subject uuid;saved record;total integer:=0;
BEGIN
 -- This is the existing independent privacy owner, including its actual selected-company admin
 -- floor, Access/profile barriers, captured before images and actual admission timestamp. Call once.
 at_time:=app.access_privacy_erasure_begin(p_employment,p_scope,p_request_ref,p_reason);
 SELECT e.person_id INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t;
 IF subject IS NULL OR app.can_admin_employment(p_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Privacy erasure subject unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('home-person-privacy:'||t::text||':'||subject::text,0));
 -- Always admit, even if all the old nullable fields and all greeting bodies are already empty.
 -- A repeated preparation cannot replace the captured evidence or authorize a later new body.
 INSERT INTO app.home_greeting_erasure_intent VALUES(pg_current_xact_id(),t,u,subject,p_employment,p_scope,
  encode(sha256(convert_to(p_request_ref,'UTF8')),'hex'),encode(sha256(convert_to(p_reason,'UTF8')),'hex'),at_time,0,NULL);
 FOR saved IN SELECT c.* FROM app.home_greeting_content c JOIN app.home_greeting g ON g.id=c.greeting_id AND g.tenant_id=c.tenant_id
  WHERE c.tenant_id=t AND subject IN (g.sender_person_id,g.recipient_person_id) AND c.erased_at IS NULL
  ORDER BY c.greeting_id FOR UPDATE OF c LOOP
  INSERT INTO app.home_greeting_erasure_effect VALUES(pg_current_xact_id(),t,u,subject,saved.greeting_id,
   encode(sha256(convert_to(to_jsonb(saved)::text,'UTF8')),'hex'),
   encode(sha256(convert_to((to_jsonb(saved)||jsonb_build_object('message',NULL,'message_hash',NULL,'erased_at',at_time))::text,'UTF8')),'hex'));
  total:=total+1;
 END LOOP;
 UPDATE app.home_greeting_erasure_intent SET cleared=total WHERE xact_id=pg_current_xact_id() AND tenant_id=t AND user_id=u AND person_id=subject;
 RETURN at_time;
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_erasure_begin(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_erasure_begin(uuid,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_home_greeting_content() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM app.home_greeting_send_intent i WHERE i.greeting_id=NEW.greeting_id
   AND i.tenant_id=NEW.tenant_id AND i.xact_id=pg_current_xact_id() AND i.user_id=app.current_user_id()) THEN RETURN NEW;END IF;
 ELSIF TG_OP='UPDATE' THEN
  IF app.principal_snapshot_current() AND EXISTS(
   SELECT 1 FROM app.home_greeting_erasure_effect e JOIN app.home_greeting_erasure_intent i
    USING(xact_id,tenant_id,user_id,person_id)
   WHERE e.xact_id=pg_current_xact_id() AND e.tenant_id=app.current_tenant_id() AND e.user_id=app.current_user_id()
    AND e.greeting_id=OLD.greeting_id AND app.can_admin_employment(i.employment_id)
    AND e.before_hash=encode(sha256(convert_to(to_jsonb(OLD)::text,'UTF8')),'hex')
    AND e.after_hash=encode(sha256(convert_to(to_jsonb(NEW)::text,'UTF8')),'hex')) THEN RETURN NEW;END IF;
 END IF;
 RAISE EXCEPTION 'Greeting content mutation unavailable' USING ERRCODE='42501';
END;
$$;
REVOKE ALL ON FUNCTION app.guard_home_greeting_content() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER home_greeting_content_guard BEFORE INSERT OR UPDATE OR DELETE ON app.home_greeting_content
 FOR EACH ROW EXECUTE FUNCTION app.guard_home_greeting_content();
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_redact(p_employment uuid,p_scope text,p_request_ref text,p_reason text) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;affected integer;
BEGIN
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND employment_id=p_employment AND scope=p_scope
  AND request_ref_hash=encode(sha256(convert_to(p_request_ref,'UTF8')),'hex') AND reason_hash=encode(sha256(convert_to(p_reason,'UTF8')),'hex');
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(p_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Greeting erasure admission unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.home_greeting_content c SET message=NULL,message_hash=NULL,erased_at=i.at_time
 FROM app.home_greeting_erasure_effect e WHERE e.xact_id=i.xact_id AND e.tenant_id=i.tenant_id AND e.user_id=i.user_id
  AND e.person_id=i.person_id AND e.greeting_id=c.greeting_id AND c.tenant_id=i.tenant_id AND c.erased_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;
 -- A second call is allowed only when every originally admitted effect is already exactly complete.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_effect e LEFT JOIN app.home_greeting_content c ON c.greeting_id=e.greeting_id
  WHERE e.xact_id=i.xact_id AND e.tenant_id=i.tenant_id AND e.user_id=i.user_id AND e.person_id=i.person_id
   AND e.after_hash IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'Greeting erasure effects incomplete' USING ERRCODE='42501';END IF;
 RETURN i.cleared;
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_redact(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_redact(uuid,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.audit_home_greeting_erasure() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;
BEGIN
 IF NEW.event_type<>'pii.erased' OR NEW.aggregate_type<>'person' THEN RETURN NULL;END IF;
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id
  AND user_id=NEW.actor_id AND person_id=NEW.aggregate_id;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM app.home_greeting g JOIN app.home_greeting_content c ON c.greeting_id=g.id
   WHERE g.tenant_id=NEW.tenant_id AND NEW.aggregate_id IN (g.sender_person_id,g.recipient_person_id) AND c.erased_at IS NULL)
   OR coalesce(NEW.payload->'erasedFields' ? 'homeGreetingMessages',false) THEN
   RAISE EXCEPTION 'Greeting erasure admission unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 IF NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR i.tenant_id IS DISTINCT FROM app.current_tenant_id()
  OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(i.employment_id) IS NOT TRUE
  OR NEW.subject_employment_id IS DISTINCT FROM i.employment_id OR NEW.payload->>'scope' IS DISTINCT FROM i.scope
  OR encode(sha256(convert_to(NEW.payload->>'requestRef','UTF8')),'hex') IS DISTINCT FROM i.request_ref_hash
  OR encode(sha256(convert_to(NEW.payload->>'reason','UTF8')),'hex') IS DISTINCT FROM i.reason_hash
  OR jsonb_typeof(NEW.payload->'erasedFields') IS DISTINCT FROM 'array'
  OR (NEW.payload->'erasedFields' ? 'homeGreetingMessages') IS DISTINCT FROM (i.cleared>0) OR i.event_id IS NOT NULL THEN
  RAISE EXCEPTION 'Greeting erasure audit unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.home_greeting_erasure_intent SET event_id=NEW.id WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.audit_home_greeting_erasure() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER home_greeting_erasure_audit AFTER INSERT ON public.domain_event
 FOR EACH ROW EXECUTE FUNCTION app.audit_home_greeting_erasure();
--> statement-breakpoint
CREATE FUNCTION app.home_greeting_erasure_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;
BEGIN
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=NEW.xact_id AND tenant_id=NEW.tenant_id
  AND user_id=NEW.user_id AND person_id=NEW.person_id;
 IF NOT FOUND OR i.event_id IS NULL OR i.xact_id IS DISTINCT FROM pg_current_xact_id()
  OR i.tenant_id IS DISTINCT FROM app.current_tenant_id() OR i.user_id IS DISTINCT FROM app.current_user_id()
  OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(i.employment_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=i.employment_id AND e.person_id=i.person_id AND e.tenant_id=i.tenant_id)
  OR EXISTS(SELECT 1 FROM app.home_greeting g JOIN app.home_greeting_content c ON c.greeting_id=g.id
   WHERE g.tenant_id=i.tenant_id AND i.person_id IN (g.sender_person_id,g.recipient_person_id) AND c.erased_at IS NULL)
  OR EXISTS(SELECT 1 FROM app.home_greeting_erasure_effect e LEFT JOIN app.home_greeting_content c ON c.greeting_id=e.greeting_id
   WHERE e.xact_id=i.xact_id AND e.tenant_id=i.tenant_id AND e.user_id=i.user_id AND e.person_id=i.person_id
    AND e.after_hash IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'Greeting erasure incomplete' USING ERRCODE='42501';END IF;
 -- Drop ephemeral body hashes; only the canonical non-content audit and erased receipt remain.
 DELETE FROM app.home_greeting_erasure_effect WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 DELETE FROM app.home_greeting_erasure_intent WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_erasure_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER home_greeting_erasure_complete AFTER INSERT ON app.home_greeting_erasure_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.home_greeting_erasure_complete();

--> statement-breakpoint
-- Own participation is proved from actual USER->PERSON and a currently usable own employment.
-- Admin/manager/cohort read access alone never reveals a sent or received private message.
CREATE FUNCTION app.home_greeting_read(p_employment uuid,p_greeting uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE own_person uuid;g app.home_greeting%ROWTYPE;c app.home_greeting_content%ROWTYPE;
BEGIN
 SELECT policy.viewer_person_id INTO own_person FROM app._home_peer_policy(p_employment,'celebration') policy;
 IF NOT FOUND THEN RAISE EXCEPTION 'Home context unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO g FROM app.home_greeting WHERE id=p_greeting AND tenant_id=app.current_tenant_id()
  AND (recipient_person_id=own_person OR (sender_person_id=own_person AND sender_user_id=app.current_user_id()));
 IF NOT FOUND THEN RAISE EXCEPTION 'Greeting unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM app.home_greeting_content WHERE greeting_id=g.id AND tenant_id=g.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Greeting unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('version',1,'employmentId',p_employment,'greetingId',g.id,
  'kind',g.occurrence_kind,'occurrenceDate',g.occurrence_date::text,'sentByMe',g.sender_user_id=app.current_user_id(),
  'state',CASE WHEN c.erased_at IS NULL THEN 'sent' ELSE 'erased' END,'message',c.message);
END;
$$;
REVOKE ALL ON FUNCTION app.home_greeting_read(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.home_greeting_read(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Join the Access/profile barrier BEFORE the existing person advisory lock and its later FK.
-- The service joins the same barrier before its own advisory acquisition. All old checks remain.
CREATE OR REPLACE FUNCTION app.prepare_employee_home_person_privacy_revision() RETURNS trigger LANGUAGE plpgsql
 SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous_ordinal integer;
BEGIN
 PERFORM app.access_profile_policy_write_lock();
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
