-- Centrally reserved source-only filename tag: 0626_module_agent_feedback; journal index/timestamp DEFERRED.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve actual human journal prerequisites; final index/when allocated centrally at source freeze.
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
CREATE TABLE public.ai_agent_feedback (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 user_id uuid NOT NULL REFERENCES public.app_user(id),
 exchange_id uuid NOT NULL REFERENCES public.assistant_exchange(id) ON DELETE CASCADE,
 outcome text NOT NULL CHECK (outcome IN ('helpful','needs_correction','incorrect')),
 consented boolean NOT NULL CHECK (consented),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 UNIQUE (tenant_id,user_id,exchange_id),
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
--> statement-breakpoint
ALTER TABLE public.ai_agent_feedback ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_agent_feedback FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A real table-owner connection can retire expired opinions without impersonating a group admin.
-- SECURITY DEFINER app calls cannot acquire this path: session_user stays the actual app login.
-- No new role, BYPASSRLS, table privilege, nonexpired visibility, INSERT or UPDATE grant is added.
CREATE POLICY ai_agent_feedback_expired_connection_select ON public.ai_agent_feedback FOR SELECT TO PUBLIC
 USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
  AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.ai_agent_feedback'::regclass)));
--> statement-breakpoint
CREATE POLICY ai_agent_feedback_expired_connection_delete ON public.ai_agent_feedback FOR DELETE TO PUBLIC
 USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
  AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.ai_agent_feedback'::regclass)));
--> statement-breakpoint
-- SELECT FOR UPDATE also uses UPDATE's USING policy. WITH CHECK(false) still refuses every
-- UPDATE effect, while permitting the expired-only row locking needed before bounded deletion.
CREATE POLICY ai_agent_feedback_expired_connection_lock ON public.ai_agent_feedback FOR UPDATE TO PUBLIC
 USING(expires_at<=now() AND current_user=session_user AND session_user<>'ai_hr_app'
  AND session_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.ai_agent_feedback'::regclass)))
 WITH CHECK(false);
--> statement-breakpoint
CREATE POLICY ai_agent_feedback_own ON public.ai_agent_feedback FOR ALL TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id())
 WITH CHECK (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id()
  AND EXISTS (SELECT 1 FROM public.assistant_exchange e WHERE e.id=exchange_id
   AND e.tenant_id=app.current_tenant_id() AND e.app_user_id=app.current_user_id()));
--> statement-breakpoint
REVOKE ALL ON public.ai_agent_feedback FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ai_agent_feedback TO ai_hr_app;

--> statement-breakpoint
-- The FORCE-RLS table owner receives only an expired/current-tenant maintenance policy.
-- Ordinary application calls cannot acquire this policy: current_user remains ai_hr_app.
CREATE POLICY ai_agent_feedback_expiry_owner ON public.ai_agent_feedback FOR ALL TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT c.relowner FROM pg_class c WHERE c.oid='public.ai_agent_feedback'::regclass))
  AND tenant_id=app.current_tenant_id() AND expires_at<=now() AND app.is_group_admin() AND app.principal_snapshot_current())
 WITH CHECK(false);
--> statement-breakpoint
CREATE FUNCTION app.purge_expired_agent_feedback(wanted_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE removed integer;
BEGIN
 IF wanted_limit IS NULL OR wanted_limit<1 OR wanted_limit>100 OR app.current_tenant_id() IS NULL
  OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_group_admin()
  OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Feedback maintenance unavailable';END IF;
 DELETE FROM public.ai_agent_feedback WHERE id IN(SELECT id FROM public.ai_agent_feedback
  WHERE tenant_id=app.current_tenant_id() AND expires_at<=now() ORDER BY expires_at,id LIMIT wanted_limit FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.purge_expired_agent_feedback(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_agent_feedback(integer) TO ai_hr_app;
