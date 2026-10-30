CREATE TEMP VIEW port_catalog_receipt AS
WITH body AS (SELECT jsonb_build_object(
 'database',current_database(),'server_version',current_setting('server_version_num'),
 'roles',(SELECT jsonb_agg(jsonb_build_array(oid,rolname,rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolconnlimit,rolvaliduntil) ORDER BY oid) FROM pg_roles),
 'edges',(SELECT jsonb_agg(jsonb_build_array(roleid,member,grantor,inherit_option,set_option,admin_option) ORDER BY roleid,member,grantor) FROM pg_auth_members),
 'schema',(SELECT jsonb_build_array(oid,nspowner,nspacl) FROM pg_namespace WHERE nspname='app'),
 'tables',(SELECT jsonb_agg(jsonb_build_array(oid,relowner,relrowsecurity,relforcerowsecurity,relacl) ORDER BY oid) FROM pg_class WHERE oid IN('public.employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass)),
 'columnAcls',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attnum,a.attname,a.attacl) ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND c.oid=ANY(ARRAY[to_regclass('app.assistant_own_leave_review'),to_regclass('app.assistant_own_leave_review_content'),to_regclass('public.employee_draft'),to_regclass('app.native_outcome_source_capture'),to_regclass('app.native_outcome_source_target'),to_regclass('public.ai_native_outcome_association')])),
 'privateRelationAcls',(SELECT jsonb_agg(jsonb_build_array(c.oid,n.nspname,c.relname,c.relowner,c.relacl) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=ANY(ARRAY[to_regclass('app.native_outcome_source_capture'),to_regclass('app.native_outcome_source_target'),to_regclass('public.ai_native_outcome_association')])),
 'ledger',(SELECT jsonb_agg(jsonb_build_array(id,hash,created_at) ORDER BY id) FROM drizzle.__drizzle_migrations)
 ) value)
SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') catalog_sha,value AS catalog FROM body;
