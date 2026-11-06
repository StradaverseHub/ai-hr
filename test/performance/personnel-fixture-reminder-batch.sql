-- Disposable retained-fixture preparation only. Not an application migration.
-- Same per-statement counter expression measured with exact revisions, rollback and restricted
-- ownership in41785596183; no other trigger or constraint is removed or disabled.
CREATE FUNCTION app.performance_fixture_reminder_batch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
BEGIN
 INSERT INTO public.performance_assessment_reminder_epoch(tenant_id,scope_id,revision)
 SELECT tenant_id,'00000000-0000-0000-0000-000000000000'::uuid,count(*)
 FROM reminder_changed_rows WHERE tenant_id IS NOT NULL GROUP BY tenant_id ORDER BY tenant_id
 ON CONFLICT(tenant_id,scope_id) DO UPDATE
 SET revision=performance_assessment_reminder_epoch.revision+EXCLUDED.revision;
 RETURN NULL;
END;
$body$;
REVOKE ALL ON FUNCTION app.performance_fixture_reminder_batch() FROM PUBLIC,ai_hr_app;
DO $install$
DECLARE table_name text;event_name text;original_owner text;
BEGIN
 SELECT pg_get_userbyid(proowner) INTO original_owner FROM pg_proc
 WHERE oid='app.assessment_reminder_touch()'::regprocedure;
 EXECUTE format('ALTER FUNCTION app.performance_fixture_reminder_batch() OWNER TO %I',original_owner);
 FOREACH table_name IN ARRAY ARRAY['person','employment'] LOOP
  EXECUTE format('DROP TRIGGER assessment_reminder_touch ON public.%I',table_name);
  FOREACH event_name IN ARRAY ARRAY['insert','update','delete'] LOOP
   EXECUTE format('CREATE TRIGGER %I AFTER %s ON public.%I REFERENCING %s TABLE AS reminder_changed_rows FOR EACH STATEMENT EXECUTE FUNCTION app.performance_fixture_reminder_batch()',
    'performance_fixture_reminder_'||event_name,upper(event_name),table_name,CASE WHEN event_name='delete' THEN 'OLD' ELSE 'NEW' END);
  END LOOP;
 END LOOP;
END;
$install$;
