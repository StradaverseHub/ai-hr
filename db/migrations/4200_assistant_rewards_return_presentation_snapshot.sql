-- UI-only annual return choices from one admitted REPEATABLE READ / READ ONLY
-- snapshot. Command authority, writes, revalidation and Access locks stay on
-- their existing paths. Factor the existing policy and ordered choice facts so
-- a presentation snapshot cannot drift into a second business-rule owner.
DO $preimage$
DECLARE expected record; observed pg_proc;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('app._ai_control_context_for_purpose(text,boolean,boolean)','1ef73e989fb4a6132bbeb87da9d939a8',false),
  ('app._ai_applicable_policies(text,uuid[])','91025b6ae75d9850596f8e922376466a',false),
  ('app._ai_group_policies()','d71cd756ea151b3673e6bdaeaf86e4fa',false),
  ('app.assistant_rewards_return_choices()','625ab23ce5437cd55d1250d979782e1a',true),
  ('app._assistant_rewards_return_review_identity(uuid,boolean,boolean)','6172e6a12ff2837d333e243d72aead9b',false)
 ) e(signature,body_hash,app_execute) LOOP
  SELECT * INTO observed FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF observed.oid IS NULL OR observed.proowner<>current_user::regrole OR NOT observed.prosecdef
   OR md5(observed.prosrc) IS DISTINCT FROM expected.body_hash
   OR has_function_privilege('ai_hr_app',observed.oid,'EXECUTE') IS DISTINCT FROM expected.app_execute
  THEN RAISE EXCEPTION 'Unexpected Assistant presentation predecessor' USING ERRCODE='55000';END IF;
 END LOOP;
END $preimage$;
--> statement-breakpoint

CREATE FUNCTION app._ai_control_context_policy_facts(
 wanted_feature text, forced_pause boolean, pause_only boolean)
 RETURNS TABLE(company_ids uuid[], feature_paused boolean)
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=public,pg_temp AS $facts$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();
BEGIN
 feature_paused:=coalesce(forced_pause,false) OR EXISTS(SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=tid AND c.stopped);
 IF pause_only IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='company' AND NOT p.enabled) THEN
 WITH navigation_visible AS MATERIALIZED(SELECT unnest(app.visible_employment_ids())AS id)
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid
 AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e JOIN navigation_visible v ON v.id=e.id
 WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
 ELSE company_ids:='{}'::uuid[];END IF;
 -- One switch owner per feature: its setting when it has one, otherwise its `feature:` policy row.
 SELECT s.setting_key INTO switch_key FROM app.ai_feature_setting s WHERE s.feature_id=wanted_feature;
 IF switch_key IS NULL AND EXISTS(SELECT 1 FROM ai_control_policy p WHERE p.tenant_id=tid AND p.kind='feature' AND p.feature_id=wanted_feature AND NOT p.enabled) THEN feature_paused:=true;END IF;
 -- Re-read canonical switches at admission; a page/session snapshot can predate a pause.
 IF switch_key IS NOT NULL THEN
  SELECT coalesce(nullif(t.value,'null'::jsonb),d.default_value) INTO switch_on FROM setting_definition d
   LEFT JOIN tenant_setting t ON t.key=d.key AND t.tenant_id=tid AND(d.scope='tenant' OR t.source<>'customer') WHERE d.key=switch_key;
  IF switch_on IS DISTINCT FROM 'true'::jsonb THEN feature_paused:=true;END IF;
 END IF;
 RETURN NEXT;
END $facts$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_control_context_policy_facts(text,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app._ai_control_context_for_purpose(wanted_feature text,forced_pause boolean,pause_only boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $legacy$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR wanted_feature IS NULL OR wanted_feature NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI feature';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 IF current_setting('transaction_isolation')='read committed' AND current_setting('transaction_read_only')='on' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtext('ai-control'),hashtext(tid::text));
 ELSE PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)); END IF;
 RETURN QUERY SELECT f.company_ids,f.feature_paused
 FROM app._ai_control_context_policy_facts(wanted_feature,forced_pause,pause_only) f;
END $legacy$;
--> statement-breakpoint

CREATE FUNCTION app._assistant_presentation_feature_unpaused_v1() RETURNS boolean
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE
 tid uuid:=app.current_tenant_id();
 uid uuid:=app.current_user_id();
 facts record;
BEGIN
 IF session_user<>'ai_hr_app'
  OR current_setting('transaction_isolation')<>'repeatable read'
  OR current_setting('transaction_read_only')<>'on'
  OR tid IS NULL OR uid IS NULL
  OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
  OR app.principal_snapshot_current() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=tid AND t.status IN ('active','trial'))
  OR NOT EXISTS(SELECT 1 FROM public.assistant_grant g WHERE g.tenant_id=tid AND g.app_user_id=uid AND g.revoked_at IS NULL)
 THEN RAISE EXCEPTION 'Assistant presentation unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_feature_setting s WHERE s.feature_id='hr_assistant')
 THEN RAISE EXCEPTION 'Assistant presentation feature owner changed' USING ERRCODE='55000';END IF;
 -- forcedPauseTx for current settingless hr_assistant is exactly false.
 SELECT * INTO STRICT facts FROM app._ai_control_context_policy_facts('hr_assistant',false,true);
 RETURN NOT facts.feature_paused AND NOT EXISTS(
  SELECT 1 FROM app._ai_applicable_policies('hr_assistant',facts.company_ids) p WHERE NOT p.enabled);
END $snapshot$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assistant_presentation_feature_unpaused_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE FUNCTION app._assistant_rewards_return_choice_payload_v1() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $payload$
DECLARE items jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'companyName',q.company_name,'name',q.display_name,'revision',q.revision,'status',q.status) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items FROM (
 SELECT u.id,u.revision,u.status,c.legal_name company_name,rc.name||' · '||coalesce(nullif(trim(b.label),''),b.code) display_name FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.kind='annual' AND u.deleted_at IS NULL AND ((u.status IN ('bg','gr','ctro','ec') AND u.status=ANY(ARRAY(SELECT app.reward_roles(u.id)))) OR (u.status='approved' AND ARRAY(SELECT app.reward_roles(u.id)) && ARRAY['gr','ctro','ec'])) ORDER BY c.legal_name,display_name,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $payload$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assistant_rewards_return_choice_payload_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.assistant_rewards_return_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $legacy$
BEGIN
 PERFORM app._assistant_rewards_return_review_identity(NULL,false,false);
 RETURN app._assistant_rewards_return_choice_payload_v1();
END $legacy$;
--> statement-breakpoint

-- Fixed native action, actor and mode. The app composes the paid modules and
-- human tier in this same transaction. The helper below shares all pause facts
-- with the command path, while the existing action projection owns its bit.
CREATE FUNCTION app.assistant_rewards_return_presentation_choices_v1() RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE
 tid uuid:=app.current_tenant_id();
 uid uuid:=app.current_user_id();
 payload jsonb;
BEGIN
 IF session_user<>'ai_hr_app'
  OR current_setting('transaction_isolation')<>'repeatable read'
  OR current_setting('transaction_read_only')<>'on'
  OR tid IS NULL OR uid IS NULL
  OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
  OR app.principal_snapshot_current() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=uid AND a.tenant_id=tid AND a.archived_at IS NULL
    AND NOT app.login_blocked(a.id) AND (a.person_id IS NULL OR EXISTS(
     SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id)))
  OR NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id='rewards.annual_review.return'
    AND k.module='rewards' AND k.tier_ceiling='approve' AND k.category='pay' AND k.review_kind=k.id)
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='42501'; END IF;
 IF app._assistant_presentation_feature_unpaused_v1() IS NOT TRUE
  OR EXISTS(SELECT 1 FROM app.ai_agent_action_pauses() p WHERE p.action_id='rewards.annual_review.return' AND p.paused)
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='42501'; END IF;
 payload:=app._assistant_rewards_return_choice_payload_v1();
 -- An upper transport guard only. The exact existing JavaScript Zod and
 -- Buffer.byteLength(JSON.stringify(value)) <= 49152 checks still decide.
 IF payload IS NULL OR octet_length(payload::text)>1048576
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='22000'; END IF;
 RETURN payload;
END $snapshot$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assistant_rewards_return_presentation_choices_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assistant_rewards_return_presentation_choices_v1() TO ai_hr_app;
