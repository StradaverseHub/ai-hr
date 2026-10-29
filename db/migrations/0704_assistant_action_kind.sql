-- WP7 (architecture review R3, D4/D5; ADR-0151 §4.2): one reference row per Assistant agent action, fed by
-- lib/ai/agent-action-registry.ts. Adding an action = one defineAgentAction entry + one INSERT row into
-- app.assistant_action_kind in a new migration. The prepared-review store and the native-outcome association
-- now reference this table instead of re-declaring closed CHECK lists (0622, 0650, 0670, 0671, 0677 stay
-- byte-identical; their list constraints are dropped here, after the foreign keys are validated).
-- Per-kind column rules, effect verifiers and the native-outcome event mapping remain per-kind SQL: they are
-- each action's behaviour, not a membership list. Reference data only: no tenant, person or HR values.
-- Claimed as 0693 / when 1793330000019 for the AI architecture programme (29 Oct 2026).
CREATE TABLE app.assistant_action_kind(
 id text PRIMARY KEY,
 module text NOT NULL,
 tier_ceiling text NOT NULL,
 category text NOT NULL,
 -- The prepared-review store's key: the id itself, or NULL for a human workflow with no review row.
 review_kind text,
 CONSTRAINT assistant_action_kind_id_format CHECK(id~'^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$'),
 CONSTRAINT assistant_action_kind_module_format CHECK(module~'^[a-z][a-z0-9_-]*$'),
 CONSTRAINT assistant_action_kind_tier CHECK(tier_ceiling IN('automatic','confirm','approve','handoff')),
 CONSTRAINT assistant_action_kind_category_format CHECK(category~'^[a-z][a-z_]*$'),
 -- ADR-0151 §4.4 and WP2: Automatic only for reads, reminders and chasers. Pay, approvals, access,
 -- terminations, ratings, hiring, promotion, discipline and payroll can therefore never be Automatic.
 CONSTRAINT assistant_action_kind_automatic_scope CHECK(tier_ceiling<>'automatic' OR category IN('read','reminder','chaser')),
 CONSTRAINT assistant_action_kind_review_kind_self CHECK(review_kind IS NULL OR review_kind=id),
 CONSTRAINT assistant_action_kind_review_kind_unique UNIQUE(review_kind)
);
--> statement-breakpoint
-- Installation-wide catalogue, like public.module (0313): readable by the application role, written only by
-- migrations. A tenant predicate would hide every row and silently break the references below.
ALTER TABLE app.assistant_action_kind ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON app.assistant_action_kind FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON app.assistant_action_kind TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY assistant_action_kind_read ON app.assistant_action_kind FOR SELECT TO ai_hr_app USING(true);
--> statement-breakpoint
-- One row per registry entry, in registry order. test/agent-action-registry.test.ts parses these rows.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
('employees.import','employees','handoff','personnel',NULL),
('org.reporting.change','org','approve','personnel','org.reporting.change'),
('leave.apply','leave','confirm','own_work','leave.apply'),
('leave.cancel','leave','confirm','own_work','leave.cancel'),
('leave.edit','leave','confirm','own_work','leave.edit'),
('ess.profile.request','ess','confirm','own_work','ess.profile.request'),
('approvals.leave.decide','approvals','approve','approvals','approvals.leave.decide'),
('approvals.claim.decide','approvals','approve','approvals','approvals.claim.decide'),
('approvals.attendance.decide','approvals','approve','approvals','approvals.attendance.decide'),
('approvals.toil.decide','approvals','approve','approvals','approvals.toil.decide'),
('knowledge_base.article.create','knowledge_base','confirm','own_work','knowledge_base.article.create'),
('payroll.close','payroll','approve','payroll','payroll.close'),
('attendance.correction.request','attendance','confirm','own_work','attendance.correction.request'),
('attendance.overtime.request','attendance','confirm','pay','attendance.overtime.request'),
('claims.draft.save','claims','confirm','claim_money','claims.draft.save'),
('claims.submit','claims','confirm','claim_money','claims.submit'),
('claims.cancel','claims','confirm','claim_money','claims.cancel'),
('performance.review.acknowledge','performance','confirm','own_work','performance.review.acknowledge'),
('performance.onehr.plan.acknowledge','performance','confirm','own_work','performance.onehr.plan.acknowledge'),
('rewards.post','rewards','approve','pay','rewards.post'),
('lifecycle.acknowledgement.submit','lifecycle','confirm','own_work','lifecycle.acknowledgement.submit'),
('toil.replacement.request','toil','confirm','own_work','toil.replacement.request'),
('multi_cycle_payroll.create_run','multi_cycle_payroll','approve','payroll','multi_cycle_payroll.create_run'),
('typed_pay_components.create','typed_pay_components','approve','pay','typed_pay_components.create'),
('country-my.statutory.update','country-my','approve','payroll','country-my.statutory.update'),
('notifications.email_preferences.save','notifications','confirm','own_work','notifications.email_preferences.save'),
('system_testing.execution.save','system_testing','confirm','own_work','system_testing.execution.save'),
('leave.adjustment.apply','leave','approve','approvals','leave.adjustment.apply'),
('employees.movement.transfer','employees','approve','personnel','employees.movement.transfer'),
('toil.credit.grant','toil','approve','approvals','toil.credit.grant');
--> statement-breakpoint
-- Refuse, changing nothing, when a stored review names a kind the registry does not know.
DO $$
DECLARE unknown text;
BEGIN
 SELECT string_agg(DISTINCT r.action_kind,', ' ORDER BY r.action_kind) INTO unknown FROM app.assistant_own_leave_review r
  WHERE NOT EXISTS(SELECT 1 FROM app.assistant_action_kind k WHERE k.review_kind=r.action_kind);
 IF unknown IS NOT NULL THEN
  RAISE EXCEPTION '0693: app.assistant_own_leave_review has action kinds with no app.assistant_action_kind review row: %',unknown
   USING HINT='Register each kind in lib/ai/agent-action-registry.ts and seed its row before this migration; nothing was changed.';
 END IF;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_action_kind_registered
 FOREIGN KEY(action_kind) REFERENCES app.assistant_action_kind(review_kind) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE public.ai_native_outcome_association ADD CONSTRAINT ai_native_outcome_association_action_registered
 FOREIGN KEY(action) REFERENCES app.assistant_action_kind(id) ON UPDATE RESTRICT ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
-- Validation reads every row (the association table forces RLS, so the explicit check above cannot see it
-- under a non-superuser owner). A violation becomes one clear refusal instead of a raw key error.
DO $$
DECLARE detail text;
BEGIN
 ALTER TABLE app.assistant_own_leave_review VALIDATE CONSTRAINT assistant_review_action_kind_registered;
 ALTER TABLE public.ai_native_outcome_association VALIDATE CONSTRAINT ai_native_outcome_association_action_registered;
EXCEPTION WHEN foreign_key_violation THEN
 GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
 RAISE EXCEPTION '0693: an existing Assistant action row names a kind missing from app.assistant_action_kind (%)',detail
  USING HINT='Register each kind in lib/ai/agent-action-registry.ts and seed its row before this migration; nothing was changed.';
END $$;
--> statement-breakpoint
-- Only now that both references are validated: the closed lists re-declared by 0670, 0671 and 0677.
ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_action_kind;
--> statement-breakpoint
ALTER TABLE public.ai_native_outcome_association DROP CONSTRAINT ai_native_outcome_association_action;
