-- Snapshot-only chooser reads for Calendar and Cancel. Reuse Return's policy
-- projection and keep each legacy chooser's caller, lock, ordering and output.
DO $preimage$
DECLARE expected record; observed pg_proc;
BEGIN
 FOR expected IN SELECT * FROM (VALUES
  ('app.assistant_rewards_return_presentation_choices_v1()','5072a8533726e2eead3c8348db633981',true),
  ('app.assistant_rewards_calendar_choices()','0e191a668a6ddb89dbfa96dd3be92172',true),
  ('app._assistant_rewards_calendar_review_identity(uuid,boolean,boolean)','0ab35cd877190447525443a734af3779',false),
  ('app.assistant_rewards_cancel_choices()','35df00ee31084808cef236eeac3bc8b0',true),
  ('app._assistant_rewards_cancel_review_identity(uuid,boolean,boolean)','57468d9edcfc84c00d0901e4d2a04e52',false)
 ) e(signature,body_hash,app_execute) LOOP
  SELECT * INTO observed FROM pg_catalog.pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF observed.oid IS NULL OR observed.proowner<>current_user::regrole OR NOT observed.prosecdef
   OR md5(observed.prosrc) IS DISTINCT FROM expected.body_hash
   OR has_function_privilege('ai_hr_app',observed.oid,'EXECUTE') IS DISTINCT FROM expected.app_execute
  THEN RAISE EXCEPTION 'Unexpected Rewards presentation predecessor' USING ERRCODE='55000'; END IF;
 END LOOP;
END $preimage$;
--> statement-breakpoint
CREATE FUNCTION app._assert_assistant_rewards_presentation_v1(wanted_action text) RETURNS void
 LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $actor$
DECLARE
 tid uuid:=app.current_tenant_id();
 uid uuid:=app.current_user_id();
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
  OR wanted_action IS NULL OR wanted_action NOT IN ('rewards.annual_review.return','rewards.calendar.update','rewards.cancel_review')
  OR NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.id=wanted_action
    AND k.module='rewards' AND k.tier_ceiling='approve' AND k.category='pay' AND k.review_kind=k.id)
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='42501'; END IF;
 IF app._assistant_presentation_feature_unpaused_v1() IS NOT TRUE
  OR EXISTS(SELECT 1 FROM app.ai_agent_action_pauses() p WHERE p.action_id=wanted_action AND p.paused)
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='42501'; END IF;
END $actor$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assert_assistant_rewards_presentation_v1(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_rewards_return_presentation_choices_v1() RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE payload jsonb;
BEGIN
 PERFORM app._assert_assistant_rewards_presentation_v1('rewards.annual_review.return');
 payload:=app._assistant_rewards_return_choice_payload_v1();
 -- An upper transport guard only. The exact existing JavaScript Zod and
 -- Buffer.byteLength(JSON.stringify(value)) <= 49152 checks still decide.
 IF payload IS NULL OR octet_length(payload::text)>1048576
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='22000'; END IF;
 RETURN payload;
END $snapshot$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_calendar_choice_payload_v1() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $payload$
DECLARE items jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'cycleId',q.cycle_id,'companyId',q.company_id,'name',q.display_name,'companyName',q.company_name,'calendarId',q.calendar_id,'revision',q.revision,'values',q.values) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items
 FROM (SELECT DISTINCT ON (u.cycle_id,u.company_id) u.id,u.cycle_id,u.company_id,c.legal_name AS company_name,rc.name AS display_name,cal.id AS calendar_id,coalesce(cal.revision,0) AS revision,app._assistant_rewards_calendar_values(cal) AS values
 FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id LEFT JOIN public.reward_calendar cal ON cal.tenant_id=u.tenant_id AND cal.company_id=u.company_id AND cal.cycle_id=u.cycle_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND (u.created_by=app.current_user_id() OR app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(u.id))) AND app.reward_calendar_access(u.cycle_id,u.company_id,true) ORDER BY u.cycle_id,u.company_id,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $payload$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assistant_rewards_calendar_choice_payload_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_rewards_calendar_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $legacy$
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 RETURN app._assistant_rewards_calendar_choice_payload_v1();
END $legacy$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_presentation_choices_v1() RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE payload jsonb;
BEGIN
 PERFORM app._assert_assistant_rewards_presentation_v1('rewards.calendar.update');
 payload:=app._assistant_rewards_calendar_choice_payload_v1();
 -- An upper transport guard only. The exact existing JavaScript Zod and
 -- Buffer.byteLength(JSON.stringify(value)) <= 49152 checks still decide.
 IF payload IS NULL OR octet_length(payload::text)>1048576
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='22000'; END IF;
 RETURN payload;
END $snapshot$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_presentation_choices_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_presentation_choices_v1() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_cancel_choice_payload_v1() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $payload$
DECLARE items jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'name',q.display_name,'companyName',q.company_name,'revision',q.revision,'status',q.status) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items
 FROM (SELECT u.id,u.revision,u.status,c.legal_name AS company_name,rc.name||' · '||coalesce(nullif(trim(b.label),''),b.code) AS display_name
 FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id JOIN public.business_unit b ON b.id=u.business_unit_id AND b.tenant_id=u.tenant_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND u.status IN ('draft','bg','gr','ctro','ec','approved') AND (app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(u.id) r(role) WHERE r.role='gr')) ORDER BY c.legal_name,display_name,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $payload$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._assistant_rewards_cancel_choice_payload_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_rewards_cancel_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $legacy$
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 RETURN app._assistant_rewards_cancel_choice_payload_v1();
END $legacy$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_presentation_choices_v1() RETURNS jsonb
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $snapshot$
DECLARE payload jsonb;
BEGIN
 PERFORM app._assert_assistant_rewards_presentation_v1('rewards.cancel_review');
 payload:=app._assistant_rewards_cancel_choice_payload_v1();
 -- An upper transport guard only. The exact existing JavaScript Zod and
 -- Buffer.byteLength(JSON.stringify(value)) <= 49152 checks still decide.
 IF payload IS NULL OR octet_length(payload::text)>1048576
 THEN RAISE EXCEPTION 'Rewards presentation unavailable' USING ERRCODE='22000'; END IF;
 RETURN payload;
END $snapshot$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_presentation_choices_v1() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_presentation_choices_v1() TO ai_hr_app;
