-- Lifecycle removal retains immutable snapshots, memberships, shared-policy binding and audit.
ALTER TABLE reward_unit ADD COLUMN deleted_at timestamptz;
ALTER TABLE reward_unit ADD COLUMN deleted_by uuid REFERENCES app_user(id);
ALTER TABLE reward_unit ADD CONSTRAINT reward_unit_deletion_pair CHECK ((deleted_at IS NULL) = (deleted_by IS NULL));
DROP INDEX reward_annual_unit_unique;
CREATE UNIQUE INDEX reward_annual_unit_unique ON reward_unit(cycle_id,company_id,business_unit_id) WHERE kind='annual' AND deleted_at IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT m.role FROM reward_member m JOIN app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
 JOIN reward_unit r ON r.id=m.unit_id AND r.tenant_id=m.tenant_id AND r.deleted_at IS NULL
 WHERE m.unit_id=wanted_unit AND m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;
--> statement-breakpoint
-- This bounded predicate exposes a reason only to the current company administrator; salary rows
-- remain behind their existing RLS. All writers take the unit lock before this predicate is committed.
CREATE FUNCTION app.reward_deletion_reason(wanted_unit uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u reward_unit; link record; predicate text; used boolean;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id();
 IF u.id IS NULL OR NOT app.reward_admin(u.company_id) THEN RAISE EXCEPTION 'Reward administration access denied' USING ERRCODE='42501'; END IF;
 IF u.deleted_at IS NOT NULL THEN RETURN 'deleted'; END IF;
 IF u.status<>'draft' THEN RETURN 'locked'; END IF;
 IF u.posted_at IS NOT NULL OR u.posted_batch_id IS NOT NULL OR u.approved_digest IS NOT NULL
  OR u.funding_cents<>'{"standard":0,"h":0}'::jsonb OR u.reserved_cents<>'{"standard":0,"h":0}'::jsonb THEN RETURN 'payroll'; END IF;
 IF EXISTS(SELECT 1 FROM reward_decision WHERE tenant_id=u.tenant_id AND unit_id=u.id) THEN RETURN 'decisions'; END IF;
 IF EXISTS(SELECT 1 FROM reward_unit WHERE tenant_id=u.tenant_id AND parent_unit_id=u.id) THEN RETURN 'children'; END IF;
 IF EXISTS(SELECT 1 FROM domain_event WHERE tenant_id=u.tenant_id AND aggregate_type='reward-unit' AND aggregate_id=u.id
  AND event_type IN ('reward-unit.recommendation-updated','reward-unit.facts-imported','reward-unit.senior-membership-updated','reward-unit.onehr-results-imported','reward-unit.lump-updated')) THEN RETURN 'recommendations'; END IF;
 IF EXISTS(SELECT 1 FROM reward_entry WHERE tenant_id=u.tenant_id AND unit_id=u.id AND (
  enacted_compensation_id IS NOT NULL OR source ? 'onehrFactImport'
  OR facts <> '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb
  OR recommendation <> '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb
 )) THEN RETURN 'recommendations'; END IF;
 -- Fail closed for future relational consumers rather than assuming the original three tables
 -- remain the complete dependency graph. Known owned rows are retained by the tombstone.
 FOR link IN SELECT c.oid,c.conrelid,c.conkey,c.confkey FROM pg_constraint c
  WHERE c.contype='f' AND c.confrelid='public.reward_unit'::regclass
   AND c.conrelid NOT IN ('public.reward_member'::regclass,'public.reward_entry'::regclass,'public.reward_decision'::regclass,'public.reward_unit'::regclass)
 LOOP
  SELECT string_agg(format('to_jsonb(t)->%L = to_jsonb($1)->%L',a.attname,b.attname),' AND ' ORDER BY k.n) INTO predicate
   FROM generate_subscripts(link.conkey,1) k(n)
   JOIN pg_attribute a ON a.attrelid=link.conrelid AND a.attnum=link.conkey[k.n]
   JOIN pg_attribute b ON b.attrelid='public.reward_unit'::regclass AND b.attnum=link.confkey[k.n];
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s t WHERE %s)',link.conrelid::regclass,predicate) INTO used USING u;
  IF used THEN RETURN 'external'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.reward_deletion_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_deletion_reason(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid; u reward_unit;
BEGIN
 IF TG_TABLE_NAME='reward_unit' THEN
  IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Deleted reward history is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.deleted_at IS NOT NULL THEN
   IF TG_OP<>'UPDATE' OR NEW.deleted_by IS DISTINCT FROM app.current_user_id()
    OR NOT app.reward_admin(NEW.company_id) OR app.reward_deletion_reason(NEW.id) IS NOT NULL
    OR NEW.revision<>OLD.revision+1
    OR (to_jsonb(NEW)-ARRAY['deleted_at','deleted_by','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['deleted_at','deleted_by','revision','updated_at'])
    THEN RAISE EXCEPTION 'Only an unchanged unused draft can be removed' USING ERRCODE='23514'; END IF;
  END IF;
  target:=NEW.parent_unit_id;
 ELSE
  -- Child identity belongs to one review for life; a tombstone cannot lose retained evidence
  -- through UPDATE to a live destination whose NEW-row check alone would otherwise pass.
  IF TG_OP='UPDATE' AND NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
   RAISE EXCEPTION 'Reward evidence cannot move between reviews' USING ERRCODE='23514';
  END IF;
  target:=CASE WHEN TG_OP='DELETE' THEN OLD.unit_id ELSE NEW.unit_id END;
 END IF;
 IF target IS NOT NULL THEN
  SELECT * INTO u FROM reward_unit WHERE id=target FOR UPDATE;
  IF u.id IS NULL OR u.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Reward review is unavailable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION app.reward_lifecycle_guard() FROM PUBLIC;
CREATE TRIGGER reward_unit_lifecycle_guard BEFORE INSERT OR UPDATE ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_lifecycle_guard();
CREATE TRIGGER reward_entry_lifecycle_guard BEFORE INSERT OR UPDATE ON reward_entry FOR EACH ROW EXECUTE FUNCTION app.reward_lifecycle_guard();
CREATE TRIGGER reward_member_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON reward_member FOR EACH ROW EXECUTE FUNCTION app.reward_lifecycle_guard();
CREATE TRIGGER reward_decision_lifecycle_guard BEFORE INSERT ON reward_decision FOR EACH ROW EXECUTE FUNCTION app.reward_lifecycle_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_notification_recipients(wanted_unit uuid, wanted_stage text) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT DISTINCT e.id FROM reward_unit r JOIN reward_member m ON m.unit_id=r.id AND m.tenant_id=r.tenant_id
 JOIN app_user u ON u.id=m.user_id AND u.tenant_id=r.tenant_id
 JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=r.tenant_id AND e.company_id=r.company_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.status=wanted_stage AND r.deleted_at IS NULL
 AND app.is_admin() AND (app.current_user_id() IS NULL OR app.reward_admin(r.company_id))
 AND m.role=CASE WHEN wanted_stage='approved' THEN 'payroll' WHEN wanted_stage='draft' THEN CASE WHEN r.offcycle->>'bgOrigin'='true' THEN 'bg' ELSE 'bu' END ELSE wanted_stage END
 AND wanted_stage IN ('draft','bg','gr','ctro','ec','approved') AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.terminated_on IS NULL
$$;
