-- Reader/writer Access lock: central wave (design mechanisms C and D, 10 November 2026).
--
-- The tenant-wide key access-configuration:<tenant> becomes a reader/writer lock. Ordinary
-- writers and every statement-level trigger join it in shared mode through
-- app.access_workforce_write_lock(). Editors of configuration and authority inputs take it
-- exclusively through app.access_configuration_write_lock(). Function callers that have not been
-- individually verified to be safe in shared mode stay exclusive below: anything not yet
-- proven remains serialized exactly as before.
--
-- Triggers never block waiting for the exclusive lock. A trigger that needs it tries once and
-- refuses, so a call site that should have taken the exclusive lock first fails loudly instead
-- of queueing behind every shared holder while holding its own row locks.

-- 1. Last-administrator guard. Serialises writers that can shrink the usable administrator set
-- while they hold only the shared lock. The deferred recovery check then runs after the guard.
CREATE TABLE app.access_administrator_guard (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
 epoch bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
REVOKE ALL ON TABLE app.access_administrator_guard FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.access_administrator_guard ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO app.access_administrator_guard(tenant_id) SELECT id FROM public.tenant;
--> statement-breakpoint
CREATE FUNCTION app.access_administrator_guard_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO app.access_administrator_guard(tenant_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_administrator_guard_tenant() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER access_administrator_guard_tenant AFTER INSERT ON public.tenant
FOR EACH ROW EXECUTE FUNCTION app.access_administrator_guard_tenant();
--> statement-breakpoint
-- Every writer that can reduce the usable administrator set calls this before changing rows.
CREATE FUNCTION app.access_administrator_set_lock(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_tenant IS NULL OR (NOT app.access_workforce_storage_owner() AND p_tenant IS DISTINCT FROM app.current_tenant_id()) THEN
  RAISE EXCEPTION 'Access administrator guard unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.access_administrator_guard(tenant_id,epoch) VALUES(p_tenant,1)
 ON CONFLICT (tenant_id) DO UPDATE SET epoch=app.access_administrator_guard.epoch+1;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_administrator_set_lock(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_administrator_set_lock(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 2. Lock-mode introspection and the strict test mode. Advisory bigint keys are stored as
-- classid (high 32 bits), objid (low 32 bits), objsubid 1. Reads only this session's locks.
CREATE FUNCTION app.access_lock_mode_held(p_tenant uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN bool_or(l.mode='ExclusiveLock') THEN 'X' WHEN bool_or(l.mode='ShareLock') THEN 'S' END
 FROM pg_catalog.pg_locks l
 WHERE l.locktype='advisory' AND l.pid=pg_backend_pid() AND l.granted AND l.objsubid=1
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended('access-configuration:'||p_tenant::text,0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_lock_mode_held(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_lock_mode_held(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Strict mode (app.access_lock_strict=on, tests only): a trigger refuses when the session has not
-- taken the expected Access lock mode before writing, so a misclassified site fails deterministically.
CREATE FUNCTION app.access_lock_assert_strict(p_tenant uuid,p_expected text,p_label text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE held text;
BEGIN
 IF coalesce(current_setting('app.access_lock_strict',true),'')<>'on' THEN RETURN; END IF;
 held:=app.access_lock_mode_held(p_tenant);
 IF held IS NULL OR (p_expected='X' AND held<>'X') THEN
  RAISE EXCEPTION 'Access lock strict mode: % requires % lock, held %',p_label,p_expected,coalesce(held,'none') USING ERRCODE='AL001';
 END IF;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_lock_assert_strict(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- 3. The exclusive editor lock. Same body the workforce barrier had before this migration.
CREATE FUNCTION app.access_configuration_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Access configuration unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=t FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access policy generation unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.access_configuration WHERE tenant_id=t AND initialized FOR SHARE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_configuration_write_lock() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_configuration_write_lock() TO ai_hr_app;
--> statement-breakpoint
-- The workforce barrier becomes shared. FOR SHARE keeps a stale REPEATABLE READ writer refusing
-- after a revocation exactly as before; the editor updates those tuples only while exclusive.
CREATE OR REPLACE FUNCTION app.access_workforce_write_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 PERFORM 1 FROM app.access_profile_write_generation WHERE tenant_id=t FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Workforce policy generation unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.access_configuration WHERE tenant_id=t AND initialized FOR SHARE;
END;
$$;
--> statement-breakpoint
-- 4. Legacy identity/role/employment writers.
-- Employment writes take the shared lock and no revision update, so two concurrent hires cannot
-- deadlock upgrading FOR SHARE to UPDATE. When the old or new person has a login the change can
-- reduce the administrator set, so it also takes the guard; only an exclusive holder advances
-- the shared revision. Role, account, invitation and company-tree writes are configuration
-- changes: the caller must already hold the exclusive lock, so the trigger only tries.
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
  IF NOT pg_try_advisory_xact_lock(k) THEN
   RAISE EXCEPTION 'Access configuration is busy; retry.' USING ERRCODE='55P03';
  END IF;
  UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t AND initialized;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint
-- 5. The deferred recovery check only matters when a login can be affected. An employment whose
-- old and new person have no login cannot change who is a usable administrator.
CREATE OR REPLACE FUNCTION app.access_administrator_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; old_person uuid; new_person uuid;
BEGIN
 IF TG_OP='DELETE' THEN t:=OLD.tenant_id; ELSE t:=NEW.tenant_id; END IF;
 IF t IS DISTINCT FROM app.current_tenant_id() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='employment' THEN
  IF TG_OP<>'INSERT' THEN old_person:=OLD.person_id; END IF;
  IF TG_OP<>'DELETE' THEN new_person:=NEW.person_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.tenant_id=t AND u.person_id IN (old_person,new_person)) THEN
   RETURN NULL;
  END IF;
 END IF;
 PERFORM app.access_assert_administrator();
 RETURN NULL;
END;
$$;
--> statement-breakpoint
-- 6. Configuration generation triggers try the exclusive lock instead of blocking on it.
CREATE OR REPLACE FUNCTION app.access_profile_access_generation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
 PERFORM app.access_lock_assert_strict(t,'X',TG_TABLE_NAME);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
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
  IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)) THEN
   RAISE EXCEPTION 'Access configuration is busy; retry.' USING ERRCODE='55P03';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('profile-edit-policy:'||t::text,0));
  UPDATE app.access_profile_write_generation SET generation=generation+1 WHERE tenant_id=t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Profile policy generation unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.company_org_lock()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id();BEGIN
 PERFORM app.access_configuration_write_lock();
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||t::text,0)) THEN RAISE EXCEPTION 'Organisation dependencies are busy; retry.' USING ERRCODE='40001';END IF;
 PERFORM app.lock_system_label_criteria(t,'business_unit');
 PERFORM pg_advisory_xact_lock(hashtextextended('company-organisation:'||t::text,0));
 INSERT INTO company_organisation_source_epoch(tenant_id) VALUES(t) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM company_organisation_source_epoch WHERE tenant_id=t FOR UPDATE;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_lock_authority_sources()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM app.access_configuration_write_lock();
 IF NOT pg_try_advisory_xact_lock(hashtext('audit-chain:'||app.current_tenant_id()::text)) OR NOT pg_try_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text||':onboarding',0)) OR NOT pg_try_advisory_xact_lock(hashtextextended('lifecycle-v9:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Canonical contract custody is busy; retry the complete action' USING ERRCODE='55P03';END IF;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.pay_formula_personnel_register(p_source text, p_label text, p_description text, p_enabled boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); next_ordinal integer; result uuid;
BEGIN
 PERFORM app.access_configuration_write_lock();
 IF actor IS NULL OR NOT app.pay_formula_catalog_access() THEN RAISE EXCEPTION 'Formula administrator required' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':pay-component-catalog',0));
 IF p_source IS NULL OR p_source NOT IN ('profile.personal_details.salutation','profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname','profile.personal_details.preferredname','profile.personal_details.religion','profile.personal_details.race','profile.personal_details.age','profile.identity_and_passport.icnumber','profile.identity_and_passport.oldicnumber','profile.identity_and_passport.passportnumber','profile.identity_and_passport.passportissuedate','profile.identity_and_passport.passportexpirydate','profile.identity_and_passport.passportissuingcountry','profile.identity_and_passport.passportissuingcountrycode','profile.identity_and_passport.passportremark','profile.contact_and_permanent_address.primaryemail','profile.contact_and_permanent_address.phone','profile.contact_and_permanent_address.homephone','profile.contact_and_permanent_address.personalemail','profile.contact_and_permanent_address.permanentaddressline1','profile.contact_and_permanent_address.permanentaddressline2','profile.contact_and_permanent_address.permanentaddressline3','profile.contact_and_permanent_address.permanentpostcode','profile.contact_and_permanent_address.permanentcity','profile.contact_and_permanent_address.permanentstate','profile.contact_and_permanent_address.permanentcountry','profile.correspondence_address.correspondenceaddressline1','profile.correspondence_address.correspondenceaddressline2','profile.correspondence_address.correspondenceaddressline3','profile.correspondence_address.correspondencepostcode','profile.correspondence_address.correspondencecity','profile.correspondence_address.correspondencestate','profile.correspondence_address.correspondencecountry','profile.correspondence_address.correspondencemobilephone','profile.correspondence_address.correspondencehomephone','employment.additional_organisation_labels.orgdivision','employment.additional_organisation_labels.orgbranch','employment.additional_organisation_labels.orgregion','employment.additional_organisation_labels.orgline','employment.additional_organisation_labels.orgsection','employment.additional_organisation_labels.orgteam','employment.additional_organisation_labels.orgbase','employment.additional_organisation_labels.employmentcategory','employment.employment_dates_and_service.groupservice','employment.employment_dates_and_service.companyservice','employment.employment_dates_and_service.yearofservice','employment.employment_dates_and_service.probationvalue','employment.employment_dates_and_service.probationunit','employment.employment_dates_and_service.extendedprobationvalue','employment.employment_dates_and_service.extendedprobationunit','employment.employment_dates_and_service.finalconfirmationdate','employment.employment_dates_and_service.contractstartdate','employment.employment_dates_and_service.contractenddate','employment.employment_dates_and_service.contractremark','employment.employment_dates_and_service.noticebeforeconfirmationvalue','employment.employment_dates_and_service.noticebeforeconfirmationunit','employment.employment_dates_and_service.noticeafterconfirmationvalue','employment.employment_dates_and_service.noticeafterconfirmationunit','employment.employment_dates_and_service.tenderresignationdate','companyId','companyName','businessUnitId','departmentId','positionId','gradeId') OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 120 OR p_description IS NULL OR length(btrim(p_description)) NOT BETWEEN 1 AND 1000 OR p_enabled IS NULL
 THEN RAISE EXCEPTION 'Choose a supported typed source and supply its reviewed label and description' USING ERRCODE='23514'; END IF;
 SELECT coalesce(max(ordinal),0)+1 INTO next_ordinal FROM public.pay_formula_personnel_registration WHERE tenant_id=t AND source_key=p_source;
 INSERT INTO public.pay_formula_personnel_registration(tenant_id,source_key,ordinal,label,description,enabled,created_by)
 VALUES(t,p_source,next_ordinal,btrim(p_label),btrim(p_description),p_enabled,actor) RETURNING id INTO result;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'pay-formula-personnel-registration',result,'pay-formula.personnel-registered','user',actor,jsonb_build_object('sourceKey',p_source,'ordinal',next_ordinal,'label',btrim(p_label),'description',btrim(p_description),'enabled',p_enabled));
 RETURN result;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.people_general_policy_review_lock()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM app._people_general_policy_review_actor();PERFORM app.access_configuration_write_lock();
 -- Existing tuple is the NRIC admission barrier; absence remains absence, with no exclusive-range claim.
 PERFORM 1 FROM public.people_general_policy WHERE tenant_id=app.current_tenant_id() FOR UPDATE;
 RETURN app.people_general_policy_review_source();
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_code_claim(p_tenant uuid, p_code text, p_exclude_employment uuid DEFAULT NULL::uuid, p_exclude_draft uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  PERFORM app.access_configuration_write_lock();
  IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(
   SELECT 1 FROM public.company c WHERE c.tenant_id=p_tenant AND app.access_workforce_command_company(c.id)) THEN
   RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=p_tenant AND e.employee_code=p_code
  AND e.id IS DISTINCT FROM p_exclude_employment) THEN RETURN 'employment'; END IF;
 IF EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.tenant_id=p_tenant AND d.reserved_employee_code=p_code
  AND d.id IS DISTINCT FROM p_exclude_draft) THEN RETURN 'draft'; END IF;
 RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_set_employee_code(p_employment uuid, p_code text, p_expected jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id(); subject public.employment%ROWTYPE; claimant text;
BEGIN
 PERFORM app.access_configuration_write_lock();
 SELECT * INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_command_company(subject.company_id) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 -- The public SQL command accepts canonical identifiers only; the shared TS format owner normalizes
 -- ordinary forms. No arbitrary column, person id, company or actor is accepted by this seam.
 IF p_code IS NULL OR p_code !~ '^[A-Z0-9-]{1,30}$' THEN RAISE EXCEPTION 'Employee ID invalid' USING ERRCODE='23514'; END IF;
 IF p_expected IS NOT NULL AND (jsonb_typeof(p_expected) NOT IN ('string','null')
  OR p_expected IS DISTINCT FROM coalesce(to_jsonb(subject.employee_code),'null'::jsonb)) THEN
  RAISE EXCEPTION 'Employee record changed' USING ERRCODE='40001';
 END IF;
 IF subject.employee_code=p_code THEN RETURN false; END IF;
 claimant:=app.employee_code_claim(t,p_code,p_employment,NULL);
 IF claimant IS NOT NULL THEN
  RAISE EXCEPTION '%','employee_code_claim_'||claimant USING ERRCODE='23505',CONSTRAINT='employee_code_claim_'||claimant;
 END IF;
 UPDATE public.employment SET employee_code=p_code WHERE id=p_employment AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(t,'employment',p_employment,'employment.employee-code.set',
  CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),p_employment,
  jsonb_build_object('before',jsonb_build_object('employeeCode',subject.employee_code),'after',jsonb_build_object('employeeCode',p_code)));
 RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_company_classify(p_company uuid, p_disposition text, p_canonical uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); previous jsonb;
BEGIN
 PERFORM app.access_configuration_write_lock();
 IF actor IS NULL OR NOT app.reward_admin(p_company) OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_company AND tenant_id=t)
 THEN RAISE EXCEPTION 'Rewards company permission required' USING ERRCODE='42501'; END IF;
 IF p_disposition IS NULL OR p_disposition NOT IN ('visible','test_demo','alias') OR p_reason IS NULL OR length(app.reward_exclusion_reason_trim(p_reason)) NOT BETWEEN 10 AND 2000
 OR (p_disposition='alias') IS DISTINCT FROM (p_canonical IS NOT NULL) OR p_canonical=p_company
 THEN RAISE EXCEPTION 'Select an explicit designation and supply a reviewed reason' USING ERRCODE='23514'; END IF;
 IF p_canonical IS NOT NULL THEN
  IF NOT app.reward_admin(p_canonical) OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_canonical AND tenant_id=t AND archived_at IS NULL)
  THEN RAISE EXCEPTION 'Canonical company permission required' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.reward_company_classification WHERE tenant_id=t AND company_id=p_canonical AND disposition<>'visible')
  THEN RAISE EXCEPTION 'Canonical company must be visible' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_disposition<>'visible' AND EXISTS(SELECT 1 FROM public.reward_company_classification WHERE tenant_id=t AND canonical_company_id=p_company)
 THEN RAISE EXCEPTION 'Resolve existing aliases before hiding their canonical company' USING ERRCODE='23514'; END IF;
 SELECT jsonb_build_object('disposition',disposition,'canonicalCompanyId',canonical_company_id,'reason',reason) INTO previous
 FROM public.reward_company_classification WHERE tenant_id=t AND company_id=p_company;
 INSERT INTO public.reward_company_classification(tenant_id,company_id,disposition,canonical_company_id,reason,updated_by)
 VALUES(t,p_company,p_disposition,p_canonical,app.reward_exclusion_reason_trim(p_reason),actor)
 ON CONFLICT(tenant_id,company_id) DO UPDATE SET disposition=excluded.disposition,canonical_company_id=excluded.canonical_company_id,reason=excluded.reason,updated_by=actor,updated_at=now();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'reward-company-classification',p_company,'reward.company-classified','user',actor,
 jsonb_build_object('previous',previous,'disposition',p_disposition,'canonicalCompanyId',p_canonical,'reason',app.reward_exclusion_reason_trim(p_reason)));
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_company_exclusion_change(p_company uuid, p_year integer, p_reason text, p_end_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); result uuid; event_name text;
BEGIN
 PERFORM app.access_configuration_write_lock();
 IF actor IS NULL OR NOT app.reward_admin(p_company) OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=t)
 THEN RAISE EXCEPTION 'Rewards company permission required' USING ERRCODE='42501'; END IF;
 IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2200 OR p_reason IS NULL OR length(app.reward_exclusion_reason_trim(p_reason)) NOT BETWEEN 10 AND 2000
 THEN RAISE EXCEPTION 'A reward year and reason of 10 to 2000 characters are required' USING ERRCODE='23514'; END IF;
 IF p_end_id IS NULL THEN
  INSERT INTO public.reward_company_exclusion(tenant_id,company_id,year,reason,created_by) VALUES(t,p_company,p_year,app.reward_exclusion_reason_trim(p_reason),actor) RETURNING id INTO result;
  event_name:='reward.company-excluded';
 ELSE
  UPDATE public.reward_company_exclusion SET ended_by=actor,ended_at=now(),end_reason=app.reward_exclusion_reason_trim(p_reason)
   WHERE id=p_end_id AND tenant_id=t AND company_id=p_company AND year=p_year AND ended_at IS NULL RETURNING id INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'Company exclusion changed' USING ERRCODE='40001'; END IF;
  event_name:='reward.company-exclusion-ended';
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'reward-company-exclusion',result,event_name,'user',actor,jsonb_build_object('companyId',p_company,'year',p_year,'reason',app.reward_exclusion_reason_trim(p_reason)));
 RETURN result;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_access_request_prepare(p_changes jsonb, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();c jsonb;target jsonb;u public.reward_unit;k uuid;revisions jsonb:='{}';snapshots jsonb:='{}';fingerprints jsonb:='{}';request_id uuid:=gen_random_uuid();
BEGIN
 PERFORM app.access_configuration_write_lock();
 IF actor IS NULL OR jsonb_typeof(p_changes)<>'array' OR jsonb_array_length(p_changes) NOT BETWEEN 1 AND 500 OR octet_length(p_changes::text)>2000000 THEN RAISE EXCEPTION 'invalid access request' USING ERRCODE='23514'; END IF;
 IF COALESCE(length(app.reward_access_reason_trim(p_reason)),0)<10 OR length(p_reason)>2000 THEN RAISE EXCEPTION 'access request reason required' USING ERRCODE='23514'; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
 IF jsonb_typeof(c)<>'object' OR NOT (c ?& ARRAY['unitId','revision','before','after']) OR c-ARRAY['unitId','revision','before','after']<>'{}'::jsonb OR jsonb_typeof(c->'before') NOT IN('object','null') OR jsonb_typeof(c->'after') NOT IN('object','null') OR (c->'before'='null'::jsonb AND c->'after'='null'::jsonb) THEN RAISE EXCEPTION 'invalid access change shape' USING ERRCODE='23514'; END IF;
 FOR target IN SELECT member FROM (VALUES(c->'before'),(c->'after')) x(member) WHERE member<>'null'::jsonb LOOP
 IF NOT (target ?& ARRAY['userId','role']) OR target->>'role' NOT IN('bu','bg','gr','ctro','ec','pbp','payroll') OR target-ARRAY['userId','role','validFrom','validTo','coversUserId','restoreReason','restoreFingerprint']<>'{}'::jsonb THEN RAISE EXCEPTION 'invalid access assignment shape' USING ERRCODE='23514'; END IF;
 END LOOP;
 END LOOP;
 FOR k IN SELECT DISTINCT (value->>'unitId')::uuid FROM jsonb_array_elements(p_changes) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR NOT app.reward_access_scope(u.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF u.status<>'draft' THEN RAISE EXCEPTION 'access request locked' USING ERRCODE='40001'; END IF;
 revisions:=revisions||jsonb_build_object(k::text,u.revision);snapshots:=snapshots||jsonb_build_object(k::text,app.reward_access_members_snapshot(k));
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
 IF NOT app.reward_access_change_allowed(c) THEN RAISE EXCEPTION 'bounded access request scope' USING ERRCODE='42501'; END IF;
 IF c->'before'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=(c->>'unitId')::uuid AND m.tenant_id=t AND m.user_id=(c->'before'->>'userId')::uuid AND m.role=c->'before'->>'role') THEN RAISE EXCEPTION 'access membership changed' USING ERRCODE='40001'; END IF;
 IF (c->>'revision')::int IS DISTINCT FROM (revisions->>(c->>'unitId'))::int THEN RAISE EXCEPTION 'access request changed' USING ERRCODE='40001'; END IF;
 IF c->'after'->>'coversUserId' IS NOT NULL AND (c->'after'->>'validTo' IS NULL OR c->'after'->>'coversUserId'=c->'after'->>'userId' OR NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.tenant_id=t AND m.unit_id=(c->>'unitId')::uuid AND m.user_id=(c->'after'->>'coversUserId')::uuid AND m.role=c->'after'->>'role')) THEN RAISE EXCEPTION 'a proxy needs an existing holder and an end date' USING ERRCODE='23514'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND (c->'before'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role' OR NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=(c->>'unitId')::uuid AND m.tenant_id=t AND m.user_id=(c->'before'->>'userId')::uuid AND m.role=c->'before'->>'role' AND app.reward_member_state(m.id)->>'reason' IN('notice','assignment'))) THEN RAISE EXCEPTION 'only a suspended existing assignment can be restored' USING ERRCODE='23514'; END IF;
 IF c->'after'->>'restoreReason' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app.reward_roles((c->>'unitId')::uuid) role WHERE role='gr') THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 IF c->'after'<>'null'::jsonb AND c->'after'->>'restoreReason' IS NULL AND NOT app.reward_access_candidate_eligible((c->>'unitId')::uuid,(c->'after'->>'userId')::uuid,c->'after'->>'role') THEN RAISE EXCEPTION 'access account eligibility changed' USING ERRCODE='42501'; END IF;
 IF c->'after'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(c->'after'->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id) AND app.reward_access_candidate_visible((c->>'unitId')::uuid,x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT jsonb_agg(
 jsonb_set(jsonb_set(value,'{before}',CASE WHEN value->'before'='null'::jsonb THEN 'null'::jsonb ELSE (SELECT jsonb_build_object('userId',m.user_id,'role',m.role,'validFrom',m.valid_from,'validTo',m.valid_to,'coversUserId',m.covers_user_id) FROM public.reward_member m WHERE m.tenant_id=t AND m.unit_id=(value->>'unitId')::uuid AND m.user_id=(value->'before'->>'userId')::uuid AND m.role=value->'before'->>'role') END),'{after}',CASE WHEN value->'after'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('validFrom',COALESCE(value->'after'->>'validFrom',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text),'validTo',NULL,'coversUserId',NULL)||value->'after' END)
 ORDER BY ord) INTO p_changes FROM jsonb_array_elements(p_changes) WITH ORDINALITY x(value,ord);
 SELECT jsonb_agg(CASE WHEN value->'after'->>'restoreReason' IS NULL THEN value ELSE jsonb_set(value,'{after,restoreFingerprint}',to_jsonb(app.reward_member_people_fingerprint((value->'after'->>'userId')::uuid,(value->>'unitId')::uuid))) END ORDER BY ord) INTO p_changes FROM jsonb_array_elements(p_changes) WITH ORDINALITY x(value,ord);
 SELECT COALESCE(jsonb_object_agg(x.unit_id||':'||x.user_id,app.reward_member_people_fingerprint(x.user_id::uuid,x.unit_id::uuid)),'{}'::jsonb) INTO fingerprints FROM (SELECT DISTINCT value->>'unitId' as unit_id,member->>'userId' as user_id FROM jsonb_array_elements(p_changes) c(value) CROSS JOIN LATERAL (VALUES(value->'before'),(value->'after')) m(member) WHERE member<>'null'::jsonb) x;
 INSERT INTO public.reward_access_request(id,tenant_id,changes,unit_revisions,before_members,people_fingerprints,requested_by,request_reason,requester_authority) VALUES(request_id,t,p_changes,revisions,snapshots,fingerprints,actor,app.reward_access_reason_trim(p_reason),(SELECT jsonb_object_agg(k.key,app.reward_access_requester_fingerprint(actor,k.key::uuid)) FROM jsonb_each(revisions) k));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',request_id,'reward-access.requested','user',actor,jsonb_build_object('changes',p_changes,'reason',app.reward_access_reason_trim(p_reason)));
 RETURN request_id;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_access_request_apply(wanted_request uuid, p_approve boolean, p_reason text, p_immediate boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE q public.reward_access_request;t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();u public.reward_unit;c jsonb;target jsonb;k uuid;member_id uuid;before_coverage jsonb:='{}';exemptions jsonb;outcome text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM app.access_configuration_write_lock();
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t;
 IF q.id IS NULL OR NOT app.reward_access_request_authorised(q.id) THEN RAISE EXCEPTION 'access request scope' USING ERRCODE='42501'; END IF;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 -- Identity/archival writers join this canonical access barrier (0579); tuple locks here
 -- would reverse their tuple-before-trigger ordering and deadlock an in-flight archive.
 IF NOT p_immediate AND NOT app.reward_access_request_independent(q.id,actor) THEN RAISE EXCEPTION 'independent Group Rewards checker required' USING ERRCODE='42501'; END IF;
 IF p_immediate THEN
 SELECT jsonb_object_agg(k.key,app.reward_access_exemption(k.key::uuid)) INTO exemptions FROM jsonb_each(q.unit_revisions) k;
 IF actor IS DISTINCT FROM q.requested_by OR EXISTS(SELECT 1 FROM jsonb_each(q.unit_revisions) k WHERE app.reward_access_exemption(k.key::uuid) IS NULL) THEN RAISE EXCEPTION 'immediate access authority changed' USING ERRCODE='42501'; END IF;
 ELSIF NOT app.reward_access_request_can_decide(q.id) THEN RAISE EXCEPTION 'independent Group Rewards checker required' USING ERRCODE='42501'; END IF;
 p_reason:=app.reward_access_reason_trim(p_reason);
 IF p_approve IS NULL OR COALESCE(length(p_reason),0)>2000 THEN RAISE EXCEPTION 'invalid access decision' USING ERRCODE='23514'; END IF;
 outcome:=CASE WHEN p_immediate THEN 'applied_no_second_approval' WHEN p_approve THEN 'approved' ELSE 'rejected' END;
 IF NOT p_approve AND COALESCE(length(app.reward_access_reason_trim(p_reason)),0)<10 THEN RAISE EXCEPTION 'rejection reason required' USING ERRCODE='23514'; END IF;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 SELECT * INTO u FROM public.reward_unit WHERE id=k AND tenant_id=t FOR UPDATE;
 IF u.id IS NULL OR u.deleted_at IS NOT NULL OR u.status<>'draft' OR u.revision IS DISTINCT FROM (q.unit_revisions->>k::text)::int OR app.reward_access_members_snapshot(k) IS DISTINCT FROM q.before_members->k::text THEN outcome:='lapsed'; END IF;
 before_coverage:=before_coverage||jsonb_build_object(k::text,COALESCE((SELECT jsonb_agg(DISTINCT m.role) FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND app.reward_member_eligible_internal(m.id) AND (m.role='gr' OR m.role=ANY(app.reward_required_access_roles(k)))),'[]'::jsonb));
 END LOOP;
 SELECT * INTO q FROM public.reward_access_request WHERE id=wanted_request AND tenant_id=t FOR UPDATE;
 IF q.status<>'pending' THEN RAISE EXCEPTION 'access request already decided' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each_text(q.people_fingerprints) p WHERE p.value IS DISTINCT FROM app.reward_member_people_fingerprint(split_part(p.key,':',2)::uuid,split_part(p.key,':',1)::uuid)) THEN outcome:='lapsed'; END IF;
 IF app.reward_access_requester_stale(q.id) THEN outcome:='lapsed'; END IF;
 IF outcome IN('approved','applied_no_second_approval') THEN
 -- Add replacements before removing the previous holders, preserving existing coverage guards.
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 target:=c->'after';
 IF target IS NOT NULL AND target<>'null'::jsonb THEN
 IF NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.id=(target->>'userId')::uuid AND x.tenant_id=t AND x.archived_at IS NULL AND NOT app.login_blocked(x.id)) THEN RAISE EXCEPTION 'access account unavailable' USING ERRCODE='42501'; END IF;
 IF (target->>'restoreReason') IS NOT NULL AND (length(app.reward_access_reason_trim(target->>'restoreReason'))<10 OR target->>'restoreFingerprint' IS DISTINCT FROM app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid)) THEN RAISE EXCEPTION 'Group Rewards restore required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.reward_member(tenant_id,unit_id,user_id,role,valid_from,valid_to,covers_user_id,restored_reason,restored_fingerprint)
 VALUES(t,(c->>'unitId')::uuid,(target->>'userId')::uuid,target->>'role',COALESCE((target->>'validFrom')::date,day),(target->>'validTo')::date,(target->>'coversUserId')::uuid,target->>'restoreReason',CASE WHEN target->>'restoreReason' IS NOT NULL THEN app.reward_member_people_fingerprint((target->>'userId')::uuid,(c->>'unitId')::uuid) END)
 ON CONFLICT(unit_id,user_id,role) DO UPDATE SET valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to,covers_user_id=EXCLUDED.covers_user_id,restored_reason=COALESCE(EXCLUDED.restored_reason,reward_member.restored_reason),restored_fingerprint=COALESCE(EXCLUDED.restored_fingerprint,reward_member.restored_fingerprint);
 END IF;
 END LOOP;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) LOOP
 IF c->'before'<>'null'::jsonb AND (c->'after'='null'::jsonb OR c->'before'->>'userId' IS DISTINCT FROM c->'after'->>'userId' OR c->'before'->>'role' IS DISTINCT FROM c->'after'->>'role') THEN
 DELETE FROM public.reward_member WHERE tenant_id=t AND unit_id=(c->>'unitId')::uuid AND user_id=(c->'before'->>'userId')::uuid AND role=c->'before'->>'role';
 END IF;
 END LOOP;
 FOR k IN SELECT key::uuid FROM jsonb_each(q.unit_revisions) ORDER BY 1 LOOP
 IF (NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role='gr' AND app.reward_member_eligible_internal(m.id))
     AND NOT EXISTS(SELECT 1 FROM app.reward_group_coverage_roles(k) role WHERE role='gr')) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(before_coverage->k::text) old_role(role) WHERE NOT EXISTS(SELECT 1 FROM public.reward_member m WHERE m.unit_id=k AND m.tenant_id=t AND m.role=old_role.role AND app.reward_member_eligible_internal(m.id))
     AND NOT EXISTS(SELECT 1 FROM app.reward_group_coverage_roles(k) role WHERE role=old_role.role)) THEN RAISE EXCEPTION 'required Rewards role must remain covered' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(q.changes) change WHERE change->>'unitId'=k::text AND (change->'before'->>'role' IN('bg','ec') OR change->'after'->>'role' IN('bg','ec'))) THEN PERFORM app.reward_access_refresh_confidentiality(k); END IF;
 PERFORM set_config('app.reward_approving_request',q.id::text,true);
 UPDATE public.reward_unit SET revision=revision+1,approved_digest=NULL,updated_at=now() WHERE id=k AND tenant_id=t;
 FOR c IN SELECT value FROM jsonb_array_elements(q.changes) WHERE value->>'unitId'=k::text LOOP
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',k,'reward-unit.access-changed','user',actor,jsonb_build_object('before',c->'before','after',c->'after','revision',(q.unit_revisions->>k::text)::int+1,'batchId',q.id,'requestId',q.id,'requestedBy',q.requested_by,'reason',q.request_reason,'disposition',outcome));
 END LOOP;
 END LOOP;
 END IF;
 UPDATE public.reward_access_request SET status=outcome,decided_by=CASE WHEN p_immediate THEN NULL ELSE actor END,decided_at=now(),exemption_basis=CASE WHEN p_immediate THEN exemptions ELSE NULL END,reason=nullif(btrim(p_reason),'') WHERE id=q.id;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access-request',q.id,'reward-access.'||outcome,'user',actor,jsonb_build_object('requestedBy',q.requested_by,'changes',q.changes,'reason',nullif(btrim(p_reason),''),'exemptionBasis',CASE WHEN p_immediate THEN exemptions ELSE NULL END));
 RETURN outcome;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_checkin_schedule_prepare(p_id uuid, p_person uuid, p_employment uuid, p_company uuid, p_subject_person uuid, p_planned uuid, p_date date, p_manager uuid, p_intent_digest text, p_reviewed_digest text, p_kid text, p_wrapped_dek text, p_ciphertext text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_configuration_write_lock();
 PERFORM 1 FROM public.employment WHERE id=p_employment AND tenant_id=t FOR UPDATE;
 PERFORM app._assistant_assigned_review_binding('performance.checkin.schedule',p_person,p_employment,p_company,p_subject_person,p_employment);
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person]))
 OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(ARRAY[p_person,p_subject_person]))
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='42501';END IF;
 IF p_manager IS DISTINCT FROM app.performance_current_admin_manager(t,p_employment) OR p_id IS NULL OR p_planned IS NULL OR p_date IS NULL OR EXISTS(SELECT 1 FROM public.performance_checkin WHERE id=p_planned)
 OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$'
 OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536
 OR (p_manager IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment WHERE id=p_manager AND tenant_id=t))
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5
 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20
 THEN RAISE EXCEPTION 'Scheduling review unavailable' USING ERRCODE='54000';END IF;
 WITH expired AS (UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL
 WHERE tenant_id=t AND user_id=u AND action_kind='performance.checkin.schedule' AND state='awaiting_confirmation' AND expires_at<=at_time RETURNING id)
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id IN (SELECT id FROM expired);
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,decision_subject_person_id,receipt_subject_kind,receipt_subject_id,
 intent_digest,reviewed_digest,state,created_at,expires_at,checkin_schedule_planned_id,checkin_schedule_date,checkin_schedule_manager_id)
 VALUES('performance.checkin.schedule',p_id,t,u,p_person,p_employment,p_company,p_subject_person,'employment',p_employment,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes',p_planned,p_date,p_manager);
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_checkin_schedule_json(p_id);
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_catalogue_native_arm(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE r app.assistant_own_leave_review%ROWTYPE;held app.assistant_own_leave_review%ROWTYPE;source jsonb;after_source jsonb;k text;
BEGIN
 PERFORM app.access_configuration_write_lock();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
 AND action_kind IN('org.position.archive','org.department.archive','org.employee_id_template.status');
 IF NOT FOUND OR r.state<>'awaiting_confirmation' OR r.catalogue_native_phase IS NOT NULL OR clock_timestamp()>=r.expires_at
  OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_pay_component_review_identity(r.person_id);
 IF r.action_kind<>'org.employee_id_template.status' THEN
  IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
   OR NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||r.tenant_id::text,0)) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
  FOREACH k IN ARRAY ARRAY['department','position','cost_center','business_unit'] LOOP
   INSERT INTO public.system_label_criteria_epoch(tenant_id,label_kind) VALUES(r.tenant_id,k) ON CONFLICT DO NOTHING;
   PERFORM revision FROM public.system_label_criteria_epoch WHERE tenant_id=r.tenant_id AND label_kind=k FOR UPDATE;
  END LOOP;
 END IF;
 IF r.action_kind='org.position.archive' THEN
  PERFORM 1 FROM public.position WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.position_archive_grid_source(r.receipt_subject_id);
  IF(source->>'archived')::boolean IS NOT DISTINCT FROM r.position_archive_desired OR(r.position_archive_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.action_kind='org.department.archive' THEN
  PERFORM 1 FROM public.department WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.department_archive_grid_source(r.receipt_subject_id);
  IF(source->>'archived')::boolean IS NOT DISTINCT FROM r.department_archive_desired OR(r.department_archive_desired AND(source->>'inUse')::boolean) THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 ELSE
  PERFORM 1 FROM public.employee_id_config WHERE id=r.receipt_subject_id AND tenant_id=r.tenant_id FOR UPDATE;source:=app.employee_id_template_status_source(r.receipt_subject_id);
  IF source->>'status' IS NOT DISTINCT FROM r.employee_id_template_desired_status THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 END IF;
 IF(source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Catalogue interval unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO held FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF to_jsonb(held) IS DISTINCT FROM to_jsonb(r) THEN RAISE EXCEPTION 'Catalogue pending binding changed' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_catalogue_native_phase(r.id,'armed');
 after_source:=CASE r.action_kind WHEN 'org.position.archive' THEN app.position_archive_grid_source(r.receipt_subject_id) WHEN 'org.department.archive' THEN app.department_archive_grid_source(r.receipt_subject_id) ELSE app.employee_id_template_status_source(r.receipt_subject_id) END;
 IF after_source IS DISTINCT FROM source THEN RAISE EXCEPTION 'Catalogue source changed while arming' USING ERRCODE='42501';END IF;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.consume_invitation(p_raw_token text, p_subject text)
 RETURNS TABLE(app_user_id uuid, tenant_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_hash text := encode(sha256(convert_to(p_raw_token, 'UTF8')), 'hex');
  v_inv  public.app_invitation%ROWTYPE;
  v_user_id uuid;
  v_bound_subject text;
  v_logins int;
  v_tenant uuid;
BEGIN
  -- Account creation is an authority change: own the exclusive Access lock before any row lock.
  SELECT i.tenant_id INTO v_tenant FROM public.app_invitation i WHERE i.token_hash = v_hash;
  IF v_tenant IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||v_tenant::text,0));
  END IF;
  -- Atomic single-use claim: only a still-pending, unexpired invitation flips to accepted; a concurrent
  -- second consume of the same token affects 0 rows and drops through to the NOT FOUND branch.
  UPDATE public.app_invitation
     SET status = 'accepted', accepted_at = now()
   WHERE token_hash = v_hash AND status = 'pending' AND expires_at > now()
  RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RETURN; -- unknown / already-consumed / expired token → 0 rows (caller throws InvalidInvitation)
  END IF;

  -- ── SLICE-0 GUARD A: the row's own shape ───────────────────────────────────────────────────────
  -- The last line of defence for a row that predates the WITH CHECK and the CHECK constraints above.
  -- ROW facts only (see this file's header for why inviter-context conjuncts cannot be re-checked
  -- here). Every RAISE aborts the transaction, so the `status = 'accepted'` flip above is rolled back
  -- too — a refused invitation is left pending rather than silently burned, and the refusal is
  -- visible in the log instead of manifesting as a mysterious missing grant.
  IF v_inv.role = 'operator' THEN
    RAISE EXCEPTION 'invitation refused: the operator role is not grantable by invitation (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_inv.role NOT IN ('employee', 'manager', 'hr_admin', 'super_admin', 'payroll_partner', 'performance_comp_partner', 'performance_partner') THEN
    RAISE EXCEPTION 'invitation refused: % is not a valid customer role (invitation %)', v_inv.role, v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Mirrors 0020's role_assignment_super_admin_group_wide. Without this the row would still be refused
  -- — but 40 lines later, by that constraint, as an opaque 23514 from inside a definer function.
  IF v_inv.role = 'super_admin' AND v_inv.company_id IS NOT NULL THEN
    RAISE EXCEPTION 'invitation refused: super_admin is group-wide only, it cannot be scoped to a company (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The FK payloads must live in the invitation's own tenant (see 1a′). Still a pure ROW fact — it is a
  -- property of the rows this row points at, not of anybody's session — so it belongs in guard A.
  IF NOT app.invitation_refs_in_tenant(v_inv.tenant_id, v_inv.company_id, v_inv.person_id) THEN
    RAISE EXCEPTION 'invitation refused: it names a company or person outside its own tenant (invitation %)', v_inv.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Create or link the app_user for this subject. If a person was targeted and already has an app_user,
  -- attach the subject to it; otherwise insert a new one. workos_user_id is globally unique, so a subject
  -- already bound to another user makes this fail loudly (correct: one subject = one user).
  --
  -- WHICH LOGIN, EXACTLY. Nothing enforces one app_user per person — there is no unique index on
  -- (tenant_id, person_id) — and app_user's policy lets any group admin INSERT more. The original
  -- `LIMIT 1` with no ORDER BY therefore let an arbitrary row decide guard B's whole verdict
  -- (placeholder-or-not, grants-or-not), and a planted grant-less `seed:` twin could be made to win it.
  -- Two logins for one person is a state nobody should silently pick a winner in, so it is refused
  -- outright; the ORDER BY makes the single-row case deterministic rather than plan-dependent.
  IF v_inv.person_id IS NOT NULL THEN
    PERFORM 1 FROM public.person p WHERE p.id=v_inv.person_id AND p.tenant_id=v_inv.tenant_id FOR UPDATE;
    SELECT count(*) INTO v_logins
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id;
    IF v_logins > 1 THEN
      RAISE EXCEPTION 'invitation refused: that person has % logins, so there is no single login to activate (invitation %)', v_logins, v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Aliased (u.) — an unqualified tenant_id here collides with the RETURNS TABLE OUT parameter.
    SELECT u.id, u.workos_user_id INTO v_user_id, v_bound_subject
      FROM public.app_user u
     WHERE u.tenant_id = v_inv.tenant_id AND u.person_id = v_inv.person_id
     ORDER BY u.created_at, u.id
     LIMIT 1;
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.app_user (tenant_id, workos_user_id, person_id)
    VALUES (v_inv.tenant_id, p_subject, v_inv.person_id)
    RETURNING id INTO v_user_id;
  ELSIF v_bound_subject IS DISTINCT FROM p_subject THEN
    -- ── SLICE-0 GUARD B: the rebind is an ACTIVATION, never a takeover ───────────────────────────
    -- This branch re-points an existing login at whoever is holding the token. That is legitimate for
    -- a login created ahead of its human (provisioning, seed, bootstrap-invite) and it is an identity
    -- theft for any other. It is what closes hole (3) for EVERY inviter, including a group admin and
    -- including a row forged before layer 1 existed — the person-scope conjunct in the WITH CHECK
    -- narrows who can aim at whom, this decides whether the shot lands at all.
    --
    -- The ELSIF is the no-false-positive half: when the bound subject IS the accepter's, the UPDATE
    -- below would set the column to the value it already holds. Nothing is taken over, so nothing is
    -- refused — re-inviting an existing user (to add a second grant) is a live UI path and it worked
    -- before this migration. See this file's header.
    --
    -- TWO questions have to be asked, because "activated" and "carries authority" are NOT the same
    -- question and only the second one is about privilege:
    IF NOT app.is_placeholder_subject(v_bound_subject) THEN
      -- (i) IDENTITY. A non-placeholder subject means a real human has authenticated as this login;
      -- re-pointing it steals their identity and locks them out (their old subject then resolves to
      -- no row at all).
      RAISE EXCEPTION 'invitation refused: that person already has an activated login, which an invitation may not re-bind (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.role_assignment ra
       WHERE ra.app_user_id = v_user_id
         AND NOT app.invitation_confers(v_inv.role, v_inv.company_id, ra.role::text, ra.company_id)
    ) THEN
      -- (ii) AUTHORITY, and this is the one a placeholder check alone gets WRONG. The grants are
      -- attached to the app_user BEFORE anyone authenticates as it, so "nobody has logged in yet"
      -- does not mean "there is nothing to steal": db/seed.ts:167 and test/operator-provision.test.ts
      -- both build `provision:<uuid>`/`user_dev_admin` logins that already carry a group-wide hr_admin.
      -- Without this conjunct a company-scoped hr_admin could write a wholly LEGITIMATE-looking
      -- invitation (role hr_admin, its own company, a person it administers — every layer-1 conjunct
      -- satisfied), consume it from a fresh subject, land on that pending admin's login and inherit
      -- its group-wide grant.
      --
      -- SUBSET, NOT EQUALITY — see app.invitation_confers above. The rebind is refused only when the
      -- login carries authority this invitation does not itself confer, which is a question about the
      -- ROLE LADDER and the SCOPE, not about tuple identity. "No grants at all" was rejected because it
      -- breaks scripts/auth/bootstrap-invite.ts, whose entire job is to rebind a SEEDED placeholder, and
      -- seeded placeholders carry grants (db/seed.ts:167 withRoleAssignment: true, :262-268, :493-499).
      -- Tuple EQUALITY was the same mistake one step smaller: it refused a login whose only grant was
      -- strictly weaker than the invitation's, which is precisely what those seeded logins carry.
      -- Anything the invitation confers, layer 1 already proved the inviter was allowed to write.
      RAISE EXCEPTION 'invitation refused: that login already carries a grant this invitation does not confer, so re-binding it would hand the accepter authority the inviter never had (invitation %)', v_inv.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    UPDATE public.app_user SET workos_user_id = p_subject WHERE id = v_user_id;
  END IF;

  INSERT INTO public.role_assignment (tenant_id, app_user_id, company_id, role)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.company_id, v_inv.role::public.role);

  RETURN QUERY SELECT v_user_id, v_inv.tenant_id;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.manual_identity_link(p_id uuid, p_subject text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v public.app_manual_identity_enrollment%ROWTYPE; v_user uuid; v_legacy text;
BEGIN
 SELECT * INTO v FROM app.manual_identity_read(p_id,true);
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||v.tenant_id::text,0));
 IF v.status IN ('linked','active') AND v.subject=p_subject THEN RETURN v.app_user_id; END IF;
 IF v.status<>'prepared' OR v.subject IS DISTINCT FROM p_subject OR p_subject IS NULL OR p_subject !~ '^[a-zA-Z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'manual_identity_conflict'; END IF;
 v_user:=app.manual_identity_target(v.person_id,v.role,v.company_id);
 IF EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.issuer=v.issuer AND i.subject=p_subject) THEN
  RAISE EXCEPTION 'manual_identity_conflict';
 END IF;
 v_legacy:='oidc:'||encode(sha256(convert_to(v.issuer||chr(10)||p_subject,'UTF8')),'hex');
 IF v_user IS NULL THEN
  INSERT INTO public.app_user(tenant_id,person_id,workos_user_id) VALUES(v.tenant_id,v.person_id,v_legacy) RETURNING id INTO v_user;
 ELSE UPDATE public.app_user SET workos_user_id=v_legacy WHERE id=v_user; END IF;
 INSERT INTO public.app_external_identity(issuer,subject,app_user_id) VALUES(v.issuer,p_subject,v_user);
 INSERT INTO public.role_assignment(tenant_id,app_user_id,role,company_id)
 SELECT v.tenant_id,v_user,v.role::public.role,v.company_id
 WHERE NOT EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=v.tenant_id
  AND r.app_user_id=v_user AND r.role=v.role::public.role AND r.company_id IS NOT DISTINCT FROM v.company_id);
 UPDATE public.app_manual_identity_enrollment SET status='linked',subject=p_subject,app_user_id=v_user WHERE id=p_id;
 PERFORM app.append_auth_event(v.tenant_id,'app-user',v_user,'app-user.manual-enrollment-linked','user',app.current_user_id(),jsonb_build_object('enrollmentId',v.id));
 RETURN v_user;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.entra_auto_bind(p_tenant uuid, p_person uuid, p_revision bigint, p_lease uuid, p_object uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE c public.entra_connector%ROWTYPE; u uuid; iss text; d date;
BEGIN
 -- Creating a login is an authority change. Only when one may be created, and before any row lock.
 IF NOT EXISTS(SELECT 1 FROM public.app_user x WHERE x.tenant_id=p_tenant AND x.person_id=p_person) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||p_tenant::text,0));
 END IF;
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
$function$;
