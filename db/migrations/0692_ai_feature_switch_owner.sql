-- 0692 — WP6 / R10 (review finding D7): one switch owner per AI feature. Reserved 0692, journal when 1793330000018.
--
-- 1. The setting→feature map leaves the hard-coded CASE in app._ai_control_context (0541 → 0568 → 0621) for one
--    reference table, app.ai_feature_setting, seeded with EVERY lib/ai/features.ts AI_FEATURES entry whose
--    `setting` is not null — including feedback_planning, which the SQL CASE omitted.
--    test/ai-feature-switch-owner.test.ts pins this seed to AI_FEATURES in both directions.
-- 2. One owner per feature: a setting-backed feature is switched ONLY by its setting; a settingless feature ONLY
--    by its `feature:` ai_control_policy row. The policy guard already refused feature rows for setting-backed
--    features through its settingless allow-list ('Unknown AI feature'); it now names the refusal from this
--    table. A row that predates the guard (only the owner connection could write one) is IGNORED by the pause
--    check and by admission, and core/ai-management.ts shows it on the AI management page as a stale override.
-- 3. Owner decision 3 (29 Oct 2026): the six Performance AI switches default OFF. scripts/seed-catalogs.ts
--    re-seeds setting_definition from packs/catalog.ts after migrate; aligning the stored default here keeps SQL
--    admission and the TS catalogue in agreement from the moment this migration commits. No tenant_setting row
--    is written: a tenant with an explicit stored value keeps it, one without now resolves OFF.
CREATE TABLE app.ai_feature_setting(
 feature_id text PRIMARY KEY CHECK(feature_id~'^[a-z0-9_]{1,80}$'),
 setting_key text NOT NULL UNIQUE CHECK(setting_key~'^[a-z_]+\.[a-z0-9_]+$')
);
--> statement-breakpoint
-- Installation-wide reference data, read-only to the application exactly like setting_definition (0313).
ALTER TABLE app.ai_feature_setting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.ai_feature_setting FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON app.ai_feature_setting TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY ai_feature_setting_read ON app.ai_feature_setting FOR SELECT USING(true);
--> statement-breakpoint
INSERT INTO app.ai_feature_setting(feature_id,setting_key) VALUES
('readiness_reminders','notifications.readiness_nudge_enabled'),
('claims_triage','claims.input_triage_enabled'),
('payroll_hypotheses','payroll.anomaly_hypotheses_enabled'),
('performance_360','performance.ai_360_enabled'),
('performance_tc','performance.ai_tc_enabled'),
('performance_pm','performance.ai_pm_enabled'),
('performance_review','performance.ai_review_enabled'),
('performance_idp','performance.ai_idp_enabled'),
('performance_calib','performance.ai_calib_enabled'),
('feedback_planning','feedback.ai_planning_enabled');
--> statement-breakpoint
-- 0621's control context with three changes: the switch key comes from app.ai_feature_setting instead of a CASE;
-- a `feature:` policy row pauses only a settingless feature; and the setting read applies the same provenance
-- rule as the TS entitlement snapshot (core/entitlements.ts snapshotQuery): a customer-written row on a
-- platform-scoped key is not a value. Every other line is 0621's.
CREATE OR REPLACE FUNCTION app._ai_control_context(wanted_feature text,forced_pause boolean)
 RETURNS TABLE(company_ids uuid[],feature_paused boolean) LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
DECLARE switch_key text;switch_on jsonb;tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR wanted_feature IS NULL OR wanted_feature NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','readiness_reminders','claims_triage','payroll_hypotheses','payroll_explanation','pay_rule_draft','report_insight','performance_360','performance_tc','performance_pm','performance_review','performance_idp','performance_calib','performance_assistant','feedback_planning') THEN RAISE EXCEPTION 'Invalid AI feature';END IF;
 IF NOT EXISTS(SELECT 1 FROM tenant WHERE id=tid AND status IN ('active','trial')) THEN RAISE EXCEPTION 'AI unavailable';END IF;
 IF uid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=uid AND tenant_id=tid) THEN RAISE EXCEPTION 'Unknown actor';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 feature_paused:=coalesce(forced_pause,false);
 SELECT coalesce(array_agg(c.id ORDER BY c.id),'{}') INTO company_ids FROM company c WHERE c.tenant_id=tid AND(app.is_admin_for(c.id) OR EXISTS(SELECT 1 FROM employment e WHERE e.tenant_id=tid AND e.company_id=c.id AND app.can_see_employment(e.id)));
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
END $$;
--> statement-breakpoint
-- 0662's applicable policies; a stale `feature:` row for a setting-backed feature no longer applies (no pause,
-- no concurrency cap). Every other branch is 0662's.
CREATE OR REPLACE FUNCTION app._ai_applicable_policies(wanted_feature text,wanted_companies uuid[])
 RETURNS SETOF public.ai_control_policy LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.* FROM ai_control_policy p WHERE p.tenant_id=app.current_tenant_id() AND
 ((p.kind='feature' AND p.feature_id=wanted_feature AND NOT EXISTS(SELECT 1 FROM app.ai_feature_setting s WHERE s.feature_id=p.feature_id))
 OR(p.kind='user' AND p.subject_id=app.current_user_id()) OR(p.kind='company' AND p.subject_id=ANY(wanted_companies))
 OR(p.id IN(SELECT g.id FROM app._ai_group_policies() g))
 OR(p.kind='user_default' AND app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ai_control_policy o WHERE o.tenant_id=app.current_tenant_id() AND o.kind='user' AND o.subject_id=app.current_user_id())
  AND NOT EXISTS(SELECT 1 FROM app._ai_group_policies()))) ORDER BY p.scope_key
$$;
--> statement-breakpoint
-- 0662's guard plus one named refusal: a setting-backed feature cannot gain a second (policy-row) switch. The
-- settingless allow-list stays the exact AI_FEATURES setting === null set (test/ai-management-contract.test.ts).
CREATE OR REPLACE FUNCTION app.ai_control_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(NEW.tenant_id::text));
 IF NEW.kind='feature' AND NEW.feature_id='feedback_planning' THEN RAISE EXCEPTION 'Platform managed feature';END IF;
 IF NEW.kind='feature' AND EXISTS(SELECT 1 FROM app.ai_feature_setting s WHERE s.feature_id=NEW.feature_id) THEN RAISE EXCEPTION 'Setting-controlled AI feature';END IF;
 IF NEW.kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown company';END IF;
 IF NEW.kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown user';END IF;
 IF NEW.kind='group_company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Unknown company';END IF;
 IF NEW.kind='group_department' AND NOT EXISTS(SELECT 1 FROM department WHERE id=NEW.subject_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL) THEN RAISE EXCEPTION 'Unknown department';END IF;
 IF NEW.kind='feature' AND NEW.feature_id NOT IN ('hr_assistant','provider_evaluation','module_agent_evaluation','personnel_import_mapping','module_agent_planning','payroll_explanation','pay_rule_draft','report_insight','performance_assistant') THEN RAISE EXCEPTION 'Unknown AI feature';END IF;
 NEW.updated_by_user_id:=app.current_user_id();NEW.updated_at:=now();
 RETURN NEW;
END $$;
--> statement-breakpoint
UPDATE setting_definition SET default_value='false'::jsonb,default_on_install='false'::jsonb
 WHERE key IN ('performance.ai_360_enabled','performance.ai_tc_enabled','performance.ai_pm_enabled','performance.ai_review_enabled','performance.ai_idp_enabled','performance.ai_calib_enabled');
