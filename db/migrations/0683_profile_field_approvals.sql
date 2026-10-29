-- Extend the immutable physical binding map to the existing statutory descriptors.
CREATE OR REPLACE FUNCTION app.access_profile_value_bindings()
RETURNS TABLE(field_id text,owner text,column_name text,field_name text,legacy_key text,immediate boolean,primary_key text,tab_name text,section_name text)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$ VALUES
 ('profile.personal_details.salutation','person','salutation','salutation','salutation',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.fullname','person','full_name','fullName','fullName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.firstname','person','first_name','firstName','firstName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.lastname','person','last_name','lastName','lastName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.preferredname','person','preferred_name','preferredName','preferredName',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.nationality','person','nationality','nationality','nationality',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.religion','person','religion','religion','religion',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.race','person','race','race','race',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.dateofbirth','compliance','date_of_birth','dateOfBirth','dateOfBirth',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.gender','compliance','gender','gender','gender',false,NULL,'Profile','Personal details'),
 ('profile.personal_details.maritalstatus','compliance','marital_status','maritalStatus','maritalStatus',false,NULL,'Profile','Personal details'),
 ('profile.contact_and_permanent_address.primaryemail','person','primary_email','primaryEmail',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.phone','person','phone','phone',NULL,true,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.homephone','person','home_phone','homePhone',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.personalemail','person','personal_email','personalEmail',NULL,true,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline1','person','permanent_address_line1','permanentAddressLine1',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline2','person','permanent_address_line2','permanentAddressLine2',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentaddressline3','person','permanent_address_line3','permanentAddressLine3',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentpostcode','person','permanent_postcode','permanentPostcode',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentcity','person','permanent_city','permanentCity',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentstate','person','permanent_state','permanentState',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.contact_and_permanent_address.permanentcountry','person','permanent_country','permanentCountry',NULL,false,NULL,'Profile','Contact and permanent address'),
 ('profile.correspondence_address.correspondenceaddressline1','person','correspondence_address_line1','correspondenceAddressLine1',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondenceaddressline2','person','correspondence_address_line2','correspondenceAddressLine2',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondenceaddressline3','person','correspondence_address_line3','correspondenceAddressLine3',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencepostcode','person','correspondence_postcode','correspondencePostcode',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencecity','person','correspondence_city','correspondenceCity',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencestate','person','correspondence_state','correspondenceState',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencecountry','person','correspondence_country','correspondenceCountry',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencemobilephone','person','correspondence_mobile_phone','correspondenceMobilePhone',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.correspondence_address.correspondencehomephone','person','correspondence_home_phone','correspondenceHomePhone',NULL,false,NULL,'Profile','Correspondence address'),
 ('profile.emergency_contact.fullname','emergency','full_name','fullName',NULL,false,'legacyPrimaryEmergency.fullName','Profile','Emergency contact'),
 ('profile.emergency_contact.relationship','emergency','relationship','relationship',NULL,false,'legacyPrimaryEmergency.relationship','Profile','Emergency contact'),
 ('profile.emergency_contact.mobilephone','emergency','mobile_phone','mobilePhone',NULL,false,'legacyPrimaryEmergency.mobilePhone','Profile','Emergency contact'),
 ('profile.emergency_contact.homephone','emergency','home_phone','homePhone',NULL,false,'legacyPrimaryEmergency.homePhone','Profile','Emergency contact'),
 ('profile.emergency_contact.priority','emergency','priority','priority',NULL,false,NULL,'Profile','Emergency contact'),
 ('profile.emergency_contact.address','emergency','address','address',NULL,false,'legacyPrimaryEmergency.address','Profile','Emergency contact'),
 ('family.family_and_dependents.relationship','dependent','relationship','relationship',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.fullname','dependent','full_name','fullName',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.gender','dependent','gender','gender',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.dateofbirth','dependent','date_of_birth','dateOfBirth',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.phone','dependent','phone','phone',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.icorpassport','dependent','ic_or_passport','icOrPassport',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.passportnumber','dependent','passport_number','passportNumber',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.residentialaddress','dependent','residential_address','residentialAddress',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.marriagedate','dependent','marriage_date','marriageDate',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.marriagestatus','dependent','marriage_status','marriageStatus',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.spouseworking','dependent','spouse_working','spouseWorking',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isbeneficiary','dependent','is_beneficiary','isBeneficiary',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isdeceased','dependent','is_deceased','isDeceased',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.isstudent','dependent','is_student','isStudent',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.schoolname','dependent','school_name','schoolName',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.studylevel','dependent','study_level','studyLevel',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.studycountry','dependent','study_country','studyCountry',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childreliefcategory','dependent','child_relief_category','childReliefCategory',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childtaxrelief','dependent','child_tax_relief','childTaxRelief',NULL,false,NULL,'Family','Family and dependents'),
 ('family.family_and_dependents.childreliefpercentage','dependent','child_relief_percentage','childReliefPercentage',NULL,false,NULL,'Family','Family and dependents'),
 ('qualification.academic_and_professional_qualifications.level','qualification','qualification','qualification',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.institute','qualification','institute','institute',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.fromym','qualification','from_ym','fromYm',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.toym','qualification','to_ym','toYm',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.graduationdate','qualification','graduation_date','graduationDate',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.major','qualification','major','major',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.result','qualification','result','result',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.description','qualification','description','description',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('qualification.academic_and_professional_qualifications.highest','qualification','is_highest','isHighest',NULL,false,NULL,'Qualification','Academic and professional qualifications'),
 ('profile.identity_and_passport.icnumber','identity','ic_number','icNumber','icNumber',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.oldicnumber','identity','old_ic_number','oldIcNumber','oldIcNumber',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.passportnumber','passport','passport_number','passportNumber','passportNumber',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.passportissuedate','passport','passport_issue_date','passportIssueDate','passportIssueDate',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.passportexpirydate','passport','passport_expiry_date','passportExpiryDate','passportExpiryDate',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.passportissuingcountry','passport','passport_issuing_country','passportIssuingCountry','passportIssuingCountry',false,NULL,'Profile','Identity and passport'),
 ('profile.identity_and_passport.passportissuingcountrycode','passport','passport_issuing_country_code','passportIssuingCountryCode',NULL,false,NULL,'Profile','Identity and passport'),
 ('bank_statutory.bank_information.bankname','bank','bank_name','bankName','bankName',false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.bank_information.bankaccountno','bank','bank_account_no','bankAccountNo','bankAccountNo',false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.bank_information.enablecustomholdername','bank','enable_custom_holder_name','enableCustomHolderName',NULL,false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.bank_information.customholdername','bank','custom_holder_name','customHolderName',NULL,false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.bank_information.enablecustomholderid','bank','enable_custom_holder_id','enableCustomHolderId',NULL,false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.bank_information.customholderid','bank','custom_holder_id','customHolderId',NULL,false,NULL,'Bank & Statutory','Bank Information'),
 ('bank_statutory.epf_contribution.epfnumber','registration','epf_number','epfNumber','epfNumber',false,NULL,'Bank & Statutory','EPF contribution'),
 ('bank_statutory.socso_eis_and_others_statutory.socsonumber','registration','socso_number','socsoNumber','socsoNumber',false,NULL,'Bank & Statutory','SOCSO, EIS and Others Statutory'),
 ('bank_statutory.income_tax_pcb.taxnumber','taxLegacy','tax_number','taxNumber','taxNumber',false,NULL,'Bank & Statutory','Income Tax (PCB)'),
 ('bank_statutory.income_tax_pcb.taxcategory','taxLegacy','tax_category','taxCategory','taxCategory',false,NULL,'Bank & Statutory','Income Tax (PCB)'),
 ('bank_statutory.income_tax_pcb.numchildren','taxLegacy','num_children','numChildren','numChildren',false,NULL,'Bank & Statutory','Income Tax (PCB)'); $$;
--> statement-breakpoint
-- Approved board16173609. Additive request evidence and transaction-bound direct profile writes.
-- Journal allocation is parent-owned: idx669 / timestamp1793330000002, after0678.
CREATE OR REPLACE FUNCTION app.access_profile_value_editable(p_field text,p_primary boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b record;raw jsonb;cap text;linked text;linked_ids text[];
BEGIN
 SELECT * INTO b FROM app.access_profile_value_bindings() WHERE field_id=p_field;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT value INTO raw FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_change_fields';
 IF raw IS NULL OR raw='null'::jsonb OR raw='"all"'::jsonb OR jsonb_typeof(raw)='array' THEN
  IF jsonb_typeof(raw)='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(raw) v WHERE jsonb_typeof(v)<>'string') THEN RETURN false; END IF;
  IF p_primary THEN RETURN b.primary_key IS NOT NULL; END IF;
  RETURN b.immediate OR b.legacy_key IS NOT NULL AND (raw IS NULL OR raw IN ('null'::jsonb,'"all"'::jsonb) OR raw ? b.legacy_key);
 END IF;
 IF jsonb_typeof(raw)<>'object' THEN RETURN false; END IF;
 IF raw->'version'='2'::jsonb THEN
  IF (SELECT count(*) FROM jsonb_object_keys(raw))<>2 OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(raw->'fields')>512 OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'fields') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
   OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'fields') v)<>jsonb_array_length(raw->'fields') THEN RETURN false; END IF;
  RETURN raw->'fields' ? CASE WHEN p_primary THEN b.primary_key ELSE b.field_id END;
 END IF;
 IF raw->'version' NOT IN ('3'::jsonb,'4'::jsonb,'5'::jsonb) OR raw->'version' IS NULL
  OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(raw->'primaryOnly') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(raw))<>(CASE WHEN raw->'version'='3'::jsonb THEN 3 WHEN raw->'version'='5'::jsonb THEN 5 ELSE 4 END)
  OR (SELECT count(*) FROM jsonb_object_keys(raw->'fields'))>512 OR jsonb_array_length(raw->'primaryOnly')>512
  OR EXISTS(SELECT 1 FROM jsonb_each(raw->'fields') f WHERE length(f.key) NOT BETWEEN 1 AND 200 OR f.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'primaryOnly') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
  OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'primaryOnly') v)<>jsonb_array_length(raw->'primaryOnly') THEN RETURN false; END IF;
 IF raw->'version' IN ('4'::jsonb,'5'::jsonb) THEN
  IF jsonb_typeof(raw->'groups') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(raw->'groups'))>128
   OR EXISTS(SELECT 1 FROM jsonb_each(raw->'groups') g WHERE length(g.key) NOT BETWEEN 1 AND 200 OR g.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb)) THEN RETURN false; END IF;
 END IF;
 cap:=raw->'fields'->>p_field;
 IF cap IS NULL OR cap='hide' THEN RETURN false; END IF;
 IF raw->'version' IN ('4'::jsonb,'5'::jsonb) AND (COALESCE(raw->'groups'->>('tab:'||b.tab_name),'editable')<>'editable'
  OR COALESCE(raw->'groups'->>('section:'||b.tab_name||'/'||b.section_name),'editable')<>'editable') THEN RETURN false; END IF;
 linked_ids:=CASE
  WHEN p_field IN ('profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname')
   THEN ARRAY['profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname']
  WHEN p_field='profile.personal_details.dateofbirth' THEN ARRAY['profile.personal_details.dateofbirth','profile.personal_details.age']
  WHEN p_field='family.family_and_dependents.dateofbirth' THEN ARRAY['family.family_and_dependents.dateofbirth','family.family_and_dependents.age']
  ELSE ARRAY[p_field] END;
 FOREACH linked IN ARRAY linked_ids LOOP
  IF COALESCE(raw->'fields'->>linked,'hide')='hide' THEN RETURN false; END IF;
 END LOOP;
 RETURN CASE WHEN p_primary THEN b.primary_key IS NOT NULL AND cap='viewOnly' AND raw->'primaryOnly' ? p_field ELSE cap='editable' END;
END; $$;
--> statement-breakpoint
CREATE FUNCTION app.profile_field_requires_approval(p_field text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE raw jsonb;rule jsonb;b record;
BEGIN
 SELECT * INTO b FROM app.access_profile_value_bindings() WHERE field_id=p_field;
 IF NOT FOUND THEN RETURN true;END IF;
 SELECT value INTO raw FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_change_fields';
 IF raw->'version'='5'::jsonb THEN
  rule:=raw->'approvals'->p_field;
  IF rule IS NULL THEN RETURN NOT b.immediate;END IF;
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(rule))<>2
   OR jsonb_typeof(rule->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(rule->'attachmentRequired') IS DISTINCT FROM 'boolean' THEN RETURN true;END IF;
  RETURN rule->'required'='true'::jsonb;
 END IF;
 RETURN NOT b.immediate;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_field_requires_approval(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Explicit v5 approval requirements suspend the finite View Only primary-contact exception.
-- Missing legacy rules retain their previous behavior; malformed explicit rules fail closed.
CREATE FUNCTION app.profile_legacy_primary_requires_approval(p_field text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT COALESCE((SELECT value->'version'='5'::jsonb AND value->'approvals' ? p_field
  AND value->'approvals'->p_field->'required' IS DISTINCT FROM 'false'::jsonb
  FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_change_fields'),false);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_legacy_primary_requires_approval(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.profile_legacy_unassigned_request(request_id uuid PRIMARY KEY REFERENCES public.profile_change_request(id) ON DELETE CASCADE);
--> statement-breakpoint
REVOKE ALL ON app.profile_legacy_unassigned_request FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.profile_legacy_unassigned_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO app.profile_legacy_unassigned_request(request_id)
 SELECT q.id FROM public.profile_change_request q WHERE q.status='pending' AND q.route_id IS NULL AND q.route_approver_user_id IS NULL
 AND q.route_approver_employment_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.tenant_setting t WHERE t.tenant_id=q.tenant_id
 AND t.key='ess.profile_change_routing' AND t.value->'enabled'='true'::jsonb);
--> statement-breakpoint
CREATE FUNCTION app.profile_route_submission_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb;rule jsonb;principal jsonb;configured jsonb;
BEGIN
 SELECT value INTO policy FROM public.tenant_setting WHERE tenant_id=NEW.tenant_id AND key='ess.profile_change_routing';
 IF NEW.route_id IS NULL AND NEW.route_approver_user_id IS NULL AND NEW.route_approver_employment_id IS NULL THEN
  IF COALESCE(policy->'enabled'='true'::jsonb,false) THEN RAISE EXCEPTION 'Profile route required' USING ERRCODE='42501';END IF;
  INSERT INTO app.profile_legacy_unassigned_request VALUES(NEW.id);RETURN NEW;
 END IF;
 IF NEW.route_context->'version'='3'::jsonb THEN
  SELECT r INTO rule FROM jsonb_array_elements(policy->'rules') r WHERE r->>'id'=NEW.route_id::text;
  IF policy->'version' IS DISTINCT FROM '3'::jsonb OR policy->'enabled' IS DISTINCT FROM 'true'::jsonb
   OR policy->>'revision' IS DISTINCT FROM NEW.route_revision::text OR rule IS NULL
   OR NEW.route_context->>'decisionMode' IS DISTINCT FROM 'any' OR jsonb_typeof(NEW.route_context->'approvers') IS DISTINCT FROM 'array'
   OR jsonb_array_length(NEW.route_context->'approvers') NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'Profile route snapshot unavailable' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(a->>'employmentId' ORDER BY a->>'employmentId') INTO configured FROM jsonb_array_elements(NEW.route_context->'approvers') a;
  IF configured IS DISTINCT FROM (SELECT jsonb_agg(a#>>'{}' ORDER BY a#>>'{}') FROM jsonb_array_elements(rule->'approverEmploymentIds') a) THEN RAISE EXCEPTION 'Profile approvers changed' USING ERRCODE='42501';END IF;
  FOR principal IN SELECT a FROM jsonb_array_elements(NEW.route_context->'approvers') a LOOP
   IF NOT EXISTS(SELECT 1 FROM app.profile_route_principal((principal->>'employmentId')::uuid,NEW.employment_id) p WHERE p.user_id=(principal->>'userId')::uuid) THEN RAISE EXCEPTION 'Profile approver unavailable' USING ERRCODE='42501';END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_route_submission_snapshot() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER profile_route_submission_snapshot AFTER INSERT ON public.profile_change_request FOR EACH ROW EXECUTE FUNCTION app.profile_route_submission_snapshot();
--> statement-breakpoint
CREATE FUNCTION app.profile_request_assignee(p_request uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;principal jsonb;
BEGIN
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR app.is_self_person(q.person_id) OR NOT app.can_admin_employment(q.employment_id)
  OR NOT app.access_profile_review_permitted(q.employment_id) THEN RETURN false;END IF;
 IF q.route_context->'version'='3'::jsonb THEN
  IF q.route_context->>'decisionMode' IS DISTINCT FROM 'any' OR jsonb_typeof(q.route_context->'approvers') IS DISTINCT FROM 'array'
   OR jsonb_array_length(q.route_context->'approvers') NOT BETWEEN 1 AND 32 THEN RETURN false;END IF;
  FOR principal IN SELECT a FROM jsonb_array_elements(q.route_context->'approvers') a LOOP
   IF principal->>'userId'=app.current_user_id()::text AND EXISTS(SELECT 1 FROM app.profile_route_principal((principal->>'employmentId')::uuid,q.employment_id) p WHERE p.user_id=app.current_user_id()) THEN RETURN true;END IF;
  END LOOP;
  RETURN false;
 END IF;
 IF q.route_id IS NULL AND EXISTS(SELECT 1 FROM app.profile_legacy_unassigned_request l WHERE l.request_id=q.id) THEN RETURN true;END IF;
 RETURN app.profile_route_reader(q.employment_id,q.route_approver_user_id,q.route_approver_employment_id,q.status::text);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_request_assignee(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_request_assignee(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_request_reader(p_request uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.profile_request_assignee(p_request) OR EXISTS(SELECT 1 FROM public.profile_change_request q
  WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id() AND app.can_admin_employment(q.employment_id)
   AND app.is_group_admin() AND current_setting('app.profile_route_maintenance',true)='on');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_request_reader(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_request_reader(uuid) TO ai_hr_app;
--> statement-breakpoint
DROP POLICY profile_change_request_read ON profile_change_request;
--> statement-breakpoint
CREATE POLICY profile_change_request_read ON profile_change_request FOR SELECT USING(tenant_id=app.current_tenant_id()
 AND (app.access_profile_request_own(person_id) OR app.profile_request_reader(id)));
--> statement-breakpoint
DROP POLICY profile_change_request_update ON profile_change_request;
--> statement-breakpoint
CREATE POLICY profile_change_request_update ON profile_change_request FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.profile_request_reader(id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_request_reader(id));
--> statement-breakpoint
CREATE TABLE profile_change_attachment(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),request_id uuid NOT NULL REFERENCES profile_change_request(id) ON DELETE CASCADE,
 field_ids jsonb NOT NULL CHECK(jsonb_typeof(field_ids)='array' AND jsonb_array_length(field_ids) BETWEEN 1 AND 128),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 200),mime_type text NOT NULL CHECK(mime_type IN('application/pdf','image/png','image/jpeg')),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),content bytea NOT NULL CHECK(octet_length(content)=size_bytes),created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX profile_change_attachment_request_idx ON profile_change_attachment(request_id);
--> statement-breakpoint
ALTER TABLE profile_change_attachment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT,INSERT ON profile_change_attachment TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY profile_change_attachment_read ON profile_change_attachment FOR SELECT USING(tenant_id=app.current_tenant_id()
 AND EXISTS(SELECT 1 FROM profile_change_request q WHERE q.id=request_id AND q.tenant_id=profile_change_attachment.tenant_id
  AND (app.access_profile_request_own(q.person_id) OR app.profile_request_reader(q.id))));
--> statement-breakpoint
CREATE POLICY profile_change_attachment_insert ON profile_change_attachment FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id()
 AND EXISTS(SELECT 1 FROM profile_change_request q WHERE q.id=request_id AND q.tenant_id=profile_change_attachment.tenant_id
  AND q.status='pending' AND app.access_profile_request_own(q.person_id)));
--> statement-breakpoint
CREATE FUNCTION app.profile_attachment_redaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.proposed->'redacted'='true'::jsonb THEN DELETE FROM public.profile_change_attachment WHERE request_id=NEW.id AND tenant_id=NEW.tenant_id;END IF;
 RETURN NEW;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_attachment_redaction() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER profile_attachment_redaction AFTER UPDATE OF proposed ON profile_change_request FOR EACH ROW EXECUTE FUNCTION app.profile_attachment_redaction();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_value_begin(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request%ROWTYPE;r jsonb;route_enabled boolean;route_digest text;proposal_digest text;prepared boolean;actor uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN; END IF;
 PERFORM app.access_profile_policy_write_lock();
 IF app.principal_snapshot_current() IS NOT TRUE OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Profile decision principal unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR q.status<>'pending' OR q.proposed->'v'='3'::jsonb
  OR app.access_profile_review_permitted(q.employment_id) IS NOT TRUE OR app.can_admin_employment(q.employment_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.person_id=q.person_id) THEN
  RAISE EXCEPTION 'Profile decision write unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO r FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_routing';
 IF r IS NOT NULL AND r<>'null'::jsonb AND (jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->'version' NOT IN ('1'::jsonb,'2'::jsonb,'3'::jsonb)
  OR r->'version' IS NULL OR jsonb_typeof(r->'enabled') IS DISTINCT FROM 'boolean') THEN
  RAISE EXCEPTION 'Profile decision route unavailable' USING ERRCODE='42501'; END IF;
 route_enabled:=COALESCE(r->'enabled'='true'::jsonb,false);
 proposal_digest:=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex');
 route_digest:=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex');
 SELECT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) INTO prepared;
 IF q.route_id IS NOT NULL THEN
  IF (q.route_context->'version'='3'::jsonb AND NOT app.profile_request_assignee(q.id)) OR
   (q.route_context->'version' IS DISTINCT FROM '3'::jsonb AND (q.route_approver_user_id IS DISTINCT FROM app.current_user_id()
   OR NOT EXISTS(SELECT 1 FROM app.profile_route_principal(q.route_approver_employment_id,q.employment_id) p WHERE p.user_id=app.current_user_id()))) THEN
   RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501'; END IF;
  -- The first preparation locks and validates the BEFORE snapshot. Revalidating after applying a
  -- requested nationality/gender change would incorrectly invalidate its own authorized decision.
  IF NOT prepared AND (q.route_context->>'fingerprint' IS DISTINCT FROM app.access_profile_route_fingerprint(q.employment_id)) THEN
   RAISE EXCEPTION 'Profile decision subject changed' USING ERRCODE='42501'; END IF;
 ELSIF (route_enabled AND NOT EXISTS(SELECT 1 FROM app.profile_legacy_unassigned_request l WHERE l.request_id=q.id)) OR q.route_approver_user_id IS NOT NULL OR q.route_approver_employment_id IS NOT NULL THEN
  RAISE EXCEPTION 'Profile decision route changed' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=q.tenant_id AND key='ess.profile_change_approver' AND value='"group_admin"'::jsonb)
  AND app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION 'Profile decision group scope required' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_actor VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id()) ON CONFLICT DO NOTHING;
 SELECT user_id INTO actor FROM app.access_profile_value_actor WHERE xact_id=pg_current_xact_id() AND tenant_id=q.tenant_id;
 IF actor IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Profile write principal changed' USING ERRCODE='42501'; END IF;
 INSERT INTO app.access_profile_value_approval(xact_id,tenant_id,request_id,user_id,proposal_hash,route_hash)
  VALUES(pg_current_xact_id(),q.tenant_id,q.id,app.current_user_id(),proposal_digest,route_digest) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app.access_profile_value_approval p WHERE p.xact_id=pg_current_xact_id() AND p.request_id=q.id
  AND p.tenant_id=q.tenant_id AND p.user_id=app.current_user_id() AND p.proposal_hash=proposal_digest AND p.route_hash=route_digest) THEN
  RAISE EXCEPTION 'Profile decision preparation changed' USING ERRCODE='42501'; END IF;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_task_request_type(p_request uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(r.proposed)='object' AND r.proposed->'v'='3'::jsonb THEN 'photo' ELSE 'fields' END
 FROM public.profile_change_request r
 JOIN public.employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id AND e.person_id=r.person_id
 WHERE r.id=p_request AND r.tenant_id=app.current_tenant_id() AND r.status='pending'
  AND app.principal_snapshot_current() AND NOT app.is_self_person(r.person_id)
  AND app.access_profile_review_permitted(r.employment_id)
  AND app.profile_request_reader(r.id);
$$;
--> statement-breakpoint
CREATE POLICY profile_photo_multi_read ON profile_photo_proposal FOR SELECT USING(tenant_id=app.current_tenant_id()
 AND EXISTS(SELECT 1 FROM profile_change_request q WHERE q.id=request_id AND q.tenant_id=profile_photo_proposal.tenant_id AND q.status='pending'
 AND q.proposed->'v'='3'::jsonb AND app.profile_request_assignee(q.id)));
--> statement-breakpoint
CREATE TABLE app.profile_direct_intent(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,user_id uuid NOT NULL,employment_id uuid NOT NULL,person_id uuid NOT NULL,
 proposal jsonb NOT NULL,audited boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id)
);
--> statement-breakpoint
CREATE TABLE app.profile_direct_register(
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,kind text NOT NULL,client_id text NOT NULL,row_id uuid NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,kind,client_id),UNIQUE(xact_id,tenant_id,user_id,kind,row_id)
);
--> statement-breakpoint
REVOKE ALL ON app.profile_direct_intent,app.profile_direct_register FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.profile_direct_intent ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.profile_direct_register ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_subject(p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.profile_direct_intent p JOIN public.employment e
 ON e.id=p.employment_id AND e.tenant_id=p.tenant_id AND e.person_id=p.person_id
 WHERE p.xact_id=pg_current_xact_id() AND p.tenant_id=app.current_tenant_id() AND p.user_id=app.current_user_id() AND p.employment_id=p_subject
 AND app.access_profile_request_own(e.person_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_subject(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_direct_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_person(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.profile_direct_intent p WHERE p.xact_id=pg_current_xact_id() AND p.tenant_id=app.current_tenant_id()
 AND p.user_id=app.current_user_id() AND p.person_id=p_person AND app.profile_direct_subject(p.employment_id));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_person(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_direct_person(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_begin(p_subject uuid,p_proposal jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;f jsonb;bound record;
BEGIN
 PERFORM app.access_workforce_write_lock();PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO e FROM public.employment WHERE id=p_subject AND tenant_id=app.current_tenant_id() AND app.access_profile_request_own(person_id) FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR e.blacklisted_at IS NOT NULL OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  OR jsonb_typeof(p_proposal) IS DISTINCT FROM 'object' OR p_proposal->'v' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(p_proposal->'fields') IS DISTINCT FROM 'array' OR jsonb_typeof(p_proposal->'registers') IS DISTINCT FROM 'array'
  OR pg_column_size(p_proposal)>128000 OR jsonb_array_length(p_proposal->'fields')>128 OR jsonb_array_length(p_proposal->'registers')>64 THEN
  RAISE EXCEPTION 'Direct profile change unavailable' USING ERRCODE='42501';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p_proposal->'fields') UNION ALL
  SELECT c FROM jsonb_array_elements(p_proposal->'registers') r CROSS JOIN LATERAL jsonb_array_elements(r->'fields') c
 LOOP
  SELECT * INTO bound FROM app.access_profile_value_bindings() WHERE field_id=f->>'fieldId';
  IF NOT FOUND OR NOT app.access_profile_value_editable(bound.field_id) OR app.profile_field_requires_approval(bound.field_id) OR NOT f ? 'value' THEN
   RAISE EXCEPTION 'Direct profile field unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 DELETE FROM app.profile_direct_intent WHERE tenant_id=e.tenant_id AND xact_id<>pg_current_xact_id();
 DELETE FROM app.profile_direct_register WHERE tenant_id=e.tenant_id AND xact_id<>pg_current_xact_id();
 INSERT INTO app.profile_direct_intent(xact_id,tenant_id,user_id,employment_id,person_id,proposal)
 VALUES(pg_current_xact_id(),e.tenant_id,app.current_user_id(),e.id,e.person_id,p_proposal);
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_begin(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.profile_direct_begin(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_direct_value_matches(p_owner text,p_person uuid,p_employment uuid,p_row uuid,p_delta jsonb,p_insert boolean,p_relationship_changed boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q record;entry jsonb;fields jsonb;bound_row uuid;promotion boolean;matched boolean;scalar_delta jsonb;current_marital jsonb;
BEGIN
 FOR q IN SELECT intent.*,intent.employment_id AS id FROM app.profile_direct_intent intent
 WHERE intent.xact_id=pg_current_xact_id() AND intent.tenant_id=app.current_tenant_id() AND intent.user_id=app.current_user_id()
 AND intent.person_id=p_person AND (p_employment IS NULL OR intent.employment_id=p_employment) AND intent.audited
 AND app.profile_direct_subject(intent.employment_id)
 LOOP
  IF p_owner='person' THEN
   IF q.proposal->'v'='2'::jsonb THEN fields:=q.proposal->'fields';
   ELSIF jsonb_typeof(q.proposal)='object' AND NOT q.proposal ? 'v' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('fieldId',b.field_id,'value',v.value)),'[]'::jsonb) INTO fields
     FROM jsonb_each(q.proposal) v JOIN app.access_profile_value_bindings() b ON b.legacy_key=v.key AND b.owner IN ('person','compliance');
   ELSE CONTINUE; END IF;
   scalar_delta:=p_delta;
   IF scalar_delta ? 'marital_status_source_request_id' THEN
    SELECT to_jsonb(marital_status) INTO current_marital FROM public.person WHERE id=p_person AND tenant_id=app.current_tenant_id();
    IF scalar_delta->'marital_status_source_request_id'<>'null'::jsonb OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f
     WHERE f->>'fieldId'='profile.personal_details.maritalstatus' AND app.access_profile_value_editable(f->>'fieldId')
      AND app.access_profile_value_normalized(f->'value')=current_marital) THEN CONTINUE; END IF;
    scalar_delta:=scalar_delta-'marital_status_source_request_id';
   END IF;
   -- Compliance and ordinary Person fields share one physical row, but retain their descriptor owner.
   SELECT COALESCE(jsonb_agg(f),'[]'::jsonb) INTO fields FROM jsonb_array_elements(fields) f;
   matched:=true;
   FOR entry IN SELECT jsonb_build_object('owner',b.owner,'delta',jsonb_object_agg(d.key,d.value))
    FROM jsonb_each(scalar_delta) d LEFT JOIN app.access_profile_value_bindings() b ON b.column_name=d.key AND b.owner IN ('person','compliance') GROUP BY b.owner
   LOOP
    IF entry->>'owner' IS NULL OR NOT app.access_profile_value_delta_matches(entry->>'owner',entry->'delta',fields,false) THEN matched:=false;EXIT;END IF;
   END LOOP;
   IF matched THEN RETURN true; END IF;
  ELSIF p_owner='statutory' THEN
   fields:=q.proposal->'fields';matched:=true;
   FOR entry IN SELECT jsonb_build_object('owner',b.owner,'delta',jsonb_object_agg(d.key,d.value))
    FROM jsonb_each(p_delta) d LEFT JOIN app.access_profile_value_bindings() b ON b.column_name=d.key AND b.owner IN ('bank','identity','passport','registration','taxLegacy') GROUP BY b.owner
   LOOP
    IF entry->>'owner' IS NULL OR NOT app.access_profile_value_delta_matches(entry->>'owner',entry->'delta',fields,false) THEN matched:=false;EXIT;END IF;
   END LOOP;
   IF matched THEN RETURN true;END IF;
  ELSIF q.proposal->'v'='2'::jsonb AND jsonb_typeof(q.proposal->'registers')='array' THEN
   FOR entry IN SELECT v FROM jsonb_array_elements(q.proposal->'registers') v WHERE v->>'kind'=p_owner LOOP
    fields:=entry->'fields';
    IF (NOT p_insert AND entry->>'id'=p_row::text OR p_insert AND entry->'id'='null'::jsonb)
     AND app.access_profile_value_delta_matches(p_owner,p_delta,fields,p_insert,p_relationship_changed) THEN
     IF p_insert THEN
      IF NULLIF(entry->>'clientId','') IS NULL THEN CONTINUE; END IF;
      INSERT INTO app.profile_direct_register VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id(),p_owner,entry->>'clientId',p_row)
       ON CONFLICT DO NOTHING;
      SELECT row_id INTO bound_row FROM app.profile_direct_register WHERE xact_id=pg_current_xact_id()
       AND tenant_id=q.tenant_id AND user_id=app.current_user_id() AND kind=p_owner AND client_id=entry->>'clientId';
      IF bound_row IS DISTINCT FROM p_row THEN CONTINUE; END IF;
     END IF;
     RETURN true;
    END IF;
    -- Exactly the canonical single-Highest / Primary transfer side effect. All other columns on
    -- the former holder must be unchanged. Its replacement must really exist in this same subject.
    promotion:=EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fields)='array' THEN fields ELSE '[]'::jsonb END) f
     WHERE p_owner='qualification' AND f->>'fieldId'='qualification.academic_and_professional_qualifications.highest' AND f->'value'='true'::jsonb
      AND app.access_profile_value_editable(f->>'fieldId')
      OR p_owner='emergency' AND f->>'fieldId'='profile.emergency_contact.priority' AND f->'value'='"primary"'::jsonb
      AND app.access_profile_value_editable(f->>'fieldId'));
    IF NOT p_insert AND promotion THEN
     IF p_owner='qualification' AND p_delta='{"is_highest":false}'::jsonb AND EXISTS(SELECT 1 FROM public.employee_qualification other
      WHERE other.tenant_id=q.tenant_id AND other.employment_id=q.employment_id AND other.id<>p_row AND other.archived_at IS NULL AND other.is_highest
       AND (entry->'id'='null'::jsonb OR entry->>'id'=other.id::text)) THEN RETURN true; END IF;
     IF p_owner='emergency' AND p_delta='{"priority":"secondary"}'::jsonb AND EXISTS(SELECT 1 FROM public.person_emergency_contact other
      WHERE other.tenant_id=q.tenant_id AND other.person_id=q.person_id AND other.id<>p_row AND other.archived_at IS NULL AND other.priority='primary'
       AND (entry->'id'='null'::jsonb OR entry->>'id'=other.id::text)) THEN RETURN true; END IF;
    END IF;
   END LOOP;
  END IF;
 END LOOP;
 RETURN false;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_value_matches(text,uuid,uuid,uuid,jsonb,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_value_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;delta jsonb;subject_person uuid;subject_employment uuid;row_id uuid;kind text;direct_allowed boolean;
 b record;own_contact boolean:=true;relationship_changed boolean:=false;marriage_allowed boolean:=false;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL; END IF;
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app.access_profile_value_actor a
  WHERE a.xact_id=pg_current_xact_id() AND a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id()) THEN
  RAISE EXCEPTION 'Profile write principal unavailable' USING ERRCODE='42501'; END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 row_id:=COALESCE(after_row->>'id',before_row->>'id')::uuid;
 IF COALESCE(after_row->>'tenant_id',before_row->>'tenant_id')::uuid IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'Profile subject unavailable' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='person' THEN
  subject_person:=row_id;kind:='person';direct_allowed:=app.access_workforce_person(subject_person,'workforce.maintain');
  -- Only normal-profile/compliance columns belong to this guard. Privacy erasure has an exact,
  -- separately prepared null/delete witness below; it is never a general value-write exception.
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.value IS DISTINCT FROM before_row->d.key AND (d.key IN (SELECT column_name FROM app.access_profile_value_bindings() WHERE owner IN ('person','compliance'))
    OR d.key IN ('address','address_line1','address_line2','address_line3','postcode','city','state','country','marital_status_source_request_id'));
 ELSE
  kind:=CASE TG_TABLE_NAME WHEN 'employee_dependent' THEN 'dependent' WHEN 'employee_qualification' THEN 'qualification' WHEN 'person_emergency_contact' THEN 'emergency' END;
  IF kind='qualification' THEN
   subject_employment:=COALESCE(after_row->>'employment_id',before_row->>'employment_id')::uuid;
   SELECT person_id INTO subject_person FROM public.employment WHERE id=subject_employment AND tenant_id=app.current_tenant_id();
   direct_allowed:=app.access_workforce_employment(subject_employment,'workforce.maintain');
  ELSE
   subject_person:=COALESCE(after_row->>'person_id',before_row->>'person_id')::uuid;
   direct_allowed:=app.access_workforce_person(subject_person,'workforce.maintain');
  END IF;
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d
   WHERE d.key NOT IN ('id','tenant_id','person_id','employment_id','created_at','updated_at') AND d.value IS DISTINCT FROM before_row->d.key;
  relationship_changed:=TG_OP='UPDATE' AND after_row->'relationship' IS DISTINCT FROM before_row->'relationship';
 END IF;
 IF app.access_workforce_value_intent_allowed(kind,before_row,after_row,true) THEN RETURN NULL; END IF;
 IF app.access_privacy_value_intent_allowed(kind,before_row,after_row) THEN RETURN NULL; END IF;
 IF kind='person' AND TG_OP='UPDATE' THEN
  marriage_allowed:=app.access_profile_marriage_delta(before_row,after_row,delta);
  IF delta ? 'marital_status_source_request_id' AND after_row->'marital_status_source_request_id'<>'null'::jsonb AND NOT marriage_allowed THEN
   RAISE EXCEPTION 'Marital status cause is reserved for its leave owner' USING ERRCODE='42501'; END IF;
 END IF;
 IF direct_allowed OR marriage_allowed THEN RETURN NULL; END IF;
 IF app.profile_direct_value_matches(kind,subject_person,subject_employment,row_id,delta,TG_OP='INSERT',relationship_changed) THEN RETURN NULL;END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Profile register removal unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND delta='{}'::jsonb AND after_row->'updated_at' IS NOT DISTINCT FROM before_row->'updated_at' THEN RETURN NULL; END IF;
 -- Immediate contact changes are a separate own-person course. No name, compliance value, new
 -- register row or general Personnel grant can inherit it. Real current employment remains required.
 IF app.access_profile_request_own(subject_person) AND EXISTS(SELECT 1 FROM public.employment e
  WHERE e.person_id=subject_person AND e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN
  IF kind='person' AND TG_OP='UPDATE' THEN
   FOR b IN SELECT * FROM jsonb_each(delta) LOOP
    IF NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='person' AND f.column_name=b.key AND f.immediate
     AND app.access_profile_value_editable(f.field_id) AND NOT app.profile_field_requires_approval(f.field_id)) THEN own_contact:=false;EXIT;END IF;
   END LOOP;
   IF own_contact THEN RETURN NULL; END IF;
  ELSIF kind='emergency' AND TG_OP='UPDATE' AND before_row->>'priority'='primary' AND before_row->'archived_at'='null'::jsonb THEN
   own_contact:=NOT EXISTS(SELECT 1 FROM public.person_emergency_contact e WHERE e.tenant_id=app.current_tenant_id()
    AND e.person_id=subject_person AND e.id<>row_id AND e.priority='primary' AND e.archived_at IS NULL);
   FOR b IN SELECT * FROM jsonb_each(delta) LOOP
    IF b.key='archived_at' AND b.value<>'null'::jsonb THEN
     IF EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='emergency' AND f.primary_key IS NOT NULL
      AND (NOT app.access_profile_value_editable(f.field_id,true) OR app.profile_legacy_primary_requires_approval(f.field_id))) THEN own_contact:=false;EXIT;END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM app.access_profile_value_bindings() f WHERE f.owner='emergency' AND f.column_name=b.key
     AND app.access_profile_value_editable(f.field_id,true) AND NOT app.profile_legacy_primary_requires_approval(f.field_id)) THEN own_contact:=false;EXIT;END IF;
   END LOOP;
   IF own_contact THEN RETURN NULL; END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' AND kind='person' THEN RAISE EXCEPTION 'Profile creation unavailable' USING ERRCODE='42501'; END IF;
 IF app.access_profile_value_approved(kind,subject_person,subject_employment,row_id,delta,TG_OP='INSERT',relationship_changed) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Profile value write unavailable' USING ERRCODE='42501';
END; $$;
--> statement-breakpoint
CREATE POLICY profile_direct_dependent_insert ON employee_dependent FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
CREATE POLICY profile_direct_dependent_update ON employee_dependent FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
CREATE POLICY profile_direct_qualification_insert ON employee_qualification FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_subject(employment_id));
--> statement-breakpoint
CREATE POLICY profile_direct_qualification_update ON employee_qualification FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.profile_direct_subject(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_subject(employment_id));
--> statement-breakpoint
CREATE POLICY profile_direct_emergency_insert ON person_emergency_contact FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
CREATE POLICY profile_direct_emergency_update ON person_emergency_contact FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
CREATE POLICY profile_direct_statutory_update ON employee_statutory_my FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_statutory_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE direct_delta jsonb;baseline jsonb;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT app.profile_direct_person(NEW.person_id) THEN RETURN NULL;END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.id IS DISTINCT FROM OLD.id) THEN RAISE EXCEPTION 'Statutory identity is immutable' USING ERRCODE='42501';END IF;
 -- A canonical identity/passport seed may introduce only declared identity fields and these exact
 -- installation defaults. Unknown or non-default financial columns remain refused.
 IF TG_OP='INSERT' THEN
  baseline:=to_jsonb(jsonb_populate_record(NULL::public.employee_statutory_my,'{}'::jsonb))||'{"tax_category":1,"tax_applicability_epoch":0,"num_children":0,"child_relief_mode":"manual","is_resident":true,"tax_residency":"resident","employer_bears_tax":false,"eis_eligible":true,"socso_category":"auto","eis_category":"auto","subject_to_socso":true,"subject_to_skbbk":false,"employer_bears_socso":false,"employer_bears_eis":false,"employer_bears_skbbk":false,"employer_bears_epf":false,"epf_citizenship":"citizen","epf_mode":"auto","enable_custom_holder_name":false,"enable_custom_holder_id":false,"zakat_active":false,"disabled_individual":false,"disabled_spouse":false}'::jsonb;
 ELSE baseline:=to_jsonb(OLD);END IF;
 SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO direct_delta FROM jsonb_each(to_jsonb(NEW)) d WHERE d.key<>ALL(ARRAY['updated_at','created_at','id','tenant_id','person_id']) AND d.value IS DISTINCT FROM baseline->d.key;
 IF NOT app.profile_direct_value_matches('statutory',NEW.person_id,NULL,NEW.id,direct_delta,false,false) AND NOT EXISTS(SELECT 1 FROM app.profile_direct_family_delta d JOIN app.profile_direct_intent i ON i.xact_id=d.xact_id AND i.tenant_id=d.tenant_id AND i.user_id=d.user_id AND i.person_id=d.person_id WHERE d.xact_id=pg_current_xact_id() AND d.tenant_id=app.current_tenant_id() AND d.user_id=app.current_user_id() AND d.person_id=NEW.person_id AND d.delta=direct_delta AND i.audited) THEN RAISE EXCEPTION 'Direct statutory fields unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_statutory_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER profile_direct_statutory_guard AFTER INSERT OR UPDATE ON employee_statutory_my DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_direct_statutory_guard();
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.event_type='profile.self-applied' AND NEW.aggregate_type='person' AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id()
  AND NEW.tenant_id=app.current_tenant_id() THEN
  UPDATE app.profile_direct_intent SET audited=true WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id
   AND user_id=NEW.actor_id AND person_id=NEW.aggregate_id;
 END IF;
 RETURN NEW;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_audit() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER profile_direct_audit AFTER INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.profile_direct_audit();
--> statement-breakpoint
CREATE FUNCTION app.profile_direct_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.event_type='profile.self-applied' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() THEN
  DELETE FROM app.profile_direct_family_delta WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id;
  DELETE FROM app.profile_direct_register WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id;
  DELETE FROM app.profile_direct_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND audited;
 END IF;
 RETURN NULL;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_cleanup() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER profile_direct_cleanup AFTER INSERT ON domain_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_direct_cleanup();

--> statement-breakpoint
-- The family owner alone derives this side effect. An employee cannot supply tax values through it.
CREATE TABLE app.profile_direct_family_delta(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,person_id uuid NOT NULL,delta jsonb NOT NULL);
--> statement-breakpoint
ALTER TABLE app.profile_direct_family_delta ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.profile_direct_family_delta FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_family_relief_sync(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE direct boolean;before_row jsonb;after_row jsonb;delta jsonb;result jsonb;
BEGIN
 direct:=app.profile_direct_person(p_person) AND EXISTS(SELECT 1 FROM app.profile_direct_intent i CROSS JOIN LATERAL jsonb_array_elements(i.proposal->'registers') r
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id() AND i.person_id=p_person AND r->>'kind'='dependent');
 IF NOT app.access_workforce_storage_owner() AND (NOT app.principal_snapshot_current() OR NOT (app.is_admin() AND app.can_see_person(p_person) OR direct)) THEN
  RAISE EXCEPTION 'Family automatic relief unavailable' USING ERRCODE='42501';END IF;
 IF direct THEN SELECT to_jsonb(s) INTO before_row FROM public.employee_statutory_my s WHERE s.tenant_id=app.current_tenant_id() AND s.person_id=p_person FOR UPDATE;END IF;
 result:=app.my_sync_family_child_relief(p_person);
 IF direct AND before_row IS NOT NULL THEN
  SELECT to_jsonb(s) INTO after_row FROM public.employee_statutory_my s WHERE s.tenant_id=app.current_tenant_id() AND s.person_id=p_person;
  SELECT COALESCE(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row) d WHERE d.key<>'updated_at' AND d.value IS DISTINCT FROM before_row->d.key;
  IF delta<>'{}'::jsonb THEN INSERT INTO app.profile_direct_family_delta VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),p_person,delta);END IF;
 END IF;
 RETURN result;
END;$$;

--> statement-breakpoint
CREATE POLICY profile_direct_statutory_insert ON employee_statutory_my FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.profile_direct_person(person_id));
--> statement-breakpoint
-- Every prepared direct transaction must finish with its actual audit event. Refusing an
-- incomplete transaction preserves evidence until all deferred exact-value guards have run,
-- and prevents retaining a second persistent copy of personal proposal values.
CREATE FUNCTION app.profile_direct_completion_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.profile_direct_intent i WHERE i.xact_id=NEW.xact_id AND i.tenant_id=NEW.tenant_id AND i.user_id=NEW.user_id AND i.audited) THEN
  RAISE EXCEPTION 'Direct profile transaction incomplete' USING ERRCODE='42501';
 END IF;
 RETURN NULL;
END;$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.profile_direct_completion_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER profile_direct_completion_guard AFTER INSERT ON app.profile_direct_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_direct_completion_guard();
