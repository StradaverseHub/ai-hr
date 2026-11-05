-- UNALLOCATED PROPOSAL: no deployment or migration allocation implied.
-- The finite Workforce record/editor must not build the entire Workforce JSON list for one ID.
-- Change only the list source; keep every projected field, grant, owner and caller unchanged.
DO $personnel_profile_predecessor$
DECLARE
 target pg_catalog.pg_proc%ROWTYPE;
 selected_rows pg_catalog.pg_proc%ROWTYPE;
 private_rows pg_catalog.pg_proc%ROWTYPE;
 runtime_oid oid := pg_catalog.to_regrole('ai_hr_app')::oid;
 sql_oid oid := (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql');
 plpgsql_oid oid := (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql');
BEGIN
 SELECT * INTO target FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('app.access_workforce_record(uuid)');
 SELECT * INTO selected_rows FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('app.access_workforce_list_rows_for_ids(uuid[])');
 SELECT * INTO private_rows FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('app._access_workforce_list_rows(uuid[])');
 IF target.oid IS NULL OR selected_rows.oid IS NULL OR private_rows.oid IS NULL OR runtime_oid IS NULL
  OR target.proowner=runtime_oid OR target.proowner IS DISTINCT FROM selected_rows.proowner
  OR target.proowner IS DISTINCT FROM private_rows.proowner
  OR md5(target.prosrc) IS DISTINCT FROM 'dde63890dd0ec86d6de47ef0fa2a4b1b'
  OR md5(selected_rows.prosrc) IS DISTINCT FROM '01fdc25919caef51975eea796da96d3e'
  OR md5(private_rows.prosrc) IS DISTINCT FROM '2f78166098cb14315d9861ae01fbbe35'
  OR target.prolang IS DISTINCT FROM sql_oid OR selected_rows.prolang IS DISTINCT FROM plpgsql_oid
  OR private_rows.prolang IS DISTINCT FROM sql_oid
  OR target.proretset OR NOT selected_rows.proretset OR NOT private_rows.proretset
  OR target.prorettype IS DISTINCT FROM 'jsonb'::regtype::oid
  OR selected_rows.prorettype IS DISTINCT FROM 'jsonb'::regtype::oid
  OR private_rows.prorettype IS DISTINCT FROM 'jsonb'::regtype::oid
  OR target.proargnames IS DISTINCT FROM ARRAY['p_employment']::text[]
  OR selected_rows.proargnames IS DISTINCT FROM ARRAY['subject_ids']::text[]
  OR private_rows.proargnames IS DISTINCT FROM ARRAY['subject_ids']::text[]
  OR EXISTS(
   SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid IN(target.oid,selected_rows.oid,private_rows.oid)
    AND (p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof
     OR p.provolatile<>'s' OR p.proparallel<>'u' OR p.prokind<>'f'
     OR p.pronargs<>1 OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
     OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL OR p.procost<>100
     OR p.prorows<>CASE WHEN p.proretset THEN 1000 ELSE 0 END
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]))
 THEN RAISE EXCEPTION 'Unexpected Workforce profile or selected-row predecessor; review before replacing its source' USING ERRCODE='55000';
 END IF;
 IF EXISTS(
   SELECT 1 FROM pg_catalog.pg_proc p
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE p.oid IN(target.oid,selected_rows.oid,private_rows.oid)
    AND (a.grantor<>p.proowner OR a.privilege_type<>'EXECUTE'
     OR a.grantee NOT IN(p.proowner,runtime_oid)
     OR (a.grantee=runtime_oid AND (p.oid=private_rows.oid OR a.is_grantable))))
  OR (SELECT count(*) FROM pg_catalog.pg_proc p
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE p.oid IN(target.oid,selected_rows.oid,private_rows.oid) AND a.grantee=p.proowner AND a.privilege_type='EXECUTE')<>3
  OR (SELECT count(*) FROM pg_catalog.pg_proc p
   CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
   WHERE p.oid IN(target.oid,selected_rows.oid) AND a.grantee=runtime_oid AND a.privilege_type='EXECUTE')<>2
 THEN RAISE EXCEPTION 'Unexpected Workforce profile or selected-row privileges; review before replacing its source' USING ERRCODE='55000';
 END IF;
END;
$personnel_profile_predecessor$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_record(p_employment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('employment',listing.value,'profile',jsonb_build_object(
  'salutation',p.salutation,'fullName',p.full_name,'firstName',p.first_name,'lastName',p.last_name,
  'preferredName',p.preferred_name,'nationality',p.nationality,'religion',p.religion,'race',p.race,
  'dateOfBirth',p.date_of_birth,'gender',p.gender,'maritalStatus',p.marital_status,'primaryEmail',p.primary_email,
  'phone',p.phone,'homePhone',p.home_phone,'personalEmail',p.personal_email,'permanentAddressLine1',p.permanent_address_line1,
  'permanentAddressLine2',p.permanent_address_line2,'permanentAddressLine3',p.permanent_address_line3,'permanentPostcode',p.permanent_postcode,'permanentCity',p.permanent_city,
  'permanentState',p.permanent_state,'permanentCountry',p.permanent_country,'correspondenceAddressLine1',p.correspondence_address_line1,'correspondenceAddressLine2',p.correspondence_address_line2,
  'correspondenceAddressLine3',p.correspondence_address_line3,'correspondencePostcode',p.correspondence_postcode,'correspondenceCity',p.correspondence_city,'correspondenceState',p.correspondence_state,
  'correspondenceCountry',p.correspondence_country,'correspondenceMobilePhone',p.correspondence_mobile_phone,'correspondenceHomePhone',p.correspondence_home_phone))
 FROM app.access_workforce_list_rows_for_ids(array[p_employment]) AS listing(value)
 JOIN public.employment e ON e.id=(listing.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=p_employment;
$$;
