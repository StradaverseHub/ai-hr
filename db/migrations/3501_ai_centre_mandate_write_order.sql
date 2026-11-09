-- Append-only native ordering for every existing mandate-control INSERT/UPDATE.
-- Actual metadata: 2026-11-08T13:50:05.841Z; preserve native permission/version owners.
DO $guard$
DECLARE c pg_class;p pg_proc;expected record;
BEGIN
 SELECT * INTO c FROM pg_class WHERE oid=to_regclass('public.teras_mandate_control');
 IF c.oid IS NULL OR c.relkind<>'r' OR NOT c.relrowsecurity OR c.relforcerowsecurity
  OR c.relowner<>current_user::regrole OR c.relowner IS DISTINCT FROM (SELECT proowner FROM pg_proc WHERE oid=to_regprocedure('app.ai_centre_assert_running(integer)'))
  OR (SELECT count(*) FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))))<>10
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantor<>c.relowner OR a.is_grantable
   OR NOT ((a.grantee=c.relowner AND a.privilege_type IN('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))
    OR (a.grantee='ai_hr_app'::regrole AND a.privilege_type IN('SELECT','INSERT','UPDATE'))))
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL)
 THEN RAISE EXCEPTION 'Unexpected AI Centre mandate table custody' USING ERRCODE='55000';END IF;
 FOR expected IN SELECT * FROM (VALUES
  ('app.ai_centre_control_lock()','5cb40550d7a210ee0a4c27a4fb3923c9','74c65f8286fae77128310a6206fd590f'),
  ('app.teras_bump_version()','20c706b8b3a32536341edf558e1d81e9','7674114bbab72cdf61790e747c954ce3')
 )AS e(signature,body_hash,definition_hash) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF p.oid IS NULL OR p.proowner<>c.relowner OR md5(p.prosrc) IS DISTINCT FROM expected.body_hash OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM expected.definition_hash
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR p.prokind<>'f' OR p.prosecdef OR p.proisstrict OR p.proleakproof
   OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.pronargs<>0 OR p.pronargdefaults<>0
   OR pg_get_function_result(p.oid)<>'trigger' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace=p.pronamespace AND q.proname=p.proname)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
    WHERE a.grantor<>c.relowner OR a.grantee<>c.relowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  THEN RAISE EXCEPTION 'Unexpected AI Centre mandate predecessor: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
 IF (SELECT coalesce(jsonb_agg(jsonb_build_object('tgname',t.tgname,'tgenabled',t.tgenabled,'tgtype',t.tgtype,
  'definition',pg_get_triggerdef(t.oid),'function_identity',t.tgfoid::regprocedure::text)ORDER BY t.tgname),'[]')
  FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) IS DISTINCT FROM '[{"tgname":"aaa_ai_centre_control_lock","tgenabled":"O","tgtype":23,"definition":"CREATE TRIGGER aaa_ai_centre_control_lock BEFORE INSERT OR UPDATE ON public.teras_mandate_control FOR EACH ROW EXECUTE FUNCTION app.ai_centre_control_lock()","function_identity":"app.ai_centre_control_lock()"},{"tgname":"teras_mandate_control_version","tgenabled":"O","tgtype":19,"definition":"CREATE TRIGGER teras_mandate_control_version BEFORE UPDATE ON public.teras_mandate_control FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version(''version'')","function_identity":"app.teras_bump_version()"}]'::jsonb
 THEN RAISE EXCEPTION 'Unexpected AI Centre mandate triggers' USING ERRCODE='55000';END IF;
 IF (SELECT coalesce(jsonb_agg(to_jsonb(policy_row)-'schemaname'-'tablename' ORDER BY policyname),'[]') FROM pg_policies policy_row
  WHERE schemaname='public' AND tablename='teras_mandate_control') IS DISTINCT FROM '[{"policyname":"teras_control_admin_insert","permissive":"PERMISSIVE","roles":["ai_hr_app"],"cmd":"INSERT","qual":null,"with_check":"((tenant_id = app.current_tenant_id()) AND (app.current_agent_principal() IS NULL) AND app.is_group_admin() AND (app.principal_snapshot_current() IS TRUE) AND (changed_by_user_id = app.current_user_id()))"},{"policyname":"teras_control_admin_update","permissive":"PERMISSIVE","roles":["ai_hr_app"],"cmd":"UPDATE","qual":"((tenant_id = app.current_tenant_id()) AND (app.current_agent_principal() IS NULL) AND app.is_group_admin() AND (app.principal_snapshot_current() IS TRUE))","with_check":"((tenant_id = app.current_tenant_id()) AND (changed_by_user_id = app.current_user_id()))"},{"policyname":"teras_control_read","permissive":"PERMISSIVE","roles":["ai_hr_app"],"cmd":"SELECT","qual":"(tenant_id = app.current_tenant_id())","with_check":null}]'::jsonb
 THEN RAISE EXCEPTION 'Unexpected AI Centre mandate policies' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc function_row JOIN pg_namespace n ON n.oid=function_row.pronamespace WHERE n.nspname='app'
  AND function_row.proname IN('ai_centre_mandate_write_order','ai_centre_mandate_bound_tenant'))
 THEN RAISE EXCEPTION 'AI Centre mandate append names already occupied' USING ERRCODE='55000';END IF;
END $guard$;
--> statement-breakpoint
CREATE TEMP TABLE pg_temp.ai_centre_mandate_write_preimage ON COMMIT DROP AS
 SELECT 'table'::text AS kind,c.oid,to_jsonb(c) AS attributes FROM pg_class c WHERE c.oid='public.teras_mandate_control'::regclass
 UNION ALL SELECT 'function',p.oid,to_jsonb(p) FROM pg_proc p WHERE p.oid=ANY(ARRAY['app.ai_centre_control_lock()'::regprocedure,'app.teras_bump_version()'::regprocedure]::oid[])
 UNION ALL SELECT 'trigger',t.oid,to_jsonb(t) FROM pg_trigger t WHERE t.tgrelid='public.teras_mandate_control'::regclass AND NOT t.tgisinternal
 UNION ALL SELECT 'policy',p.oid,to_jsonb(p) FROM pg_policy p WHERE p.polrelid='public.teras_mandate_control'::regclass;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_mandate_write_order() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;
BEGIN
 BEGIN tid:=app.current_tenant_id();EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'Mandate control requires a bound tenant' USING ERRCODE='42501';END;
 IF tid IS NULL THEN RAISE EXCEPTION 'Mandate control requires a bound tenant' USING ERRCODE='42501';END IF;
 -- Primitive locks deliberately permit stopped-to-running maintenance and resume.
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||tid::text,0));
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_mandate_write_order() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_mandate_bound_tenant() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid;
BEGIN
 BEGIN tid:=app.current_tenant_id();EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'Mandate control row differs from bound tenant' USING ERRCODE='42501';END;
 IF tid IS NULL OR NEW.tenant_id IS DISTINCT FROM tid THEN
  RAISE EXCEPTION 'Mandate control row differs from bound tenant' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND OLD.tenant_id IS DISTINCT FROM tid THEN
  RAISE EXCEPTION 'Mandate control row differs from bound tenant' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_mandate_bound_tenant() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER aa_ai_centre_mandate_write_order BEFORE INSERT OR UPDATE ON public.teras_mandate_control
 FOR EACH STATEMENT EXECUTE FUNCTION app.ai_centre_mandate_write_order();
--> statement-breakpoint
CREATE TRIGGER aaa_ai_centre_bound_tenant BEFORE INSERT OR UPDATE ON public.teras_mandate_control
 FOR EACH ROW EXECUTE FUNCTION app.ai_centre_mandate_bound_tenant();
--> statement-breakpoint
DO $postimage$
DECLARE before_row record;current_attributes jsonb;p pg_proc;expected record;owner_oid oid;
BEGIN
 IF (SELECT count(*) FROM pg_temp.ai_centre_mandate_write_preimage)<>8 THEN
  RAISE EXCEPTION 'AI Centre mandate preimage custody unavailable' USING ERRCODE='55000';END IF;
 FOR before_row IN SELECT * FROM pg_temp.ai_centre_mandate_write_preimage LOOP
  current_attributes:=NULL;
  IF before_row.kind='table' THEN SELECT to_jsonb(c) INTO current_attributes FROM pg_class c WHERE c.oid=before_row.oid;
   -- Adding triggers can only preserve the already-true relhastriggers flag.
  ELSIF before_row.kind='function' THEN SELECT to_jsonb(function_row) INTO current_attributes FROM pg_proc function_row WHERE function_row.oid=before_row.oid;
  ELSIF before_row.kind='trigger' THEN SELECT to_jsonb(t) INTO current_attributes FROM pg_trigger t WHERE t.oid=before_row.oid;
  ELSIF before_row.kind='policy' THEN SELECT to_jsonb(policy_row) INTO current_attributes FROM pg_policy policy_row WHERE policy_row.oid=before_row.oid;END IF;
  IF current_attributes IS DISTINCT FROM before_row.attributes THEN
   RAISE EXCEPTION 'AI Centre mandate predecessor changed: %',before_row.kind USING ERRCODE='55000';END IF;
 END LOOP;
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='public.teras_mandate_control'::regclass;
 FOR expected IN SELECT * FROM (VALUES
  ('app.ai_centre_mandate_write_order()','6d5c3406dd162244775ccbd2611e482a'),('app.ai_centre_mandate_bound_tenant()','1bb350c0b520beec5ec64c4c455af838')
 )AS e(signature,body_hash) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF p.oid IS NULL OR p.proowner<>owner_oid OR md5(p.prosrc) IS DISTINCT FROM expected.body_hash OR p.prosecdef OR p.proisstrict OR p.proleakproof
   OR p.prokind<>'f' OR p.provolatile<>'v' OR p.proparallel<>'u' OR p.pronargs<>0 OR p.pronargdefaults<>0
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR pg_get_function_result(p.oid)<>'trigger'
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR (SELECT count(*) FROM pg_proc q WHERE q.pronamespace=p.pronamespace AND q.proname=p.proname)<>1
   OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a WHERE a.grantor<>owner_oid OR a.grantee<>owner_oid OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  THEN RAISE EXCEPTION 'AI Centre mandate append differs: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.teras_mandate_control'::regclass AND NOT tgisinternal)<>4
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.teras_mandate_control'::regclass AND tgname='aa_ai_centre_mandate_write_order' AND tgtype=22 AND tgenabled='O' AND tgfoid='app.ai_centre_mandate_write_order()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.teras_mandate_control'::regclass AND tgname='aaa_ai_centre_bound_tenant' AND tgtype=23 AND tgenabled='O' AND tgfoid='app.ai_centre_mandate_bound_tenant()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
 THEN RAISE EXCEPTION 'AI Centre mandate append trigger order differs' USING ERRCODE='55000';END IF;
END $postimage$;
