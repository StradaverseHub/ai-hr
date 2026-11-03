-- Compensation stores Number(input).toFixed(2). Use the exact binary64 significand
-- and integer remainder to match the native cent conversion, including midpoint values.
CREATE FUNCTION app.workforce_draft_money(p_raw text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE clean text:=nullif(btrim(regexp_replace(p_raw,'[,_]','','g')),'');
 bytes bytea;exponent integer;significand numeric;denominator numeric:=1;cents numeric;i integer;
BEGIN
 IF clean IS NULL THEN RETURN NULL;END IF;
 bytes:=float8send(clean::double precision);
 exponent:=((get_byte(bytes,0)&127)<<4)|(get_byte(bytes,1)>>4);
 IF exponent=2047 THEN RAISE EXCEPTION 'Invalid draft money' USING ERRCODE='22023';END IF;
 significand:=get_byte(bytes,1)&15;
 FOR i IN 2..7 LOOP significand:=significand*256+get_byte(bytes,i);END LOOP;
 IF exponent=0 THEN exponent:=-1074;
 ELSE significand:=significand+4503599627370496;exponent:=exponent-1075;END IF;
 significand:=significand*100;
 IF exponent<0 THEN denominator:=power(2::numeric,-exponent);
 ELSE significand:=significand*power(2::numeric,exponent);END IF;
 cents:=div(significand,denominator);
 IF mod(significand,denominator)*2>=denominator THEN cents:=cents+1;END IF;
 IF get_byte(bytes,0)>=128 THEN cents:=-cents;END IF;
 RETURN cents*0.01;
END;
$$;
REVOKE ALL ON FUNCTION app.workforce_draft_money(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_hire_effects_match(data jsonb,p_employment uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment%ROWTYPE;master jsonb;placement jsonb;stat jsonb;pay jsonb;section record;entry record;
 target jsonb;column_name text;expected text;actual text;mode text;family_row jsonb;stored_family jsonb;family_expected jsonb;expected_members jsonb:='[]';actual_members jsonb;key text;profile jsonb;original_source_data jsonb:=data;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.data_permission_employment_born(e.id) OR NOT app.access_workforce_hire_source_supported(data) THEN RETURN false;END IF;
 SELECT to_jsonb(p) INTO master FROM public.person p WHERE p.id=e.person_id AND p.tenant_id=e.tenant_id;
 SELECT to_jsonb(a) INTO placement FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from=e.hired_on;
 SELECT to_jsonb(m) INTO stat FROM public.employee_statutory_my m WHERE m.person_id=e.person_id AND m.tenant_id=e.tenant_id;
 SELECT to_jsonb(c) INTO pay FROM public.compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from=e.hired_on AND c.superseded_at IS NULL;
 profile:=coalesce(data->'profile','{}');
 IF profile->>'sameAsPermanent'='yes' THEN
  FOREACH key IN ARRAY ARRAY['AddressLine1','AddressLine2','AddressLine3','Postcode','City','State','Country'] LOOP
   profile:=jsonb_set(profile,ARRAY['correspondence'||key],coalesce(profile->('permanent'||key),'null'));
  END LOOP;
 END IF;
 data:=jsonb_set(data,'{profile}',profile);
 mode:=coalesce(nullif(btrim(data#>>'{statutory,epfMode}'),''),'auto');
 FOR section IN SELECT * FROM jsonb_each(data) source_section WHERE source_section.key IN ('profile','employment','statutory','payroll') LOOP
  IF jsonb_typeof(section.value)<>'object' THEN CONTINUE;END IF;
  FOR entry IN SELECT * FROM jsonb_each(section.value) LOOP
   expected:=nullif(btrim(entry.value#>>'{}'),'');IF expected IS NULL THEN CONTINUE;END IF;
   column_name:=lower(regexp_replace(entry.key,'([A-Z])','_\1','g'));
   target:=CASE section.key WHEN 'profile' THEN master WHEN 'employment' THEN to_jsonb(e) WHEN 'statutory' THEN stat WHEN 'payroll' THEN pay END;
   IF section.key='profile' THEN
    IF entry.key IN ('employeeIdMode','sameAsPermanent') THEN CONTINUE;END IF;
    IF entry.key='employeeCode' THEN
     target:=to_jsonb(e);
     -- Repeat the same bound full-source issuance fact at actual consumption; no posted-mode waiver.
     IF EXISTS(SELECT 1 FROM app.workforce_hire_source proof WHERE proof.xact_id=pg_current_xact_id() AND proof.tenant_id=e.tenant_id AND proof.user_id=app.current_user_id() AND proof.employment_id=e.id AND proof.source->'data'=original_source_data AND app.workforce_draft_auto_code_issued(proof.source,e.company_id,e.employee_code)) THEN expected:=e.employee_code;END IF;
    END IF;
    IF entry.key='icNumber' OR entry.key LIKE 'passport%' THEN target:=stat;END IF;
    IF entry.key='icNumber' THEN expected:=regexp_replace(expected,'[^0-9]','','g');END IF;
    IF entry.key='passportIssuingCountryCode' THEN expected:=upper(expected);END IF;
   ELSIF section.key='employment' THEN
    IF entry.key IN ('departmentId','positionId','costCenterId','employmentType') THEN target:=placement;END IF;
    IF entry.key='reportingManagerEmploymentId' THEN
     IF NOT EXISTS(SELECT 1 FROM public.reporting_line l WHERE l.tenant_id=e.tenant_id AND l.subordinate_employment_id=e.id AND l.manager_employment_id::text=expected AND l.valid_from=e.hired_on AND l.line_type='administrative' AND l.superseded_at IS NULL) THEN RETURN false;END IF;CONTINUE;
    END IF;
    IF entry.key='provisionalEndOn' THEN
     IF data#>>'{employment,employmentType}'='part_time' THEN expected:=NULL;
     ELSIF coalesce(data#>>'{employment,employmentType}','full_time')='full_time' AND nullif(data#>>'{employment,probationValue}','') IS NOT NULL THEN
      expected:=(e.hired_on+CASE coalesce(nullif(data#>>'{employment,probationUnit}',''),'month') WHEN 'month' THEN make_interval(months=>(data#>>'{employment,probationValue}')::integer) WHEN 'week' THEN make_interval(days=>7*(data#>>'{employment,probationValue}')::integer) ELSE make_interval(days=>(data#>>'{employment,probationValue}')::integer) END)::date::text;
     END IF;
    END IF;
   ELSIF section.key='payroll' THEN
    IF entry.key IN ('paymentMethod','payrollPolicyId') THEN target:=to_jsonb(e);END IF;
    IF entry.key IN ('basicSalary','monthlyAllowance','rateAmount') THEN expected:=app.workforce_draft_money(expected)::text;END IF;
   ELSIF section.key='statutory' THEN
    IF entry.key IN ('subjectToSkbbk','employerBearsTax','employerBearsEpf','employerBearsSocso','employerBearsEis','employerBearsSkbbk','disabledIndividual','disabledSpouse','subjectToHrdf','enableCustomHolderName','enableCustomHolderId') THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key='eisEligible' AND nullif(data#>>'{statutory,eisCategory}','') IS NOT NULL THEN CONTINUE;END IF;
    IF entry.key='eisEligible' THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key IN ('enableCustomHolderName','enableCustomHolderId') THEN expected:=(lower(btrim(entry.value#>>'{}'))='yes')::text;END IF;
    IF entry.key='customHolderName' AND lower(coalesce(data#>>'{statutory,enableCustomHolderName}',''))<>'yes' THEN expected:=NULL;END IF;
    IF entry.key='customHolderId' AND lower(coalesce(data#>>'{statutory,enableCustomHolderId}',''))<>'yes' THEN expected:=NULL;END IF;
    IF entry.key='epfCitizenship' THEN expected:=regexp_replace(lower(expected),'[ -]+','_','g');END IF;
    IF entry.key='epfMode' THEN expected:=CASE mode WHEN 'manual_percentage' THEN 'manual_percentage' WHEN 'voluntary_percentage' THEN 'topup_percentage' WHEN 'semi_auto' THEN 'voluntary_excess' WHEN 'manual_employee_amount' THEN 'manual_amount' WHEN 'manual_employer_amount' THEN 'manual_amount' WHEN 'manual_both_amount' THEN 'manual_amount' WHEN 'none' THEN 'exempt' ELSE 'auto' END;END IF;
    IF entry.key IN ('epfEmployeeRate','epfEmployerRate') THEN
     IF mode IN ('manual_percentage','voluntary_percentage') OR (mode='semi_auto' AND entry.key='epfEmployeeRate') THEN expected:=(expected::numeric/100)::text;ELSE expected:=NULL;END IF;
    END IF;
    IF entry.key IN ('epfEmployeeAmount','epfEmployerAmount') THEN
     IF NOT (mode='manual_both_amount' OR mode='manual_employee_amount' AND entry.key='epfEmployeeAmount' OR mode='manual_employer_amount' AND entry.key='epfEmployerAmount') THEN expected:=NULL;END IF;
    END IF;
    IF entry.key='epfManualReason' AND mode NOT IN ('manual_employee_amount','manual_employer_amount','manual_both_amount') THEN expected:=NULL;END IF;
    IF entry.key='numChildren' AND data#>>'{statutory,childReliefMode}'='auto' THEN CONTINUE;END IF; -- Native family owner recomputes this derived value.
    IF entry.key='taxCategory' AND expected NOT IN ('1','2','3') THEN column_name:='tax_circumstance';END IF;
    IF entry.key='isResident' AND nullif(data#>>'{statutory,taxResidency}','') IS NOT NULL THEN CONTINUE;END IF;
    IF entry.key='isResident' THEN expected:=(lower(expected) IN ('true','yes','y','1'))::text;END IF;
    IF entry.key='taxResidency' AND data#>>'{statutory,taxCategory}'='none' THEN expected:=CASE WHEN expected='non_resident' THEN 'non_resident' ELSE 'resident' END;END IF;
    IF entry.key='taxResidency' AND expected IN ('rep','knowledge_worker','c_suite') THEN
     IF NOT EXISTS(SELECT 1 FROM public.employment_tax_selection_my t WHERE t.tenant_id=e.tenant_id AND t.employment_id=e.id AND t.company_id=e.company_id AND t.scheme::text=expected) THEN RETURN false;END IF;CONTINUE;
    END IF;
   END IF;
   actual:=nullif(btrim(target->>column_name),'');
   IF jsonb_typeof(target->column_name)='number' AND expected IS NOT NULL THEN
    IF actual::numeric IS DISTINCT FROM expected::numeric THEN RAISE LOG 'Hire source binding unavailable (%/%)',section.key,entry.key;RETURN false;END IF;
   ELSIF actual IS DISTINCT FROM expected THEN RAISE LOG 'Hire source binding unavailable (%/%)',section.key,entry.key;RETURN false;END IF;
  END LOOP;
 END LOOP;
 -- Match the canonical family multiset, including duplicates; row/UI keys confer no storage authority.
 FOR family_row IN SELECT value FROM jsonb_array_elements(coalesce(data->'family','[]')) LOOP
  family_expected:='{}';
  FOR entry IN SELECT * FROM jsonb_each(family_row) source_entry WHERE source_entry.key<>'key' LOOP
   column_name:=lower(regexp_replace(entry.key,'([A-Z])','_\1','g'));
   expected:=nullif(btrim(entry.value#>>'{}'),'');
   IF entry.key IN ('marriageDate','marriageStatus','spouseWorking','companyName','employerAddress') AND family_row->>'relationship'<>'spouse' THEN expected:=NULL;END IF;
   IF entry.key IN ('isStudent','schoolName','studyLevel','studyCountry','childReliefCategory','childTaxRelief','childReliefPercentage') AND family_row->>'relationship'<>'child' THEN expected:=NULL;END IF;
   family_expected:=family_expected||jsonb_build_object(column_name,expected);
  END LOOP;
  expected_members:=expected_members||jsonb_build_array(family_expected);
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]') INTO actual_members FROM public.employee_dependent d WHERE d.tenant_id=e.tenant_id AND d.person_id=e.person_id AND d.archived_at IS NULL;
 IF jsonb_array_length(actual_members)<>jsonb_array_length(expected_members) THEN RETURN false;END IF;
 FOR family_expected IN SELECT value FROM jsonb_array_elements(expected_members) LOOP
  stored_family:=NULL;
  SELECT value INTO stored_family FROM jsonb_array_elements(actual_members) m WHERE NOT EXISTS(SELECT 1 FROM jsonb_each(family_expected) v WHERE nullif(btrim(m.value->>v.key),'') IS DISTINCT FROM nullif(v.value#>>'{}','')) LIMIT 1;
  IF stored_family IS NULL THEN RETURN false;END IF;
  -- Remove one matching physical row, retaining multiplicity.
  actual_members:=actual_members-(SELECT ordinality::integer-1 FROM jsonb_array_elements(actual_members) WITH ORDINALITY m WHERE m.value=stored_family LIMIT 1);
 END LOOP;
 RETURN true;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_consumed_draft(p_source jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.workforce_hire_source s JOIN public.employment e ON e.id=s.employment_id AND e.tenant_id=s.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE s.xact_id=pg_current_xact_id() AND s.tenant_id=app.current_tenant_id() AND s.user_id=app.current_user_id()
 AND s.draft_id=(p_source->>'id')::uuid AND s.source_hash=encode(sha256(convert_to(p_source::text,'UTF8')),'hex')
 AND app.access_workforce_hire_effects_match(s.source->'data',e.id)
 AND app.data_permission_employment_born(e.id) AND app.access_workforce_action_company(e.company_id,'add') AND app.function_action_allowed('workforceDrafts','execute',e.company_id)
 AND nullif(btrim(s.source#>>'{data,profile,phone}'),'') IS NOT DISTINCT FROM nullif(btrim(p.phone),'')
 AND EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id
  AND a.department_id::text=s.source#>>'{data,employment,departmentId}' AND a.superseded_at IS NULL
  AND a.employment_type::text=coalesce(nullif(s.source#>>'{data,employment,employmentType}',''),'full_time'))
 AND EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.valid_from=e.hired_on AND c.superseded_at IS NULL
  AND c.basic_salary=coalesce(app.workforce_draft_money(s.source#>>'{data,payroll,basicSalary}'),0)
  AND c.monthly_allowance=coalesce(app.workforce_draft_money(s.source#>>'{data,payroll,monthlyAllowance}'),0)
  AND c.pay_mode::text=coalesce(nullif(s.source#>>'{data,payroll,payMode}',''),'monthly')
  AND c.payment_term=coalesce(nullif(s.source#>>'{data,payroll,paymentTerm}',''),'monthly')
  AND c.rate_amount IS NOT DISTINCT FROM app.workforce_draft_money(s.source#>>'{data,payroll,rateAmount}')
  AND nullif(btrim(c.remarks),'') IS NOT DISTINCT FROM nullif(btrim(s.source#>>'{data,payroll,remarks}'),''))
 AND (nullif(s.source#>>'{data,statutory,subjectToSkbbk}','') IS NULL OR EXISTS(SELECT 1 FROM public.employee_statutory_my m WHERE m.person_id=e.person_id AND m.tenant_id=e.tenant_id AND m.subject_to_skbbk=(s.source#>>'{data,statutory,subjectToSkbbk}'='yes'))));
$$;
