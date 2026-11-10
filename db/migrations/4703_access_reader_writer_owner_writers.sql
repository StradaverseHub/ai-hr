-- Reader/writer Access lock: owner and maintenance sessions keep waiting (wave 1 repair).
-- The try-and-refuse rule is for request sites, which always run with a tenant context. Owner sessions
-- (provisioning, operator tooling, fixtures) have none; refusing them under ordinary shared traffic would
-- stop an operator adding an administrator during working hours, and concurrent owner writes refused
-- each other. They wait for the exclusive lock as before 4700. Request sites are unchanged.
CREATE OR REPLACE FUNCTION app.access_lock_legacy_writer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; k bigint; old_person uuid; new_person uuid; touched_login boolean:=false;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; ELSE t:=NEW.tenant_id; END IF;
 k:=hashtextextended('access-configuration:'||t::text,0);
 IF TG_TABLE_NAME='employment' THEN
  PERFORM app.access_lock_assert_strict(t,'S',TG_TABLE_NAME);
  PERFORM pg_advisory_xact_lock_shared(k);
  IF TG_OP<>'INSERT' THEN old_person:=OLD.person_id; END IF;
  IF TG_OP<>'DELETE' THEN new_person:=NEW.person_id; END IF;
  SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=t AND u.person_id IN (old_person,new_person)) INTO touched_login;
  IF touched_login THEN
   PERFORM app.access_administrator_set_lock(t);
   IF app.access_lock_mode_held(t)='X' THEN
    UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t AND initialized;
   END IF;
  END IF;
 ELSE
  PERFORM app.access_lock_assert_strict(t,'X',TG_TABLE_NAME);
  IF app.current_tenant_id() IS NULL THEN
   -- Owner, provisioning and maintenance sessions are not request sites. They keep waiting as before,
   -- so an operator adding an administrator is not refused while employees clock in.
   PERFORM pg_advisory_xact_lock(k);
  ELSIF NOT pg_try_advisory_xact_lock(k) THEN
   RAISE EXCEPTION 'Access configuration is busy; retry.' USING ERRCODE='55P03';
  END IF;
  UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t AND initialized;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_access_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
 PERFORM app.access_lock_assert_strict(t,'X',TG_TABLE_NAME);
 IF app.current_tenant_id() IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 ELSIF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
  RAISE EXCEPTION 'Access configuration is busy; retry.' USING ERRCODE='55P03';
 END IF;
 UPDATE app.access_profile_write_generation SET generation=generation+1 WHERE tenant_id=t;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access policy generation unavailable' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_setting_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row jsonb:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;t uuid;
BEGIN
 IF TG_OP='UPDATE' AND before_row=after_row THEN RETURN NULL; END IF;
 FOR t IN SELECT DISTINCT (v->>'tenant_id')::uuid FROM (VALUES(before_row),(after_row)) entries(v)
  WHERE v->>'key' IN ('ess.profile_change_fields','ess.profile_change_routing','ess.profile_change_approver','ess.profile_photo_edit') ORDER BY 1
 LOOP
  IF NOT app.access_workforce_storage_owner() AND t IS DISTINCT FROM app.current_tenant_id() THEN
   RAISE EXCEPTION 'Profile policy tenant unavailable' USING ERRCODE='42501'; END IF;
  PERFORM app.access_lock_assert_strict(t,'X','tenant_setting profile policy');
  IF app.current_tenant_id() IS NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
  ELSIF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
   RAISE EXCEPTION 'Access configuration is busy; retry.' USING ERRCODE='55P03';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('profile-edit-policy:'||t::text,0));
  UPDATE app.access_profile_write_generation SET generation=generation+1 WHERE tenant_id=t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile policy generation unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
