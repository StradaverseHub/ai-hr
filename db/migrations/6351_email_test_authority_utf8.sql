-- Hash UTF-8 text bytes, not PostgreSQL bytea input syntax: saved rich wording may contain backslashes/newlines.
CREATE OR REPLACE FUNCTION app.automation_email_test_authority(p_tenant uuid,p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,
  'roles',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user),
  'contractRoles',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_role_assignment r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'contractMembers',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_access_member r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'contractPermissions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_access_role r WHERE r.tenant_id=p_tenant),
  'probationMembers',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.probation_access_member r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'probationPermissions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.probation_access_role r WHERE r.tenant_id=p_tenant),
  'probationRules',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.tenant_id),'[]'::jsonb) FROM public.probation_access_rule r WHERE r.tenant_id=p_tenant),
  'access',(SELECT to_jsonb(g) FROM app.access_profile_write_generation g WHERE g.tenant_id=p_tenant),
  'nativeGroups',(SELECT jsonb_build_object('revision',revision,'data',data) FROM public.lc_onboarding_config WHERE tenant_id=p_tenant),
  'lifecycle',(SELECT jsonb_build_object('revision',revision,'data',data) FROM public.lc_v9_config WHERE tenant_id=p_tenant),
  'companies',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.parent_company_id,c.archived_at) ORDER BY c.id),'[]'::jsonb) FROM public.company c WHERE c.tenant_id=p_tenant),
  'modules',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.tenant_module m WHERE m.tenant_id=p_tenant AND m.module_code='lifecycle')
 )::text,'UTF8')),'hex')
$$;
