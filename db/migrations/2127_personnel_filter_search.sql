-- Approved9c6b06d4. Purpose-scoped filter projection and private, short-lived result membership.
-- Search text and identity values are never persisted in this state table.
CREATE TABLE public.personnel_private_search (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id), actor_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 scope_ids uuid[] NOT NULL CHECK(cardinality(scope_ids)<=1000),
 matches jsonb NOT NULL CHECK(jsonb_typeof(matches)='array' AND jsonb_array_length(matches)<=100000),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);
ALTER TABLE public.personnel_private_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personnel_private_search FORCE ROW LEVEL SECURITY;
CREATE POLICY personnel_private_search_own ON public.personnel_private_search FOR ALL TO PUBLIC
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.principal_snapshot_current())
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.principal_snapshot_current());
GRANT SELECT(token_hash,tenant_id,actor_id,created_at,expires_at,scope_ids),INSERT,DELETE ON public.personnel_private_search TO ai_hr_app;
CREATE INDEX personnel_private_search_actor_expiry ON public.personnel_private_search(tenant_id,actor_id,expires_at);
--> statement-breakpoint
CREATE FUNCTION app.personnel_private_search_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(NEW.matches)<>'array' OR jsonb_array_length(NEW.matches)>100000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.matches)m WHERE COALESCE(m->>'employmentId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR m->>'kind' IS NULL OR m->>'kind' NOT IN ('public','identity') OR COALESCE(m->>'personRevision','') !~ '^[0-9]{1,12}$' OR COALESCE(m->>'employmentRevision','') !~ '^[0-9]{1,12}$' OR (m->>'identityRevision' IS NOT NULL AND m->>'identityRevision' !~ '^[0-9]{1,12}$') OR jsonb_typeof(m)<>'object' OR m-ARRAY['employmentId','kind','personRevision','employmentRevision','identityRevision']<>'{}'::jsonb) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.matches)m WHERE NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id WHERE e.id::text=m->>'employmentId' AND e.tenant_id=NEW.tenant_id AND e.voided_at IS NULL AND app.access_workforce_projection_company(COALESCE((app.employment_organisation_tags(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,e.company_id)) AND e.xmin::text=m->>'employmentRevision' AND p.xmin::text=m->>'personRevision' AND (m->>'kind'='public' OR (app.personnel_identity_search_permitted(COALESCE((app.employment_organisation_tags(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,e.company_id)) AND i.xmin::text=m->>'identityRevision')))) THEN RAISE EXCEPTION 'Private search changed. Try again.' USING ERRCODE='40001'; END IF;
 IF NEW.scope_ids IS NULL OR cardinality(NEW.scope_ids)>1000 OR EXISTS(SELECT 1 FROM unnest(NEW.scope_ids)x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=x AND c.tenant_id=NEW.tenant_id AND app.access_workforce_projection_company(c.id))) THEN RAISE EXCEPTION 'Private search scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.scope_ids:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.scope_ids)x ORDER BY x);
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-private-search:'||NEW.tenant_id::text||':'||NEW.actor_id::text,0));
 NEW.created_at:=clock_timestamp();NEW.expires_at:=NEW.created_at+interval '5 minutes';
 DELETE FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id AND (expires_at<=now() OR token_hash IN(SELECT token_hash FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id ORDER BY created_at DESC OFFSET 7));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.personnel_private_search_bind() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER personnel_private_search_bind BEFORE INSERT ON public.personnel_private_search FOR EACH ROW EXECUTE FUNCTION app.personnel_private_search_bind();
--> statement-breakpoint
-- Canonical payroll permission override-set semantics, with the company's actual current roles.
CREATE FUNCTION app.personnel_identity_search_permitted(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH configured AS (SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=app.current_tenant_id() AND permission_key='report.read.identity' AND (company_id=target OR company_id IS NULL)),
 effective AS (SELECT role,allowed FROM configured WHERE (company_id=target AND EXISTS(SELECT 1 FROM configured WHERE company_id=target)) OR (company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured WHERE company_id=target)))
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.access_workforce_projection_company(target) AND
 CASE WHEN EXISTS(SELECT 1 FROM effective) THEN EXISTS(SELECT 1 FROM effective a WHERE a.allowed AND app.has_role_for(a.role,target) AND NOT EXISTS(SELECT 1 FROM effective d WHERE d.role=a.role AND NOT d.allowed))
 ELSE app.has_role_for('hr_admin',target) OR app.has_role_for('super_admin',target) END
$$;
REVOKE ALL ON FUNCTION app.personnel_identity_search_permitted(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_identity_search_permitted(uuid) TO ai_hr_app;
--> statement-breakpoint
-- This is a native permission-bound memory input, never serialized into the list or sent to an AI.
CREATE FUNCTION app.personnel_search_rows(p_scope uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH public_rows AS MATERIALIZED(SELECT DISTINCT ON((value->>'employmentId')::uuid) value FROM app.access_workforce_list_rows() AS source(value) ORDER BY (value->>'employmentId')::uuid),
 admitted AS MATERIALIZED(
 SELECT v.value,e.id,e.person_id,e.tenant_id,e.xmin::text employment_revision,
 COALESCE((ot.tags->>'companyId')::uuid,e.company_id) company_id
 FROM public_rows v JOIN public.employment e ON e.id=(v.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
 CROSS JOIN LATERAL(SELECT app.employment_organisation_tags(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)tags)ot
 WHERE COALESCE((ot.tags->>'companyId')::uuid,e.company_id)=ANY(p_scope)
 AND app.access_workforce_projection_company(COALESCE((ot.tags->>'companyId')::uuid,e.company_id))),
 identity_companies AS MATERIALIZED(SELECT DISTINCT company_id FROM admitted WHERE app.personnel_identity_search_permitted(company_id))
 SELECT jsonb_build_object('employmentId',a.id,'companyId',a.company_id,'name',a.value->>'name','email',a.value->>'email','employeeCode',a.value->>'employeeCode',
 'personRevision',p.xmin::text,'employmentRevision',a.employment_revision,
 'identityRevision',CASE WHEN permitted.company_id IS NOT NULL THEN s.xmin::text ELSE NULL END,
 'icNumber',CASE WHEN permitted.company_id IS NOT NULL THEN s.ic_number ELSE NULL END,
 'passportNumber',CASE WHEN permitted.company_id IS NOT NULL THEN s.passport_number ELSE NULL END)
 FROM admitted a JOIN public.person p ON p.id=a.person_id AND p.tenant_id=a.tenant_id
 LEFT JOIN identity_companies permitted ON permitted.company_id=a.company_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=a.person_id AND s.tenant_id=a.tenant_id AND permitted.company_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app.personnel_search_rows(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_search_rows(uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_private_search_matches(p_hash text,p_employment uuid,p_company uuid,p_scope uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.principal_snapshot_current() AND app.access_workforce_projection_company(p_company) AND EXISTS(
 SELECT 1 FROM public.personnel_private_search s CROSS JOIN LATERAL jsonb_array_elements(s.matches) m
 WHERE s.token_hash=p_hash AND s.tenant_id=app.current_tenant_id() AND s.actor_id=app.current_user_id() AND s.expires_at>now() AND s.scope_ids @> p_scope AND s.scope_ids <@ p_scope
 AND m->>'employmentId'=p_employment::text AND EXISTS(SELECT 1 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND COALESCE((app.employment_organisation_tags(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,e.company_id)=p_company AND e.voided_at IS NULL AND app.access_workforce_projection_company(COALESCE((app.employment_organisation_tags(e.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,e.company_id)) AND e.xmin::text=m->>'employmentRevision' AND p.xmin::text=m->>'personRevision' AND (m->>'kind'='public' OR i.xmin::text=m->>'identityRevision')) AND (m->>'kind'='public' OR (m->>'kind'='identity' AND app.personnel_identity_search_permitted(p_company))))
$$;
REVOKE ALL ON FUNCTION app.personnel_private_search_matches(text,uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_private_search_matches(text,uuid,uuid,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.employment_organisation_quality(p_employment uuid,p_as_of date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb; e record;
BEGIN
 tags:=app.employment_organisation_tags(p_employment,p_as_of);
 SELECT id,hired_on,grade_id INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND voided_at IS NULL;
 IF NOT FOUND OR tags IS NULL OR tags->>'companyId' IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('companyId',tags->>'companyId','taggingStatus',tags->>'status','reason',tags->>'reason','flags',jsonb_build_object(
 'missing_business_unit',e.hired_on<=p_as_of AND tags->>'businessUnitId' IS NULL,
 'missing_job_grade',e.hired_on<=p_as_of AND e.grade_id IS NULL,
 'missing_direct_superior',e.hired_on<=p_as_of AND NOT EXISTS(SELECT 1 FROM public.reporting_line r WHERE r.tenant_id=app.current_tenant_id() AND r.subordinate_employment_id=e.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)) AND NOT EXISTS(SELECT 1 FROM public.org_chart_root r WHERE r.tenant_id=app.current_tenant_id() AND r.employment_id=e.id AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)),
 'company_not_in_structure',tags->>'status'='pending'));
END $$;
REVOKE ALL ON FUNCTION app.employment_organisation_quality(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.employment_organisation_quality(uuid,date) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_filter_rows(p_as_of date,p_scope uuid[] DEFAULT NULL) RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED(SELECT DISTINCT ON((value->>'employmentId')::uuid) value FROM app.access_workforce_list_rows() AS admitted_source(value) WHERE p_scope IS NULL OR (value->>'companyId')::uuid=ANY(p_scope) ORDER BY (value->>'employmentId')::uuid),
 visible AS MATERIALIZED(
 SELECT b.value,e.id,e.person_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date,e.probation_end_date,
  a.department_id,a.position_id,a.business_unit_id,a.cost_center_id,a.location_id,a.employment_type,ot.tags,
  COALESCE((ot.tags->>'companyId')::uuid,e.company_id) AS dated_company_id,
  CASE WHEN ot.tags->>'status' IN ('ready','pending') THEN (ot.tags->>'businessUnitId')::uuid ELSE a.business_unit_id END AS dated_bu_id,
  p.full_name AS permitted_name
 FROM admitted b JOIN public.employment e ON e.id=(b.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT x.* FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL AND x.valid_from<=p_as_of AND (x.valid_to IS NULL OR x.valid_to>p_as_of) ORDER BY x.valid_from DESC,x.id DESC LIMIT 1)a ON true
 CROSS JOIN LATERAL(SELECT app.employment_organisation_tags(e.id,p_as_of) AS tags)ot
 WHERE app.access_workforce_projection_company(COALESCE((ot.tags->>'companyId')::uuid,e.company_id)))
 SELECT v.value||jsonb_build_object(
 'companyId',v.dated_company_id,'company',co.legal_name,'departmentId',v.department_id,'department',COALESCE(NULLIF(btrim(d.label),''),d.name),
 'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'employmentType',v.employment_type,
 'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,'jobGradeId',v.grade_id,
 'parentCompanyId',CASE WHEN app.access_workforce_projection_company((v.tags->>'parentCompanyId')::uuid) THEN v.tags->>'parentCompanyId' ELSE NULL END,
 'businessGroupId',CASE WHEN app.access_workforce_projection_company((v.tags->>'businessGroupId')::uuid) THEN v.tags->>'businessGroupId' ELSE NULL END,
 'parentCompany',pc.legal_name,'businessGroup',bg.legal_name,
 'confirmationState',CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
 'jobGradeCode',g.code,'costCenter',cc.name,'workLocation',loc.name,
 'reportingTo',(SELECT mp.full_name FROM public.reporting_line r JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND r.subordinate_employment_id=v.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of) AND app.access_workforce_projection_company(me.company_id) ORDER BY r.valid_from DESC,r.id LIMIT 1),
 'quality',app.employment_organisation_quality(v.id,p_as_of)->'flags')
 FROM visible v JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=app.current_tenant_id()
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=app.current_tenant_id()
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=app.current_tenant_id()
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=app.current_tenant_id()
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=app.current_tenant_id()
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=app.current_tenant_id()
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=app.current_tenant_id()
 LEFT JOIN public.company pc ON pc.id=(v.tags->>'parentCompanyId')::uuid AND pc.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(pc.id)
 LEFT JOIN public.company bg ON bg.id=(v.tags->>'businessGroupId')::uuid AND bg.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(bg.id)
$$;
REVOKE ALL ON FUNCTION app.personnel_filter_rows(date,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_filter_rows(date,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.personnel_filter_companies(p_scope uuid[],p_as_of date) RETURNS TABLE(id uuid,name text,"parentCompanyId" uuid,"parentCompany" text,"businessGroupId" uuid,"businessGroup" text,"businessUnitId" uuid,"businessUnit" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED(SELECT c.* FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.id=ANY(p_scope) AND app.access_workforce_projection_company(c.id))
 SELECT c.id,c.legal_name,pc.id,pc.legal_name,bg.id,bg.legal_name,bu.id,bu.name
 FROM admitted c CROSS JOIN LATERAL(SELECT app.company_organisation_tags(c.id,p_as_of) tags)o
 LEFT JOIN public.company pc ON pc.id=(o.tags->>'parentCompanyId')::uuid AND pc.tenant_id=c.tenant_id AND app.access_workforce_projection_company(pc.id)
 LEFT JOIN public.company bg ON bg.id=(o.tags->>'businessGroupId')::uuid AND bg.tenant_id=c.tenant_id AND app.access_workforce_projection_company(bg.id)
 LEFT JOIN public.business_unit bu ON bu.id=(o.tags->>'businessUnitId')::uuid AND bu.tenant_id=c.tenant_id
 ORDER BY c.legal_name,c.id
$$;
REVOKE ALL ON FUNCTION app.personnel_filter_companies(uuid[],date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_filter_companies(uuid[],date) TO ai_hr_app;

--> statement-breakpoint
-- Canonical name normalization and duplicate grouping run in core/duplicate-person's existing JS owner.
-- This bounded memory input contains only evidence admitted by the original native admin/purpose scope.
CREATE FUNCTION app.personnel_duplicate_candidate_rows(p_scope uuid[],p_as_of date) RETURNS TABLE("employmentId" uuid,"personId" uuid,"fullName" text,"hiredOn" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT e.id,e.person_id,value->>'name',value->>'hiredOn'
 FROM app.personnel_filter_rows(p_as_of,p_scope) AS visible(value)
 JOIN public.employment e ON e.id=(value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 WHERE app.is_admin_for((value->>'companyId')::uuid) AND app.personnel_identity_search_permitted((value->>'companyId')::uuid)
$$;
REVOKE ALL ON FUNCTION app.personnel_duplicate_candidate_rows(uuid[],date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_duplicate_candidate_rows(uuid[],date) TO ai_hr_app;
