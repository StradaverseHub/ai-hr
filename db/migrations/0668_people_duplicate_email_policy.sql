-- 5e0b2154 — "Allow Duplicated Work Email or Personal Email", beside Allow Duplicated NRIC on the same
-- tenant-wide People General policy, under the same configuration authority, revision and audit event.
--
-- There is no database rule on duplicate employee emails (person.primary_email / personal_email carry no
-- unique index); the checks this switch relaxes are in the employee imports. Login identity is separate:
-- app.create_login_person still refuses an email that another person already holds.
ALTER TABLE public.people_general_policy ADD COLUMN allow_duplicated_email boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP FUNCTION app.people_general_read();
CREATE FUNCTION app.people_general_read() RETURNS TABLE(allow_duplicated_nric boolean,revision uuid,allow_duplicated_email boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.allow_duplicated_nric,false),p.revision,coalesce(p.allow_duplicated_email,false)
 FROM (SELECT app.current_tenant_id() AS tenant_id) t
 LEFT JOIN public.people_general_policy p ON p.tenant_id=t.tenant_id
 WHERE t.tenant_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.people_general_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_read() TO ai_hr_app;
--> statement-breakpoint
-- Both switches saved together under the 0594 lock, revision check and audit event.
CREATE FUNCTION app.people_general_set(p_allow boolean,p_allow_email boolean,p_expected uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); previous boolean; previous_email boolean; actual uuid; next_revision uuid:=gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.people_general_can_configure() IS NOT TRUE OR p_allow IS NULL OR p_allow_email IS NULL THEN
  RAISE EXCEPTION 'Whole organisation configuration access required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.people_general_policy(tenant_id) VALUES(t) ON CONFLICT(tenant_id)
 DO UPDATE SET admission_version=people_general_policy.admission_version+1
 RETURNING allow_duplicated_nric,allow_duplicated_email,revision INTO previous,previous_email,actual;
 IF p_expected IS DISTINCT FROM actual AND (p_expected IS NOT NULL OR EXISTS(
  SELECT 1 FROM public.people_general_policy WHERE tenant_id=t AND admission_version>0)) THEN
  RAISE EXCEPTION 'People General settings changed; reload before saving' USING ERRCODE='PN002';
 END IF;
 UPDATE public.people_general_policy SET allow_duplicated_nric=p_allow,allow_duplicated_email=p_allow_email,revision=next_revision WHERE tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'people-general',t,'people-general.changed','user',app.current_user_id(),
  jsonb_build_object('before',jsonb_build_object('allowDuplicatedNric',previous,'allowDuplicatedEmail',previous_email),
   'after',jsonb_build_object('allowDuplicatedNric',p_allow,'allowDuplicatedEmail',p_allow_email)));
 RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION app.people_general_set(boolean,boolean,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_set(boolean,boolean,uuid) TO ai_hr_app;
--> statement-breakpoint
-- The 0594 two-argument form keeps working and leaves the email switch as it is.
CREATE OR REPLACE FUNCTION app.people_general_set(p_allow boolean,p_expected uuid) RETURNS uuid
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.people_general_set(p_allow,coalesce((SELECT allow_duplicated_email FROM public.people_general_policy WHERE tenant_id=app.current_tenant_id()),false),p_expected)
$$;
REVOKE ALL ON FUNCTION app.people_general_set(boolean,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_set(boolean,uuid) TO ai_hr_app;
