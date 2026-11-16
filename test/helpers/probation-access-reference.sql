-- The case access rule exactly as migration 0949 defined it (before 5746 gave it one set-based owner). Test-only reference.
CREATE OR REPLACE FUNCTION app.probation_holders_reference(p_employment uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e employment;a assignment;v_lm uuid;v_hod uuid;v_pbp uuid;v_pbp_count integer;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 SELECT * INTO e FROM employment WHERE id=p_employment AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=day AND (valid_to IS NULL OR valid_to>day) ORDER BY valid_from DESC,id LIMIT 1;
 v_lm:=app.probation_user_for(app.performance_current_admin_manager(e.tenant_id,e.id));
 SELECT app.probation_user_for(d.head_employment_id) INTO v_hod FROM department d WHERE d.id=a.department_id AND d.tenant_id=e.tenant_id;
 v_pbp:=app.lifecycle_canonical_pbp_user(e.id);IF v_pbp IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user signer JOIN person identity ON identity.id=signer.person_id AND identity.tenant_id=signer.tenant_id WHERE signer.id=v_pbp AND signer.tenant_id=e.tenant_id AND length(btrim(identity.full_name))>0) THEN v_pbp:=NULL;END IF;IF v_pbp IS NOT NULL AND NOT EXISTS(SELECT 1 FROM probation_access mapping WHERE mapping.tenant_id=e.tenant_id AND mapping.user_id=v_pbp AND mapping.role='pbp' AND app.is_company_descendant(e.company_id,mapping.company_id) AND (mapping.department_id IS NULL OR mapping.department_id=a.department_id) AND (mapping.business_unit_id IS NULL OR mapping.business_unit_id=a.business_unit_id) AND mapping.valid_from<=day AND (mapping.valid_to IS NULL OR mapping.valid_to>=day)) THEN v_pbp:=NULL;END IF;v_pbp_count:=CASE WHEN v_pbp IS NULL THEN 0 ELSE 1 END;
 RETURN jsonb_build_object('employee',app.probation_user_for(e.id),'lm',v_lm,'hod',v_hod,'pbp',v_pbp,'pbpAmbiguous',v_pbp_count>1,'companyId',e.company_id,'departmentId',a.department_id,'businessUnitId',a.business_unit_id);
END $$;
CREATE OR REPLACE FUNCTION app.probation_role_reference(p_employment uuid,p_role text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE h jsonb;co uuid;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NOT app.probation_active_user() THEN RETURN false;END IF;
 h:=app.probation_holders_reference(p_employment);co:=(h->>'companyId')::uuid;IF co IS NULL OR NOT app.probation_company_entitled(co) THEN RETURN false;END IF;
 IF p_role IN('employee','lm','hod','pbp') THEN RETURN coalesce(h->>p_role=app.current_user_id()::text,false);END IF;
 IF p_role='gbs' THEN RETURN app.probation_gbs_user_reference(p_employment,app.current_user_id());END IF;
 RETURN false;
END $$;
CREATE OR REPLACE FUNCTION app.probation_gbs_user_reference(p_employment uuid,p_user uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb:=app.probation_holders_reference(p_employment); day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 RETURN EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.id=p_user AND u.tenant_id=e.tenant_id
  JOIN probation_access a ON a.user_id=u.id AND a.tenant_id=e.tenant_id
  WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND app.probation_company_entitled(e.company_id) AND app.lifecycle_canonical_people_ops_member(e.company_id,u.id)
   AND a.role='gbs' AND app.is_company_descendant(e.company_id,a.company_id)
   AND (a.department_id IS NULL OR a.department_id::text=scope->>'departmentId')
   AND (a.business_unit_id IS NULL OR a.business_unit_id::text=scope->>'businessUnitId')
   AND a.valid_from<=day AND (a.valid_to IS NULL OR a.valid_to>=day));
END $$;
CREATE OR REPLACE FUNCTION app.probation_case_access_reference(p_case uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();IF NOT FOUND THEN RETURN false;END IF;IF app.probation_storage_runner() THEN RETURN true;END IF;
 IF app.probation_company_entitled(c.company_id) IS NOT TRUE THEN RETURN false;END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN app.probation_active_user() AND EXISTS(SELECT 1 FROM employment e JOIN app_user self ON self.person_id=e.person_id AND self.tenant_id=e.tenant_id WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND self.id=app.current_user_id());END IF;
 RETURN coalesce(app.probation_role_reference(c.employment_id,'employee') OR app.probation_role_reference(c.employment_id,'lm') OR app.probation_role_reference(c.employment_id,'hod') OR app.probation_role_reference(c.employment_id,'pbp') OR app.probation_role_reference(c.employment_id,'gbs') OR app.probation_active_user() AND EXISTS(SELECT 1 FROM probation_delegate d JOIN probation_part p ON p.id=d.part_id AND p.tenant_id=d.tenant_id WHERE p.case_id=c.id AND d.tenant_id=c.tenant_id AND d.holder_id=app.current_user_id() AND d.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (d.valid_to IS NULL OR d.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) OR app.probation_current_escalated_actor(c.id),false);
END $$;
