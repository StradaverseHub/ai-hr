-- Reuse the existing native visibility owner once per nonempty non-admin batch.
-- Visible fields match the scalar owner; unseen subjects keep its exact purpose/delegation reader.
DO $batch_predecessor$
DECLARE p pg_catalog.pg_proc%ROWTYPE; dependency record; app_role oid;
BEGIN
 SELECT oid INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('app.delegated_approval_subjects(uuid[],text,text)');
 IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM '5526fc06ba93348f8062a88680c9011a'
  OR app_role IS NULL OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof
  OR p.provolatile<>'s' OR p.proparallel<>'u' OR p.prokind<>'f' OR p.proretset IS DISTINCT FROM true
  OR p.prorettype IS DISTINCT FROM ('record'::regtype)::oid OR p.pronargs<>3
  OR p.proargtypes[0] IS DISTINCT FROM ('uuid[]'::regtype)::oid
  OR p.proargtypes[1] IS DISTINCT FROM ('text'::regtype)::oid OR p.proargtypes[2] IS DISTINCT FROM ('text'::regtype)::oid
  OR p.proargnames IS DISTINCT FROM ARRAY['subject_ids','wanted_module','wanted_task','employment_id','person_id','employee','employee_code','company_id']::text[]
  OR p.proallargtypes IS DISTINCT FROM ARRAY[('uuid[]'::regtype)::oid,('text'::regtype)::oid,('text'::regtype)::oid,('uuid'::regtype)::oid,('uuid'::regtype)::oid,('text'::regtype)::oid,('text'::regtype)::oid,('uuid'::regtype)::oid]
  OR p.proargmodes IS DISTINCT FROM ARRAY['i','i','i','t','t','t','t','t']::"char"[]
  OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL OR p.procost<>100 OR p.prorows<>1000
  OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[] THEN
  RAISE EXCEPTION 'Unexpected approval batch predecessor; review before changing its plan' USING ERRCODE='55000';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
    WHERE a.grantee NOT IN(p.proowner,app_role) OR a.privilege_type<>'EXECUTE' OR (a.grantee=app_role AND a.is_grantable))
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=p.proowner AND a.privilege_type='EXECUTE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=app_role AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected approval batch privileges; review before changing its plan' USING ERRCODE='55000';
 END IF;
 -- The new positive arm relies on the qualified set/scalar visibility equivalence.
 FOR dependency IN SELECT * FROM (VALUES
  ('app.visible_employment_ids()','1bc7e85a740a98b9db79efb2b7768c8b','plpgsql','search_path=public','uuid[]',false),
  ('app.delegated_approval_subject(uuid,text,text)','39c597ac70ea098f9b7ca875341ef774','sql','search_path=pg_catalog, public, pg_temp','record',true),
  ('app.can_see_employment(uuid)','eb759692f1f18b2a9d723998584697f1','sql','search_path=public','boolean',false)
 ) expected(identity,fingerprint,language,configuration,return_type,set_returning) LOOP
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(dependency.identity);
  IF NOT FOUND OR md5(p.prosrc) IS DISTINCT FROM dependency.fingerprint
   OR p.prosecdef IS DISTINCT FROM true OR p.provolatile<>'s' OR p.proparallel<>'u'
   OR p.proisstrict OR p.proleakproof OR p.prokind<>'f'
   OR p.prorettype IS DISTINCT FROM to_regtype(dependency.return_type)::oid
   OR p.proretset IS DISTINCT FROM dependency.set_returning
   OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname=dependency.language)
   OR p.proconfig IS DISTINCT FROM ARRAY[dependency.configuration]::text[] THEN
   RAISE EXCEPTION 'Unexpected approval visibility dependency; review before changing its plan' USING ERRCODE='55000';
  END IF;
 END LOOP;
END;
$batch_predecessor$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.delegated_approval_subjects(subject_ids uuid[],wanted_module text,wanted_task text)
RETURNS TABLE(employment_id uuid,person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF cardinality(subject_ids)>1000 THEN RAISE EXCEPTION 'Too many approval subjects' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH candidates AS MATERIALIZED (
  SELECT e.id,e.person_id,p.full_name,e.employee_code,e.company_id
  FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  WHERE e.tenant_id=app.current_tenant_id() AND e.id=ANY(subject_ids)
 ), companies AS MATERIALIZED (
  SELECT DISTINCT c.company_id FROM candidates c
 ), admin_companies AS MATERIALIZED (
  SELECT c.company_id,app.is_admin_for(c.company_id) AS allowed FROM companies c
 ), non_admin AS MATERIALIZED (
  SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed IS NOT TRUE
 ), visible_set AS MATERIALIZED (
  SELECT app.visible_employment_ids() AS ids WHERE EXISTS(SELECT 1 FROM non_admin)
 ), unseen AS MATERIALIZED (
  SELECT c.id FROM non_admin c CROSS JOIN visible_set v WHERE NOT(c.id=ANY(v.ids))
 )
 SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id
 FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed
 UNION ALL
 SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id FROM non_admin c CROSS JOIN visible_set v WHERE c.id=ANY(v.ids)
 UNION ALL
 SELECT c.id,s.person_id,s.employee,s.employee_code,s.company_id
 FROM unseen c JOIN LATERAL app.delegated_approval_subject(c.id,wanted_module,wanted_task) s ON true;
END;
$$;
