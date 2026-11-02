-- ADR-0170 step 5a (§3.11, §10.3 move 3): company policy is versioned automatically on every admin edit, so
-- every native check can return the version it used for the outcome record. Provisional DEVELOPMENT source
-- allocation 0891 / when1793330000291 (docs/MIGRATION-ALLOCATION.md); no installation is granted.
--
-- Entitlement tables already carry lineage and effective-dated versions and are not changed here. Leave
-- policy (the leave type's own rules) and approval chains (rules and reusable templates) gain a
-- `rule_version` counter that starts at 1 for every existing row and is bumped by app.teras_bump_version()
-- (0890) on any content change. No writer sets it: a supplied value is overwritten, so no edit path can
-- skip or rewind a version. Statutory checks use the country pack's own published version (no change here).
ALTER TABLE public.leave_type ADD COLUMN rule_version integer NOT NULL DEFAULT 1 CHECK (rule_version>=1);
--> statement-breakpoint
ALTER TABLE public.leave_approval_policy ADD COLUMN rule_version integer NOT NULL DEFAULT 1 CHECK (rule_version>=1);
--> statement-breakpoint
ALTER TABLE public.leave_approval_template ADD COLUMN rule_version integer NOT NULL DEFAULT 1 CHECK (rule_version>=1);
--> statement-breakpoint
CREATE TRIGGER leave_type_rule_version BEFORE UPDATE ON public.leave_type
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('rule_version');
--> statement-breakpoint
CREATE TRIGGER leave_approval_policy_rule_version BEFORE UPDATE ON public.leave_approval_policy
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('rule_version');
--> statement-breakpoint
CREATE TRIGGER leave_approval_template_rule_version BEFORE UPDATE ON public.leave_approval_template
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('rule_version');
