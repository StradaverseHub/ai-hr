-- Qualified read-only metadata barriers; write login/confirmation owners stay exclusive.
-- Claims preview index preserves native RLS, exact pending counts and full queue data.
CREATE FUNCTION app._assistant_assigned_index_login(p_person uuid DEFAULT NULL,p_bind boolean DEFAULT false) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'on' THEN RAISE EXCEPTION 'Leave decision review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (p_bind IS NOT TRUE OR u.person_id IS NOT DISTINCT FROM p_person)) THEN RAISE EXCEPTION 'Leave decision review unavailable' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assistant_assigned_index_login(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_assigned_reviews_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;
BEGIN
 IF current_setting('transaction_read_only')='on' THEN PERFORM app._assistant_assigned_index_login(); ELSE PERFORM app._assistant_leave_decision_login(); END IF;
 IF app._assistant_assigned_review_subject_kind(p_kind) IS NULL THEN RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind=p_kind
   AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id())
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._assistant_rewards_return_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF NOT (CASE WHEN p_write IS FALSE AND current_setting('transaction_read_only')='on' THEN pg_try_advisory_xact_lock_shared(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) ELSE pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) END) THEN RAISE EXCEPTION 'Rewards annual return busy' USING ERRCODE='55P03';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_rewards_return_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE items jsonb;
BEGIN
 PERFORM app._assistant_rewards_return_review_identity(NULL,false,false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'companyName',q.company_name,'name',q.display_name,'revision',q.revision,'status',q.status) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items FROM (
 SELECT u.id,u.revision,u.status,c.legal_name company_name,rc.name||' · '||coalesce(nullif(trim(b.label),''),b.code) display_name FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.kind='annual' AND u.deleted_at IS NULL AND ((u.status IN ('bg','gr','ctro','ec') AND u.status=ANY(ARRAY(SELECT app.reward_roles(u.id)))) OR (u.status='approved' AND ARRAY(SELECT app.reward_roles(u.id)) && ARRAY['gr','ctro','ec'])) ORDER BY c.legal_name,display_name,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $$;
--> statement-breakpoint
CREATE INDEX claim_request_preview_order_idx ON public.claim_request(tenant_id,employment_id,status,created_at DESC,id);
