-- AP-062: metadata is read-only; privacy expiry is an ordinary row-locked writer.
-- Preserve committed expiry, exact-login retention across relinks, limits and command authority.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='app.assistant_own_leave_reviews_index()'::regprocedure AND p.proowner=current_user::regrole AND p.prosecdef AND md5(p.prosrc) IN ('882b3228f8838a27218fcb263659864b','da48292e57a3aefe7dc424116b5a04de')) THEN RAISE EXCEPTION 'Unexpected Own Leave predecessor: assistant_own_leave_reviews_index'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='app.assistant_own_leave_reviews_expire_own(integer)'::regprocedure AND p.proowner=current_user::regrole AND p.prosecdef AND md5(p.prosrc) IN ('c3847875065b27b370c3e88b334f9a50','daf850795e37eccaec99a89819909bd5')) THEN RAISE EXCEPTION 'Unexpected Own Leave predecessor: assistant_own_leave_reviews_expire_own'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid='app.assistant_own_leave_reviews_expire(integer)'::regprocedure AND p.proowner=current_user::regrole AND p.prosecdef AND md5(p.prosrc) IN ('3e8f6d33477a7b988ea3004ea937eb95','4fdd650b89f37812b3da39044a0f9afb')) THEN RAISE EXCEPTION 'Unexpected Own Leave predecessor: assistant_own_leave_reviews_expire'; END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_own_leave_reviews_index()
 RETURNS TABLE(action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='leave.apply'
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_index() TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_own_leave_reviews_expire_own(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();ids uuid[];
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',payroll_completion_root=CASE WHEN action_kind='payroll.reopen' THEN NULL ELSE payroll_completion_root END,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t AND user_id=u;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_own_leave_reviews_expire(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();ids uuid[];
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=t
   AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',payroll_completion_root=CASE WHEN action_kind='payroll.reopen' THEN NULL ELSE payroll_completion_root END,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire(integer) TO ai_hr_app;
