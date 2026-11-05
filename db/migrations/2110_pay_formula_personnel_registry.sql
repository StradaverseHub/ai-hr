-- Additive, explicit metadata bindings to the closed software-owned Personnel source adapters.
CREATE TABLE pay_formula_personnel_registration (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),source_key text NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>0),label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 120),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),enabled boolean NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,source_key,ordinal)
);
--> statement-breakpoint
ALTER TABLE pay_formula_personnel_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_formula_personnel_registration FORCE ROW LEVEL SECURITY;
REVOKE ALL ON pay_formula_personnel_registration FROM PUBLIC,ai_hr_app;
GRANT SELECT ON pay_formula_personnel_registration TO ai_hr_app;
CREATE POLICY pay_formula_personnel_registration_read ON pay_formula_personnel_registration FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.pay_formula_catalog_access());
CREATE POLICY pay_formula_personnel_registration_native ON pay_formula_personnel_registration FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app' AND app.pay_formula_catalog_access());
--> statement-breakpoint
CREATE FUNCTION app.pay_formula_personnel_register(p_source text,p_label text,p_description text,p_enabled boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); actor uuid:=app.current_user_id(); next_ordinal integer; result uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
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
END $$;
REVOKE ALL ON FUNCTION app.pay_formula_personnel_register(text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_formula_personnel_register(text,text,text,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.pay_formula_personnel_registration_audit_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='pay-formula-personnel-registration' OR NEW.event_type='pay-formula.personnel-registered') AND NOT app.acting_as_owner()
 THEN RAISE EXCEPTION 'Formula field audit requires its native writer' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.pay_formula_personnel_registration_audit_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER pay_formula_personnel_registration_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.pay_formula_personnel_registration_audit_owner();
