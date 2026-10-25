-- Tenant-wide NRIC admission. Private derived counters make admission atomic even when two
-- statements began before either committed. The policy tuple is the write/toggle barrier;
-- ON/OFF and every changed identity serialize there, with current data from ON CONFLICT.
-- Existing identities are never rewritten. Unchanged normalized identities do not re-admit.
CREATE TABLE public.people_general_policy (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
 allow_duplicated_nric boolean NOT NULL DEFAULT false,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 admission_version bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.people_general_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.people_general_policy FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.people_nric_admission (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 normalized_nric text NOT NULL,
 occupants bigint NOT NULL CHECK(occupants>=0),
 PRIMARY KEY(tenant_id,normalized_nric)
);
ALTER TABLE public.people_nric_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.people_nric_admission FROM PUBLIC,ai_hr_app;
INSERT INTO public.people_nric_admission(tenant_id,normalized_nric,occupants)
 SELECT tenant_id,regexp_replace(ic_number,'[^0-9]','','g'),count(*)
 FROM public.employee_statutory_my WHERE regexp_replace(coalesce(ic_number,''),'[^0-9]','','g')<>''
 GROUP BY tenant_id,regexp_replace(ic_number,'[^0-9]','','g');
--> statement-breakpoint
CREATE FUNCTION app.people_general_can_configure() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 -- Fresh stored role floor plus configurable denial. A company administrator, including one
 -- covering every currently selected company, cannot configure future or other companies.
 SELECT app.access_legacy_configuration_permitted(NULL,NULL)
$$;
REVOKE ALL ON FUNCTION app.people_general_can_configure() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_can_configure() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.people_general_read() RETURNS TABLE(allow_duplicated_nric boolean,revision uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.allow_duplicated_nric,false),p.revision
 FROM (SELECT app.current_tenant_id() AS tenant_id) t
 LEFT JOIN public.people_general_policy p ON p.tenant_id=t.tenant_id
 WHERE t.tenant_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.people_general_read() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_read() TO ai_hr_app;
--> statement-breakpoint
-- Preview exposes only whether a submitted normalized key is already occupied, never holders.
CREATE FUNCTION app.people_nric_conflicts(p_company uuid,p_person uuid,p_keys text[]) RETURNS SETOF text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (CASE WHEN p_person IS NULL THEN app.access_workforce_company(p_company,'workforce.maintain')
          ELSE app.access_workforce_person(p_person,'workforce.maintain') END) IS NOT TRUE THEN
  RAISE EXCEPTION 'Employee record or permission is unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT a.normalized_nric FROM public.people_nric_admission a
 WHERE a.tenant_id=app.current_tenant_id() AND a.occupants>0 AND a.normalized_nric=ANY(p_keys);
END $$;
REVOKE ALL ON FUNCTION app.people_nric_conflicts(uuid,uuid,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_nric_conflicts(uuid,uuid,text[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.people_general_set(p_allow boolean,p_expected uuid) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); previous boolean; actual uuid; next_revision uuid:=gen_random_uuid();
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.people_general_can_configure() IS NOT TRUE OR p_allow IS NULL THEN
  RAISE EXCEPTION 'Whole organisation configuration access required' USING ERRCODE='42501';
 END IF;
 -- Materialize the same tuple identity admission uses; never rely on a stale preview value.
 INSERT INTO public.people_general_policy(tenant_id) VALUES(t) ON CONFLICT(tenant_id)
 DO UPDATE SET admission_version=people_general_policy.admission_version+1
 RETURNING allow_duplicated_nric,revision INTO previous,actual;
 -- A missing policy is represented by NULL in the UI. Newly materialized default OFF is
 -- equivalent only when no prior policy/admission existed (the default revision is hidden).
 IF p_expected IS DISTINCT FROM actual AND (p_expected IS NOT NULL OR EXISTS(
  SELECT 1 FROM public.people_general_policy WHERE tenant_id=t AND admission_version>0)) THEN
  RAISE EXCEPTION 'People General settings changed; reload before saving' USING ERRCODE='PN002';
 END IF;
 UPDATE public.people_general_policy SET allow_duplicated_nric=p_allow,revision=next_revision WHERE tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'people-general',t,'people-general.changed','user',app.current_user_id(),
  jsonb_build_object('before',jsonb_build_object('allowDuplicatedNric',previous),'after',jsonb_build_object('allowDuplicatedNric',p_allow)));
 RETURN next_revision;
END $$;
REVOKE ALL ON FUNCTION app.people_general_set(boolean,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.people_general_set(boolean,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.normalize_people_nric() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE normalized text:=nullif(regexp_replace(coalesce(NEW.ic_number,''),'[^0-9]','','g'),''); old_key text;
BEGIN
 IF TG_OP='UPDATE' THEN old_key:=nullif(regexp_replace(coalesce(OLD.ic_number,''),'[^0-9]','','g'),''); END IF;
 IF TG_OP='INSERT' OR normalized IS DISTINCT FROM old_key THEN
  IF btrim(coalesce(NEW.ic_number,''))<>'' AND (normalized IS NULL OR normalized !~ '^[0-9]{12}$') THEN
   RAISE EXCEPTION 'Invalid Malaysian IC number (expected 12 digits)' USING ERRCODE='23514';
  END IF;
 END IF;
 NEW.ic_number:=normalized;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.normalize_people_nric() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER people_nric_normalize BEFORE INSERT OR UPDATE OF ic_number ON public.employee_statutory_my
 FOR EACH ROW EXECUTE FUNCTION app.normalize_people_nric();
--> statement-breakpoint
CREATE FUNCTION app.guard_people_nric_admission() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; previous_key text; next_key text; allowed boolean; admitted bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN previous_key:=nullif(regexp_replace(coalesce(OLD.ic_number,''),'[^0-9]','','g'),''); END IF;
 IF TG_OP<>'DELETE' THEN next_key:=nullif(regexp_replace(coalesce(NEW.ic_number,''),'[^0-9]','','g'),''); END IF;
 IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
  RAISE EXCEPTION 'Statutory identity tenant is immutable' USING ERRCODE='23514';
 END IF;
 IF previous_key IS NOT DISTINCT FROM next_key THEN RETURN NULL; END IF;
 t:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
 -- Tenant deletion cascades already remove the private state; do not recreate it.
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=t) THEN RETURN NULL; END IF;
 INSERT INTO public.people_general_policy(tenant_id,admission_version) VALUES(t,1)
 ON CONFLICT(tenant_id) DO UPDATE SET admission_version=people_general_policy.admission_version+1
 RETURNING allow_duplicated_nric INTO allowed;
 IF next_key IS NOT NULL THEN
  admitted:=NULL;
  INSERT INTO public.people_nric_admission(tenant_id,normalized_nric,occupants) VALUES(t,next_key,1)
  ON CONFLICT(tenant_id,normalized_nric) DO UPDATE SET occupants=people_nric_admission.occupants+1
   WHERE allowed OR people_nric_admission.occupants=0 RETURNING occupants INTO admitted;
  IF admitted IS NULL THEN
   RAISE EXCEPTION 'Duplicate NRIC is disabled in People General Settings' USING ERRCODE='PN001';
  END IF;
 END IF;
 IF previous_key IS NOT NULL THEN
  UPDATE public.people_nric_admission SET occupants=occupants-1 WHERE tenant_id=t AND normalized_nric=previous_key;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.guard_people_nric_admission() FROM PUBLIC,ai_hr_app;
-- AFTER avoids reserving rows discarded by INSERT ... ON CONFLICT DO NOTHING/UPDATE.
CREATE TRIGGER people_nric_admission AFTER INSERT OR UPDATE OF ic_number,tenant_id OR DELETE ON public.employee_statutory_my
 FOR EACH ROW EXECUTE FUNCTION app.guard_people_nric_admission();
--> statement-breakpoint
DROP INDEX public.employee_statutory_my_ic_uq;
CREATE INDEX employee_statutory_my_ic_idx ON public.employee_statutory_my(tenant_id,ic_number) WHERE ic_number IS NOT NULL;

--> statement-breakpoint
-- Maintenance TRUNCATE has no row events; keep the private projection synchronized.
CREATE FUNCTION app.clear_people_nric_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN DELETE FROM public.people_nric_admission; RETURN NULL; END $$;
REVOKE ALL ON FUNCTION app.clear_people_nric_admission() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER people_nric_admission_truncate AFTER TRUNCATE ON public.employee_statutory_my
 FOR EACH STATEMENT EXECUTE FUNCTION app.clear_people_nric_admission();
