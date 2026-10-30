-- Direct app LOGIN against ACTUAL installed0859, never an uncommitted placeholder or SET ROLE.
\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
 IF session_user<>'ai_hr_app' OR current_user<>session_user OR current_setting('role')<>'none' THEN RAISE EXCEPTION 'real app login required';END IF;
 IF NOT has_schema_privilege(current_user,'app','USAGE') THEN RAISE EXCEPTION 'positive app schema usage missing';END IF;
 IF to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)') IS NULL OR to_regprocedure('app.native_employee_draft_discard_delete(uuid)') IS NULL THEN RAISE EXCEPTION 'actual0859 is not installed';END IF;
 BEGIN PERFORM app._draft_discard_source_snapshot(NULL::uuid,NULL::uuid);RAISE EXCEPTION 'app private call was accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN EXECUTE 'SET LOCAL ROLE ai_hr_draft_discard_port';RAISE EXCEPTION 'app SET child was accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 IF NOT has_function_privilege(current_user,'app.native_employee_draft_discard_delete(uuid)','EXECUTE') THEN RAISE EXCEPTION 'positive native app port ACL missing';END IF;
 IF has_function_privilege(current_user,'app._draft_discard_source_snapshot(uuid,uuid)','EXECUTE') OR has_column_privilege(current_user,'app.assistant_own_leave_review_content','ciphertext','SELECT') OR has_table_privilege(current_user,'app.native_outcome_source_capture','SELECT') THEN RAISE EXCEPTION 'unexpected installed app private capability';END IF;
END $$;
ROLLBACK;
