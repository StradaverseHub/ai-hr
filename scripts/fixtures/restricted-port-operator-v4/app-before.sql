-- Direct app LOGIN only. Private domain functions DO NOT exist yet: no private-call claim here.
\set ON_ERROR_STOP on
BEGIN;
DO $$ DECLARE target regclass;permission_name text;BEGIN
 IF session_user<>'ai_hr_app' OR current_user<>session_user OR current_setting('role')<>'none' THEN RAISE EXCEPTION 'real app login required';END IF;
 IF NOT has_schema_privilege(current_user,'app','USAGE') THEN RAISE EXCEPTION 'positive app schema usage missing';END IF;
 IF pg_has_role(current_user,'ai_hr_draft_discard_port','MEMBER') OR has_schema_privilege(current_user,'app','CREATE') OR has_table_privilege(current_user,'app.assistant_own_leave_review','SELECT') OR has_column_privilege(current_user,'app.assistant_own_leave_review_content','ciphertext','SELECT') THEN RAISE EXCEPTION 'unexpected app capability';END IF;
 FOREACH target IN ARRAY ARRAY['app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass,'app.native_outcome_source_capture'::regclass,'app.native_outcome_source_target'::regclass] LOOP
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(current_user,target,permission_name) THEN RAISE EXCEPTION 'unexpected effective app private relation privilege';END IF;
  END LOOP;
  FOREACH permission_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
   IF EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=target AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,target,a.attnum,permission_name)) THEN RAISE EXCEPTION 'unexpected effective app private column privilege';END IF;
  END LOOP;
 END LOOP;
 BEGIN EXECUTE 'SET LOCAL ROLE ai_hr_draft_discard_port';RAISE EXCEPTION 'app SET child was accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
END $$;
ROLLBACK;
