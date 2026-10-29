-- Approved 8ff065b3: catalogue availability does not establish a company's organisation membership.
-- business_unit.company_id is catalogue creation ownership, not organisation membership.
-- Preserve immutable historical targets; this predicate only guards new configuration/review choices.
CREATE OR REPLACE FUNCTION app.reward_policy_pair_valid(t uuid,c uuid,b uuid,p_shared boolean DEFAULT true) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.company x JOIN public.business_unit u ON u.tenant_id=x.tenant_id
 WHERE x.id=c AND x.tenant_id=t AND u.id=b AND u.archived_at IS NULL AND (NOT p_shared OR x.currency='MYR')
 AND EXISTS(
  SELECT 1 FROM public.assignment a JOIN public.employment e ON e.id=a.employment_id AND e.tenant_id=a.tenant_id
  WHERE a.tenant_id=t AND a.business_unit_id=u.id AND coalesce(a.company_id,e.company_id)=x.id
   AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND e.blacklisted_at IS NULL
   AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR least(e.resignation_date,e.last_working_date,e.terminated_on)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 ));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_pair_valid(uuid,uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_policy_memberships(p_companies uuid[]) RETURNS TABLE(company_id uuid,business_unit_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.id,u.id FROM public.company c JOIN public.business_unit u ON u.tenant_id=c.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.id=ANY(p_companies) AND app.reward_admin(c.id)
 AND app.reward_policy_pair_valid(c.tenant_id,c.id,u.id,false) ORDER BY c.id,u.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.reward_policy_memberships(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.reward_policy_memberships(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Unit-owned inputs do not make a newly-created review look like a changed shared group policy.
-- Immutable origin version and authorization stay unchanged; compare group-owned facts only.
CREATE OR REPLACE FUNCTION app.reward_policy_unit_origin(p_unit uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('versionId',v.id,'revision',v.revision,'name',v.name,'changed',
  (r.policy-ARRAY['patActual','patTarget','targetMonthsBp','multiplierBp','branchRatings','exemptReason','lumpUnitCents','lumpReason','payWindowKeep','unitGovernanceDigest','seniorMembershipMode','seniorGrades'])
  IS DISTINCT FROM
  (v.policy-ARRAY['patActual','patTarget','targetMonthsBp','multiplierBp','branchRatings','exemptReason','lumpUnitCents','lumpReason','payWindowKeep','unitGovernanceDigest','seniorMembershipMode','seniorGrades']))
 FROM public.reward_unit r JOIN public.reward_policy_group_version v ON v.id=r.policy_group_version_id AND v.tenant_id=r.tenant_id
 WHERE r.id=p_unit AND r.tenant_id=app.current_tenant_id() AND app.reward_access(r.id);
$$;

--> statement-breakpoint
-- Preserve immutable versions while future reviews adopt unit-owned inputs and named Senior selection.
CREATE OR REPLACE FUNCTION app.reward_policy_for_new_unit(p_version uuid,p_company uuid,p_bu uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g public.reward_policy_group%ROWTYPE;v public.reward_policy_group_version%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 SELECT x.* INTO g FROM public.reward_policy_group x WHERE x.tenant_id=app.current_tenant_id() AND x.current_version_id=p_version FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.reward_policy_group_version x WHERE x.id=p_version AND x.tenant_id=g.tenant_id;
 IF NOT app.reward_admin(p_company) OR NOT app.reward_policy_pair_valid(g.tenant_id,p_company,p_bu)
  OR NOT EXISTS(SELECT 1 FROM public.reward_policy_group_target x WHERE x.tenant_id=g.tenant_id AND x.version_id=v.id AND x.company_id=p_company AND x.business_unit_id=p_bu) THEN
  RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('groupId',g.id,'versionId',v.id,'revision',v.revision,'name',v.name,'policy',(v.policy-'unitGovernanceDigest') || jsonb_build_object('seniorMembershipMode','named-members','seniorGrades','[]'::jsonb,'patActual',0,'patTarget',100,'targetMonthsBp',0,'multiplierBp',NULL,'branchRatings','{}'::jsonb,'exemptReason','','lumpUnitCents',NULL));
END;
$$;
