-- Unallocated compatibility proposal; STAGING owns fresh6441 admission and registration.
-- Restore only the native Resignation delivery module removed by the later original Contract CHECK.
-- Original migrations, prior repairs and every queue/claim/target authority remain unchanged.
DO $repair$
DECLARE relation regclass:='public.automation_email_delivery'::regclass; actual text; validated boolean;
 module_columns smallint[]; module_att smallint; old_owner oid; old_acl aclitem[];
 old_rls boolean; old_force boolean; old_policies text; old_triggers text; current_shape jsonb;
BEGIN
 SELECT c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity INTO old_owner,old_acl,old_rls,old_force
 FROM pg_class c WHERE c.oid=relation AND c.relkind='r';
 IF old_owner IS NULL OR NOT (old_owner='ai_hr_owner'::regrole OR old_owner=current_user::regrole
  AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper))
 OR old_rls IS DISTINCT FROM true OR old_force IS DISTINCT FROM true
 OR has_table_privilege('ai_hr_app',relation,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(old_acl,acldefault('r',old_owner))) a WHERE a.grantee=0) THEN
  RAISE EXCEPTION 'Expected the private native owner-only email delivery table';
 END IF;
 SELECT pg_get_expr(c.conbin,c.conrelid),c.convalidated,c.conkey INTO actual,validated,module_columns
 FROM pg_constraint c WHERE c.conrelid=relation AND c.conname='automation_email_delivery_module_check' AND c.contype='c';
 SELECT attnum INTO module_att FROM pg_attribute WHERE attrelid=relation AND attname='module' AND NOT attisdropped;
 IF actual IS NULL OR validated IS DISTINCT FROM true OR module_columns IS DISTINCT FROM ARRAY[module_att]::smallint[]
 OR encode(sha256(convert_to(regexp_replace(actual,'[[:space:]]','','g'),'UTF8')),'hex')
  IS DISTINCT FROM 'dd40979c5c5da63f5477bf70acc81aca285217dbd47fb9a4340cfa9b85dad0b8' THEN
  RAISE EXCEPTION 'Expected the reviewed closed Probation/Contract email module constraint';
 END IF;
 SELECT md5(coalesce(string_agg(to_jsonb(p)::text,',' ORDER BY p.oid),'')) INTO old_policies FROM pg_policy p WHERE p.polrelid=relation;
 SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY t.oid),'')) INTO old_triggers FROM pg_trigger t WHERE t.tgrelid=relation;
 ALTER TABLE public.automation_email_delivery DROP CONSTRAINT automation_email_delivery_module_check;
 ALTER TABLE public.automation_email_delivery ADD CONSTRAINT automation_email_delivery_module_check CHECK(module IN('probation','contract_staff','off'));
 SELECT jsonb_build_array(c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) INTO current_shape FROM pg_class c WHERE c.oid=relation;
 IF current_shape IS DISTINCT FROM jsonb_build_array(old_owner,old_acl,old_rls,old_force)
 OR old_policies IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(p)::text,',' ORDER BY p.oid),'')) FROM pg_policy p WHERE p.polrelid=relation)
 OR old_triggers IS DISTINCT FROM (SELECT md5(coalesce(string_agg(to_jsonb(t)::text,',' ORDER BY t.oid),'')) FROM pg_trigger t WHERE t.tgrelid=relation)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=relation AND c.conname='automation_email_delivery_module_check'
  AND c.contype='c' AND c.convalidated AND c.conkey=module_columns
  AND encode(sha256(convert_to(regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]]','','g'),'UTF8')),'hex')='4c687b510450e27478806196061017a5219b6f6ff088c607a424eb3c3b613c51') THEN
  RAISE EXCEPTION 'Native email delivery boundary changed during module compatibility repair';
 END IF;
END $repair$;
