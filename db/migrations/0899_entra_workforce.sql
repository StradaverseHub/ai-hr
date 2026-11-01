-- Entra connectors contain no credentials. All access is through bounded definer services.
CREATE TABLE entra_connector (
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id), organization text NOT NULL UNIQUE,
 directory_tenant_id uuid NOT NULL UNIQUE, mode text NOT NULL CHECK(mode IN ('cloud','hybrid')),
 enabled boolean NOT NULL, provisioning_enabled boolean NOT NULL, revision uuid NOT NULL,
 CHECK(organization ~ '^[a-z0-9][a-z0-9-]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE entra_workforce (
 tenant_id uuid NOT NULL REFERENCES entra_connector(tenant_id), person_id uuid NOT NULL REFERENCES person(id),
 revision bigint NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending',
 last_status text NOT NULL DEFAULT 'pending', last_location text, object_id uuid,
 lease uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 last_active boolean, submitted_revision bigint, submission_started_at timestamptz, confirmed_active boolean, last_day date,
 PRIMARY KEY(tenant_id,person_id), UNIQUE(tenant_id,object_id),
 CHECK(status IN ('pending','processing','submitted','awaiting-sync','awaiting-link','ready','disabled','failed','rejected','uncertain'))
);
--> statement-breakpoint
ALTER TABLE entra_connector ENABLE ROW LEVEL SECURITY;
ALTER TABLE entra_workforce ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON entra_connector,entra_workforce FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.entra_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND NOT app.login_blocked(u.id)
 AND r.company_id IS NULL AND r.role IN ('super_admin','hr_admin')
 AND NOT app.access_configuration_denied_for(u.tenant_id,u.id));
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_organization(p_code text) RETURNS TABLE(tenant_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.tenant_id FROM public.entra_connector c WHERE c.organization=p_code AND c.enabled;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_configure(p_org text,p_directory uuid,p_mode text,p_enabled boolean,p_provision boolean,p_revision uuid,p_expected uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old public.entra_connector%ROWTYPE; t uuid:=app.current_tenant_id();
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('entra-config:'||t,0));
 SELECT * INTO old FROM public.entra_connector WHERE tenant_id=t FOR UPDATE;
 IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 -- Moving a directory requires a separate reviewed identity migration, never an in-place takeover.
 IF old.tenant_id IS NOT NULL AND (old.directory_tenant_id<>p_directory OR old.organization<>p_org OR old.mode<>p_mode) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 INSERT INTO public.entra_connector VALUES(t,p_org,p_directory,p_mode,p_enabled,p_provision,p_revision)
 ON CONFLICT(tenant_id) DO UPDATE SET enabled=p_enabled,provisioning_enabled=p_provision,revision=p_revision;
 INSERT INTO public.entra_workforce(tenant_id,person_id) SELECT t,p.id FROM public.person p WHERE p.tenant_id=t AND EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p.id AND e.tenant_id=t)
 ON CONFLICT(tenant_id,person_id) DO UPDATE SET revision=entra_workforce.revision+1,next_at=now(),status=CASE WHEN entra_workforce.status='uncertain' AND entra_workforce.last_location IS NULL THEN 'uncertain' ELSE 'pending' END;
 PERFORM app.append_auth_event(t,'entra-connector',t,'entra.configured','user',app.current_user_id(),jsonb_build_object('revision',p_revision,'enabled',p_enabled,'provisioning',p_provision));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_dirty() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; p uuid;
BEGIN
 IF TG_TABLE_NAME='person' THEN t:=NEW.tenant_id; p:=NEW.id; ELSE t:=NEW.tenant_id; p:=NEW.person_id; END IF;
 IF EXISTS(SELECT 1 FROM public.entra_connector WHERE tenant_id=t AND provisioning_enabled) THEN
 INSERT INTO public.entra_workforce(tenant_id,person_id) VALUES(t,p)
 ON CONFLICT(tenant_id,person_id) DO UPDATE SET revision=entra_workforce.revision+1,next_at=now(),status=CASE WHEN entra_workforce.status='uncertain' AND entra_workforce.last_location IS NULL THEN 'uncertain' ELSE 'pending' END;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER entra_person_changed AFTER UPDATE OF full_name,voided_at ON person FOR EACH ROW EXECUTE FUNCTION app.entra_dirty();
CREATE TRIGGER entra_employment_changed AFTER INSERT OR UPDATE ON employment FOR EACH ROW EXECUTE FUNCTION app.entra_dirty();
--> statement-breakpoint
CREATE FUNCTION app.entra_active(p_tenant uuid,p_person uuid,p_day date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
 WHERE p.tenant_id=p_tenant AND p.id=p_person AND p.voided_at IS NULL AND e.voided_at IS NULL
 AND e.blacklisted_at IS NULL AND e.hired_on<=p_day AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=p_day));
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_claim(p_day date) RETURNS TABLE(tenant_id uuid,person_id uuid,full_name text,active boolean,revision bigint,lease uuid,mode text,last_location text,last_status text,source_key text,submitted_revision bigint,last_active boolean,submission_started_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- Scheduled transitions are discovered even without a write on the effective date. Never infer deletion from an empty/failed source read.
 UPDATE public.entra_workforce w SET revision=w.revision+1,status='pending',next_at=now(),last_day=p_day
 FROM public.entra_connector c WHERE c.tenant_id=w.tenant_id AND c.provisioning_enabled
 AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=c.tenant_id AND t.status IN ('active','trial'))
 AND w.last_day IS DISTINCT FROM p_day AND w.lease_until IS NULL
 AND w.status IN ('ready','disabled','awaiting-sync')
 AND w.last_active IS DISTINCT FROM app.entra_active(w.tenant_id,w.person_id,p_day);
 RETURN QUERY WITH chosen AS (
 SELECT w.tenant_id,w.person_id FROM public.entra_workforce w JOIN public.entra_connector c USING(tenant_id)
 WHERE c.provisioning_enabled AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=c.tenant_id AND t.status IN ('active','trial')) AND w.next_at<=now() AND (w.lease_until IS NULL OR w.lease_until<now())
 AND w.status NOT IN ('ready','disabled','failed','rejected','awaiting-link')
 ORDER BY w.next_at,w.tenant_id,w.person_id FOR UPDATE OF w SKIP LOCKED LIMIT 1
 ), claimed AS (
 UPDATE public.entra_workforce w SET submission_started_at=CASE WHEN w.last_location IS NULL AND w.status='pending' THEN now() ELSE w.submission_started_at END,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',
 last_status=CASE WHEN w.status='processing' OR (w.status='uncertain' AND w.last_location IS NULL) THEN 'uncertain' WHEN w.last_location IS NOT NULL THEN 'submitted' ELSE w.status END,status='processing',attempts=w.attempts+1,last_day=p_day
 FROM chosen s WHERE w.tenant_id=s.tenant_id AND w.person_id=s.person_id RETURNING w.*)
 SELECT w.tenant_id,w.person_id,p.full_name,app.entra_active(w.tenant_id,w.person_id,p_day),w.revision,w.lease,c.mode,w.last_location,w.last_status,'aihr:'||w.tenant_id||':'||w.person_id,w.submitted_revision,w.last_active,w.submission_started_at
 FROM claimed w JOIN public.person p ON p.id=w.person_id AND p.tenant_id=w.tenant_id JOIN public.entra_connector c ON c.tenant_id=w.tenant_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_finish(p_tenant uuid,p_person uuid,p_revision bigint,p_lease uuid,p_status text,p_location text,p_active boolean,p_delay integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_status NOT IN ('pending','submitted','awaiting-sync','awaiting-link','ready','disabled','failed','rejected','uncertain') THEN RAISE EXCEPTION 'entra_invalid'; END IF;
 UPDATE public.entra_workforce SET status=p_status,last_location=p_location,last_active=CASE WHEN p_status='submitted' THEN p_active ELSE last_active END,
 submitted_revision=CASE WHEN p_status='submitted' AND last_location IS NULL THEN p_revision ELSE submitted_revision END,
 confirmed_active=CASE WHEN p_status IN ('ready','disabled','awaiting-sync') THEN p_active ELSE confirmed_active END,
 next_at=now()+make_interval(secs=>LEAST(3600,GREATEST(30,p_delay))),lease=NULL,lease_until=NULL
 WHERE tenant_id=p_tenant AND person_id=p_person AND revision=p_revision AND lease=p_lease AND lease_until>now();
 IF NOT FOUND THEN
 -- Preserve a receipt even if HR changed while the upload was in flight. Reconcile it before the newer revision.
 UPDATE public.entra_workforce SET lease=NULL,lease_until=NULL,
 last_location=CASE WHEN p_status='submitted' THEN p_location ELSE last_location END,
 submitted_revision=CASE WHEN p_status='submitted' AND last_location IS NULL THEN p_revision ELSE submitted_revision END,
 last_active=CASE WHEN p_status='submitted' THEN p_active ELSE last_active END,
 status=CASE WHEN p_status='uncertain' AND p_location IS NULL THEN 'uncertain' ELSE status END
 WHERE tenant_id=p_tenant AND person_id=p_person AND lease=p_lease;
 RETURN false;
 END IF;
 PERFORM app.append_auth_event(p_tenant,'entra-workforce',p_person,'entra.provisioning.'||p_status,'system',NULL,jsonb_build_object('revision',p_revision));
 RETURN true;
END;
$$;
--> statement-breakpoint
-- Binding is explicit administration. Provisioning success does not authorize adoption of an existing HR login.
CREATE FUNCTION app.entra_bind(p_person uuid,p_user uuid,p_object uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.entra_connector%ROWTYPE; u public.app_user%ROWTYPE; iss text;
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO c FROM public.entra_connector WHERE tenant_id=app.current_tenant_id() AND enabled FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 PERFORM 1 FROM public.person p WHERE p.tenant_id=c.tenant_id AND p.id=p_person AND p.voided_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id=p_user AND person_id=p_person AND tenant_id=c.tenant_id FOR UPDATE;
 IF NOT FOUND OR app.login_blocked(u.id) THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 IF EXISTS(SELECT 1 FROM public.deployment_identity_operator o JOIN public.app_external_identity i USING(issuer,subject) WHERE i.app_user_id=u.id AND o.revoked_at IS NULL)
 OR (u.id<>app.current_user_id() AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.role<>'employee')) THEN RAISE EXCEPTION 'entra_forbidden'; END IF;
 iss:='https://login.microsoftonline.com/'||c.directory_tenant_id||'/v2.0';
 IF EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=iss AND i.subject=p_object::text AND (i.app_user_id<>u.id OR i.revoked_at IS NOT NULL))
 OR EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=iss AND i.app_user_id=u.id AND i.subject<>p_object::text) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 INSERT INTO public.app_external_identity(issuer,subject,app_user_id) VALUES(iss,p_object::text,u.id) ON CONFLICT DO NOTHING;
 UPDATE public.entra_workforce SET object_id=p_object,status=CASE WHEN status='awaiting-link' THEN 'ready' ELSE status END WHERE tenant_id=c.tenant_id AND person_id=p_person;
 PERFORM app.append_auth_event(c.tenant_id,'app-user',u.id,'entra.identity-linked','user',app.current_user_id(),jsonb_build_object('objectId',p_object));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_login_allowed(p_tenant uuid,p_user uuid,p_revision uuid,p_day date) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.entra_connector c JOIN public.app_user u ON u.tenant_id=c.tenant_id
 WHERE c.tenant_id=p_tenant AND u.id=p_user AND c.revision=p_revision AND c.enabled AND NOT app.login_blocked(u.id)
 AND (u.person_id IS NULL OR app.entra_active(c.tenant_id,u.person_id,p_day)));
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_status() RETURNS SETOF entra_workforce LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT * FROM public.entra_workforce WHERE tenant_id=app.current_tenant_id() ORDER BY next_at DESC LIMIT 500;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_retry(p_person uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 -- Uncertain creates have no safe receipt: do not blindly replay them. IT reconciles upstream first.
 UPDATE public.entra_workforce SET status=CASE WHEN status='rejected' OR last_location IS NULL THEN 'pending' ELSE 'submitted' END,
 last_location=CASE WHEN status='rejected' THEN NULL ELSE last_location END,next_at=now(),attempts=0
 WHERE tenant_id=app.current_tenant_id() AND person_id=p_person AND status IN ('failed','rejected') AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_conflict'; END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_auto_bind(p_tenant uuid,p_person uuid,p_revision bigint,p_lease uuid,p_object uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.entra_connector%ROWTYPE; u uuid; iss text; d date;
BEGIN
 SELECT * INTO c FROM public.entra_connector WHERE tenant_id=p_tenant AND enabled AND provisioning_enabled
 AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=p_tenant AND t.status IN ('active','trial')) FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=p_tenant AND p.voided_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT w.last_day INTO d FROM public.entra_workforce w WHERE w.tenant_id=p_tenant AND w.person_id=p_person AND w.revision=p_revision AND w.lease=p_lease AND w.lease_until>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 iss:='https://login.microsoftonline.com/'||c.directory_tenant_id||'/v2.0';
 -- Existing logins are never automatically adopted or changed; an admin uses the explicit link path.
 IF EXISTS(SELECT 1 FROM public.app_user WHERE tenant_id=p_tenant AND person_id=p_person) THEN
   RETURN EXISTS(SELECT 1 FROM public.app_user u JOIN public.app_external_identity i ON i.app_user_id=u.id
    WHERE u.tenant_id=p_tenant AND u.person_id=p_person AND i.issuer=iss AND i.subject=p_object::text AND i.revoked_at IS NULL);
 END IF;
 IF NOT app.entra_active(p_tenant,p_person,d) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.app_external_identity WHERE issuer=iss AND subject=p_object::text) THEN RETURN false; END IF;
 -- Only baseline employee grants, owned by the administrator-enabled provisioning policy and the committed hire.
 INSERT INTO public.app_user(tenant_id,person_id,workos_user_id) VALUES(p_tenant,p_person,'provision:'||gen_random_uuid()) RETURNING id INTO u;
 INSERT INTO public.role_assignment(tenant_id,app_user_id,role,company_id)
 SELECT DISTINCT p_tenant,u,'employee'::public.role,e.company_id FROM public.employment e
 WHERE e.tenant_id=p_tenant AND e.person_id=p_person AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
 AND e.hired_on<=d AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=d);
 INSERT INTO public.app_external_identity(issuer,subject,app_user_id) VALUES(iss,p_object::text,u);
 UPDATE public.entra_workforce SET object_id=p_object WHERE tenant_id=p_tenant AND person_id=p_person;
 PERFORM app.append_auth_event(p_tenant,'app-user',u,'entra.identity-provisioned','system',NULL,jsonb_build_object('personId',p_person));
 RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_reconcile_hold(p_person uuid,p_day date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 UPDATE public.entra_workforce SET status='awaiting-sync',last_active=app.entra_active(tenant_id,person_id,p_day),
 submitted_revision=revision,next_at=now()
 WHERE tenant_id=app.current_tenant_id() AND person_id=p_person AND status='uncertain' AND last_location IS NULL
 AND lease_until IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 PERFORM app.append_auth_event(app.current_tenant_id(),'entra-workforce',p_person,'entra.reconciliation-requested','user',app.current_user_id(),NULL);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_provision_allowed(p_tenant uuid,p_revision uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.entra_connector c JOIN public.tenant t ON t.id=c.tenant_id
 WHERE c.tenant_id=p_tenant AND c.revision=p_revision AND c.provisioning_enabled AND t.status IN ('active','trial'));
$$;
--> statement-breakpoint
CREATE FUNCTION app.entra_local_bindings(p_user uuid,p_issuer text) RETURNS TABLE(subject text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT i.subject FROM public.app_external_identity i WHERE i.app_user_id=p_user AND i.issuer=p_issuer AND i.revoked_at IS NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.entra_admin(),app.entra_organization(text),app.entra_configure(text,uuid,text,boolean,boolean,uuid,uuid),app.entra_dirty(),app.entra_active(uuid,uuid,date),app.entra_claim(date),app.entra_finish(uuid,uuid,bigint,uuid,text,text,boolean,integer),app.entra_bind(uuid,uuid,uuid),app.entra_login_allowed(uuid,uuid,uuid,date),app.entra_status(),app.entra_retry(uuid),app.entra_reconcile_hold(uuid,date),app.entra_provision_allowed(uuid,uuid),app.entra_local_bindings(uuid,text),app.entra_auto_bind(uuid,uuid,bigint,uuid,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.entra_admin(),app.entra_organization(text),app.entra_configure(text,uuid,text,boolean,boolean,uuid,uuid),app.entra_claim(date),app.entra_finish(uuid,uuid,bigint,uuid,text,text,boolean,integer),app.entra_bind(uuid,uuid,uuid),app.entra_login_allowed(uuid,uuid,uuid,date),app.entra_status(),app.entra_retry(uuid),app.entra_reconcile_hold(uuid,date),app.entra_provision_allowed(uuid,uuid),app.entra_local_bindings(uuid,text),app.entra_auto_bind(uuid,uuid,bigint,uuid,uuid) TO ai_hr_app;
