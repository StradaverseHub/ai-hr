-- A login belongs to a person; an employment is optional. No credentials live on person.
-- Exact email conflicts require an administrator to choose the existing person, never auto-link.
CREATE FUNCTION app.create_login_person(p_name text,p_email text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_person uuid;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF NOT app.access_legacy_configuration_permitted(NULL,NULL,NULL) OR NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r
   ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
   WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND NOT app.login_blocked(u.id)
   AND (r.role='super_admin' OR (r.role='hr_admin' AND r.company_id IS NULL))) THEN
  RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege';
 END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200
 OR p_email IS NULL OR length(p_email)>255 OR p_email<>lower(btrim(p_email))
 OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
  RAISE EXCEPTION 'manual_identity_invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('login-person:'||app.current_tenant_id()::text||':'||p_email,0));
 IF EXISTS(SELECT 1 FROM public.person p WHERE p.tenant_id=app.current_tenant_id() AND lower(btrim(p.primary_email))=p_email) THEN
  RAISE EXCEPTION 'manual_identity_conflict';
 END IF;
 INSERT INTO public.person(tenant_id,full_name,primary_email)
 VALUES(app.current_tenant_id(),btrim(p_name),p_email) RETURNING id INTO v_person;
 PERFORM app.append_auth_event(app.current_tenant_id(),'person',v_person,'person.login-contact-created','user',app.current_user_id(),
   jsonb_build_object('personId',v_person));
 RETURN v_person;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.create_login_person(text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.create_login_person(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.manual_identity_target(p_person uuid,p_role text,p_company uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_user public.app_user%ROWTYPE; v_count int;
BEGIN
 PERFORM 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.invitation_refs_in_tenant(app.current_tenant_id(),p_company,p_person)
 OR (EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id())
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=app.current_tenant_id()
   AND e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on) >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) THEN
  RAISE EXCEPTION 'manual_identity_target' USING ERRCODE='insufficient_privilege';
 END IF;
 SELECT count(*) INTO v_count FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.person_id=p_person;
 IF v_count>1 THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 SELECT * INTO v_user FROM public.app_user u WHERE u.tenant_id=app.current_tenant_id() AND u.person_id=p_person FOR UPDATE;
 IF FOUND AND (NOT app.is_placeholder_subject(v_user.workos_user_id) OR app.login_blocked(v_user.id)
 OR EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.app_user_id=v_user.id)
 OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=v_user.id
   AND NOT app.invitation_confers(p_role,p_company,r.role::text,r.company_id))) THEN
  RAISE EXCEPTION 'manual_identity_conflict' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN v_user.id;
END;
$$;
--> statement-breakpoint
-- Keep request-ID retries atomic, including creation of the named person before provider calls.
CREATE FUNCTION app.manual_identity_reserve_new_person(p_id uuid,p_issuer text,p_name text,p_username text,p_email text,p_role text,p_company uuid)
RETURNS SETOF public.app_manual_identity_enrollment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE; v_person uuid;
BEGIN
 IF NOT app.manual_identity_authorized(p_issuer) THEN RAISE EXCEPTION 'manual_identity_forbidden' USING ERRCODE='insufficient_privilege'; END IF;
 IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'manual_identity_invalid'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-enrollment:'||p_id::text,0));
 SELECT * INTO v FROM public.app_manual_identity_enrollment e WHERE e.id=p_id FOR UPDATE;
 IF FOUND THEN
  IF v.tenant_id IS DISTINCT FROM app.current_tenant_id()
   OR NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=v.person_id AND p.tenant_id=v.tenant_id AND p.full_name=btrim(p_name)) THEN
   RAISE EXCEPTION 'manual_identity_conflict';
  END IF;
  v_person:=v.person_id;
 ELSE
  v_person:=app.create_login_person(p_name,p_email);
 END IF;
 RETURN QUERY SELECT * FROM app.manual_identity_reserve(p_id,p_issuer,v_person,p_username,p_email,p_role,p_company);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.manual_identity_reserve_new_person(uuid,text,text,text,text,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.manual_identity_reserve_new_person(uuid,text,text,text,text,text,uuid) TO ai_hr_app;
