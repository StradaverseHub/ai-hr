-- AI centre controls: reuse teras_mandate_control and the existing ai-control serialization boundary.
-- Source-only reservation. No applied migration is changed.
CREATE TABLE app.ai_centre_function_kind (
 function_key text PRIMARY KEY,
 default_enabled boolean NOT NULL DEFAULT false
);
--> statement-breakpoint
REVOKE ALL ON app.ai_centre_function_kind FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Preserve the previously available reads. Future reads require an explicit reviewed registration.
INSERT INTO app.ai_centre_function_kind(function_key,default_enabled) VALUES
 ('module:approvals',true),
 ('module:assistant',true),
 ('module:attendance',true),
 ('module:claims',true),
 ('module:country-my',true),
 ('module:employees',true),
 ('module:ess',true),
 ('module:knowledge_base',true),
 ('module:leave',true),
 ('module:lifecycle',true),
 ('module:multi_cycle_payroll',true),
 ('module:notifications',true),
 ('module:org',true),
 ('module:payroll',true),
 ('module:performance',true),
 ('module:rewards',true),
 ('module:system_explorer',true),
 ('module:system_testing',true),
 ('module:toil',true),
 ('module:typed_pay_components',true),
 ('read:ai_quality_summary',true),
 ('read:approval_queue',true),
 ('read:available_actions',true),
 ('read:company_setup',true),
 ('read:correction_controls_guidance',true),
 ('read:employee_profile',true),
 ('read:explain_attendance_day',true),
 ('read:explain_claim_limit',true),
 ('read:explain_leave_entitlement',true),
 ('read:explain_pay_difference',true),
 ('read:explain_payslip_statutory',true),
 ('read:import_attendance_clockings',true),
 ('read:import_employee_records',true),
 ('read:import_leave_balances',true),
 ('read:import_payroll_history',true),
 ('read:leave_entitlement_explain',true),
 ('read:loops_overview',true),
 ('read:my_claim_statuses',true),
 ('read:my_leave_balances',true),
 ('read:my_leave_requests',true),
 ('read:my_module_work',true),
 ('read:my_pay_change',true),
 ('read:my_payroll_readiness',true),
 ('read:my_payslip_summary',true),
 ('read:my_policy_handbook',true),
 ('read:my_reporting_line',true),
 ('read:orchestrator_observe',true),
 ('read:organisation_tagging_guidance',true),
 ('read:password_policy_guidance',true),
 ('read:pay_aggregates',true),
 ('read:payroll_audit_status',true),
 ('read:payroll_cycle_status',true),
 ('read:payroll_learning_status',true),
 ('read:payroll_loop_settings',true),
 ('read:prepare_import',true),
 ('read:product_capabilities',true),
 ('read:product_destinations',true),
 ('read:product_guidance',true),
 ('read:salary_payroll_checks',true),
 ('read:setup_copilot',true),
 ('read:setup_readiness',true),
 ('read:suggest_action',true),
 ('read:team_leave_summary',true),
 ('read:upcoming_holidays',true),
 ('read:who_is_away',true),
 ('read:workforce_metrics',true);
--> statement-breakpoint
CREATE TABLE app.ai_centre_read_control (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 function_key text NOT NULL REFERENCES app.ai_centre_function_kind(function_key) CHECK(function_key ~ '^(read|module):[a-z][a-z0-9_\-]{0,99}$'),
 enabled boolean NOT NULL,
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,function_key)
);
--> statement-breakpoint
ALTER TABLE app.ai_centre_read_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE app.ai_centre_read_control FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.ai_centre_read_control FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE POLICY ai_centre_read_control_read ON app.ai_centre_read_control FOR SELECT TO PUBLIC USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY ai_centre_read_control_insert ON app.ai_centre_read_control FOR INSERT TO PUBLIC WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
CREATE POLICY ai_centre_read_control_update ON app.ai_centre_read_control FOR UPDATE TO PUBLIC USING(tenant_id=app.current_tenant_id() AND app.is_group_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_assert_running(expected_generation integer DEFAULT NULL)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();g integer:=0;s boolean:=false;
BEGIN
 IF tid IS NULL OR current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'AI controls unavailable' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT stopped,version INTO s,g FROM public.teras_mandate_control WHERE tenant_id=tid;
 g:=coalesce(g,0);
 IF coalesce(s,false) OR (expected_generation IS NOT NULL AND expected_generation<>g) THEN RETURN NULL; END IF;
 RETURN g;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_assert_running(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_assert_running(integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_control_lock() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_control_lock() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER aaa_ai_centre_control_lock BEFORE INSERT OR UPDATE ON public.teras_mandate_control
 FOR EACH ROW EXECUTE FUNCTION app.ai_centre_control_lock();
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_control_state() RETURNS TABLE(stopped boolean,generation integer,pending integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE OR app.login_blocked(app.current_user_id()) OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL) THEN RAISE EXCEPTION 'AI controls unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT coalesce(c.stopped,false),coalesce(c.version,0),
 (SELECT count(*)::integer FROM public.ai_model_run r WHERE r.tenant_id=app.current_tenant_id() AND r.state='pending' AND r.operation<>'probe')
 FROM (SELECT 1) one LEFT JOIN public.teras_mandate_control c ON c.tenant_id=app.current_tenant_id();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_control_state() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_control_state() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_read_controls() RETURNS TABLE(function_key text,enabled boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT c.function_key,c.enabled FROM app.ai_centre_read_control c WHERE c.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_read_controls() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_read_controls() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_read_allowed(wanted_key text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.ai_centre_assert_running() IS NULL THEN RETURN false; END IF;
 IF wanted_key IS NULL OR wanted_key !~ '^(read|module):[a-z][a-z0-9_\-]{0,99}$' THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM app.ai_centre_function_kind k WHERE k.function_key=wanted_key AND (k.default_enabled OR EXISTS(SELECT 1 FROM app.ai_centre_read_control c WHERE c.tenant_id=app.current_tenant_id() AND c.function_key=wanted_key AND c.enabled))) AND NOT EXISTS(SELECT 1 FROM app.ai_centre_read_control c WHERE c.tenant_id=app.current_tenant_id() AND c.function_key=wanted_key AND NOT c.enabled);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_read_allowed(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_read_allowed(text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_centre_read_set(wanted_key text,wanted_enabled boolean) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 IF app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE OR app.login_blocked(app.current_user_id()) OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL) THEN RAISE EXCEPTION 'AI controls unavailable' USING ERRCODE='42501'; END IF;
 IF wanted_key IS NULL OR NOT EXISTS(SELECT 1 FROM app.ai_centre_function_kind k WHERE k.function_key=wanted_key) OR wanted_enabled IS NULL THEN RAISE EXCEPTION 'Unknown AI function'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(app.current_tenant_id()::text));
 SELECT coalesce(c.enabled,k.default_enabled) INTO prior FROM app.ai_centre_function_kind k LEFT JOIN app.ai_centre_read_control c ON c.tenant_id=app.current_tenant_id() AND c.function_key=k.function_key WHERE k.function_key=wanted_key;
 INSERT INTO app.ai_centre_read_control(tenant_id,function_key,enabled,changed_by_user_id)
 VALUES(app.current_tenant_id(),wanted_key,wanted_enabled,app.current_user_id())
 ON CONFLICT(tenant_id,function_key) DO UPDATE SET enabled=excluded.enabled,changed_by_user_id=excluded.changed_by_user_id,changed_at=clock_timestamp();
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(app.current_tenant_id(),'ai-centre-function',app.current_tenant_id(),'ai-centre.function-changed','user',app.current_user_id()::text,
 jsonb_build_object('key',wanted_key,'from',prior,'to',wanted_enabled));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_read_set(text,boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_read_set(text,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Keep the exact previous feature/allowance implementation and add a narrowing stop prerequisite.
ALTER FUNCTION app._ai_control_context(text,boolean) RENAME TO _ai_control_context_before_centre;
--> statement-breakpoint
CREATE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN QUERY SELECT c.company_ids,c.feature_paused OR EXISTS(SELECT 1 FROM public.teras_mandate_control t WHERE t.tenant_id=app.current_tenant_id() AND t.stopped)
 FROM app._ai_control_context_before_centre(wanted_feature,forced_pause) c;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_control_context(text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The template-only action guard also joins the stop boundary (not model admission).
ALTER FUNCTION app.ai_agent_action_unpaused(text) RENAME TO ai_agent_action_unpaused_before_centre;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_action_unpaused_before_centre(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_agent_action_unpaused(wanted_action text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN app.ai_agent_action_unpaused_before_centre(wanted_action) AND NOT EXISTS(SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.stopped);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_agent_action_unpaused(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_agent_action_unpaused(text) TO ai_hr_app;
--> statement-breakpoint
-- Narrow helper for unsent AI notifications. No text/recipient/source data is exposed to callers.
CREATE FUNCTION app.ai_centre_event_allowed(wanted_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.domain_event;c public.teras_mandate_control;
BEGIN
 SELECT * INTO e FROM public.domain_event WHERE id=wanted_event AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN false; END IF;
 IF e.event_type NOT LIKE 'automatic-chase.%' AND e.event_type NOT IN ('readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied','teras-loop.request.sent','teras-loop.cut-off-reminder') THEN RETURN true; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(e.tenant_id::text));
 SELECT * INTO c FROM public.teras_mandate_control WHERE tenant_id=e.tenant_id;
 IF coalesce(c.stopped,false) THEN RETURN false; END IF;
 IF e.payload ? 'aiCentreGeneration' THEN RETURN (e.payload->>'aiCentreGeneration')::integer=coalesce(c.version,0); END IF;
 RETURN c.tenant_id IS NULL OR e.occurred_at>=c.changed_at;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_event_allowed(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_centre_event_allowed(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Last private SMTP boundary: no new AI delivery start may cross a committed stop.
CREATE FUNCTION app.ai_centre_delivery_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.domain_event;c public.teras_mandate_control;
BEGIN
 IF NEW.started_at IS NULL OR OLD.started_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO e FROM public.domain_event WHERE id=NEW.source_event_id AND tenant_id=NEW.tenant_id;
 IF e.event_type LIKE 'automatic-chase.%' OR e.event_type IN ('readiness.nudge-raised','claim-request.triage-queried','teras-loop.action.applied','teras-loop.request.sent','teras-loop.cut-off-reminder') THEN
  PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
  SELECT * INTO c FROM public.teras_mandate_control WHERE tenant_id=NEW.tenant_id;
  IF coalesce(c.stopped,false) OR (e.payload ? 'aiCentreGeneration' AND (e.payload->>'aiCentreGeneration')::integer<>coalesce(c.version,0)) OR (NOT (e.payload ? 'aiCentreGeneration') AND c.tenant_id IS NOT NULL AND e.occurred_at<c.changed_at) THEN
   RAISE EXCEPTION 'AI delivery stopped' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_centre_delivery_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER aaa_ai_centre_delivery_guard BEFORE UPDATE ON public.notification_delivery
 FOR EACH ROW EXECUTE FUNCTION app.ai_centre_delivery_guard();
