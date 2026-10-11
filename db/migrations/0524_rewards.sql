-- Reward Desk: unit-scoped access, immutable salary snapshots, revisioned human approvals.
CREATE TABLE reward_cycle (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160), year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),
 created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id)
);
--> statement-breakpoint
CREATE TABLE reward_unit (
 kind text NOT NULL DEFAULT 'annual' CHECK(kind IN ('annual','adhoc','midyear')), parent_unit_id uuid,
 created_by uuid NOT NULL REFERENCES app_user(id), offcycle jsonb,
 funding_cents jsonb NOT NULL DEFAULT '{"standard":0,"h":0}', reserved_cents jsonb NOT NULL DEFAULT '{"standard":0,"h":0}',
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 cycle_id uuid NOT NULL, company_id uuid NOT NULL REFERENCES company(id), business_unit_id uuid NOT NULL REFERENCES business_unit(id),
 policy jsonb NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), snapshot_date date NOT NULL,
 approved_digest text, posted_batch_id uuid REFERENCES payroll_batch(id), posted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,cycle_id) REFERENCES reward_cycle(tenant_id,id), UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,parent_unit_id) REFERENCES reward_unit(tenant_id,id), CHECK((kind='annual' AND parent_unit_id IS NULL AND offcycle IS NULL) OR (kind<>'annual' AND parent_unit_id IS NOT NULL AND offcycle IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE reward_member (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), unit_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES app_user(id), role text NOT NULL CHECK(role IN ('bu','bg','gr','ctro','ec','pbp','payroll')),
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,unit_id) REFERENCES reward_unit(tenant_id,id), UNIQUE(unit_id,user_id,role)
);
--> statement-breakpoint
CREATE TABLE reward_entry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), unit_id uuid NOT NULL,
 employment_id uuid NOT NULL REFERENCES employment(id), source jsonb NOT NULL, facts jsonb NOT NULL, recommendation jsonb NOT NULL,
 enacted_compensation_id uuid REFERENCES compensation(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,unit_id) REFERENCES reward_unit(tenant_id,id), UNIQUE(unit_id,employment_id)
);
--> statement-breakpoint
CREATE TABLE reward_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), unit_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES app_user(id), revision integer NOT NULL, action text NOT NULL,
 from_stage text NOT NULL, to_stage text NOT NULL, reason text NOT NULL DEFAULT '', digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,unit_id) REFERENCES reward_unit(tenant_id,id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX reward_annual_unit_unique ON reward_unit(cycle_id,company_id,business_unit_id) WHERE kind='annual';
CREATE INDEX reward_unit_parent_idx ON reward_unit(parent_unit_id);
CREATE INDEX reward_unit_tenant_idx ON reward_unit(tenant_id,company_id,cycle_id);
CREATE INDEX reward_member_user_idx ON reward_member(tenant_id,user_id,unit_id);
CREATE INDEX reward_entry_unit_idx ON reward_entry(unit_id);
CREATE INDEX reward_decision_unit_idx ON reward_decision(unit_id,created_at);
--> statement-breakpoint
-- Fresh identity and grants: old sessions cannot restore a revoked administrator role.
CREATE FUNCTION app.reward_admin(requested_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  AND r.role::text IN ('hr_admin','super_admin') AND app.has_role_for(r.role::text,requested_company)
  AND (r.company_id IS NULL OR r.company_id=requested_company OR app.is_company_descendant(requested_company,r.company_id)))
$$;
--> statement-breakpoint
CREATE FUNCTION app.reward_roles(wanted_unit uuid) RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT m.role FROM reward_member m JOIN app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
 WHERE m.unit_id=wanted_unit AND m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
$$;
--> statement-breakpoint
CREATE FUNCTION app.reward_access(wanted_unit uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM reward_unit r WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id()
 AND (app.reward_admin(r.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(r.id))))
$$;
--> statement-breakpoint
CREATE FUNCTION app.reward_validate_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='reward_unit' THEN
  IF NOT EXISTS(SELECT 1 FROM company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   OR NOT EXISTS(SELECT 1 FROM business_unit b WHERE b.id=NEW.business_unit_id AND b.tenant_id=NEW.tenant_id AND (b.company_id=NEW.company_id OR b.is_global))
   THEN RAISE EXCEPTION 'Invalid reward company or business unit'; END IF;
  IF NEW.parent_unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_unit p WHERE p.id=NEW.parent_unit_id AND p.tenant_id=NEW.tenant_id AND p.company_id=NEW.company_id AND p.business_unit_id=NEW.business_unit_id AND p.kind='annual' AND p.status='posted') THEN RAISE EXCEPTION 'Invalid annual reward funding source'; END IF;
 ELSIF TG_TABLE_NAME='reward_member' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=NEW.user_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL)
   THEN RAISE EXCEPTION 'Invalid reward member'; END IF;
 ELSIF TG_TABLE_NAME='reward_entry' THEN
  IF NOT EXISTS(SELECT 1 FROM employment e JOIN reward_unit r ON r.id=NEW.unit_id AND r.tenant_id=e.tenant_id
   WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=r.company_id)
   OR NEW.source->>'employmentId'<>NEW.employment_id::text THEN RAISE EXCEPTION 'Invalid reward employee'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER reward_unit_links BEFORE INSERT OR UPDATE ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_validate_links();
CREATE TRIGGER reward_member_links BEFORE INSERT OR UPDATE ON reward_member FOR EACH ROW EXECUTE FUNCTION app.reward_validate_links();
CREATE TRIGGER reward_entry_links BEFORE INSERT OR UPDATE ON reward_entry FOR EACH ROW EXECUTE FUNCTION app.reward_validate_links();
--> statement-breakpoint
ALTER TABLE reward_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_unit ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_decision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reward_cycle_read ON reward_cycle FOR SELECT USING(tenant_id=app.current_tenant_id() AND (created_by=app.current_user_id() OR EXISTS(SELECT 1 FROM reward_unit r WHERE r.cycle_id=reward_cycle.id AND app.reward_access(r.id))));
CREATE POLICY reward_cycle_insert ON reward_cycle FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.is_admin());
CREATE POLICY reward_unit_read ON reward_unit FOR SELECT USING(tenant_id=app.current_tenant_id() AND (created_by=app.current_user_id() OR app.reward_admin(company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(id))));
CREATE POLICY reward_unit_insert ON reward_unit FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND (app.reward_admin(company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(parent_unit_id) r WHERE r IN ('bu','bg','gr'))));
CREATE POLICY reward_unit_update ON reward_unit FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.reward_admin(company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(id) r WHERE r<>'pbp'))) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_access(id));
CREATE POLICY reward_member_read ON reward_member FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
CREATE POLICY reward_member_write ON reward_member FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit r WHERE r.id=unit_id AND (app.reward_admin(r.company_id) OR (r.created_by=app.current_user_id() AND r.status='draft' AND r.parent_unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.reward_roles(r.parent_unit_id) pr WHERE pr IN ('bu','bg','gr')))))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit r WHERE r.id=unit_id AND (app.reward_admin(r.company_id) OR (r.created_by=app.current_user_id() AND r.status='draft' AND r.parent_unit_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.reward_roles(r.parent_unit_id) pr WHERE pr IN ('bu','bg','gr'))))));
-- The application service projects confidential and own-person rows out before serialization.
-- Unit-level readers need all inputs internally to validate shared budgets, including hidden cases.
CREATE POLICY reward_entry_read ON reward_entry FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id)));
CREATE POLICY reward_entry_insert ON reward_entry FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id) r WHERE r IN ('gr','bu','bg')));
CREATE POLICY reward_entry_update ON reward_entry FOR UPDATE USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id) r WHERE r<>'pbp')) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id)));
CREATE POLICY reward_decision_read ON reward_decision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
CREATE POLICY reward_decision_insert ON reward_decision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id) r WHERE r<>'pbp'));
--> statement-breakpoint
GRANT SELECT,INSERT ON reward_cycle TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON reward_unit,reward_entry TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON reward_member TO ai_hr_app;
GRANT SELECT,INSERT ON reward_decision TO ai_hr_app;
REVOKE ALL ON FUNCTION app.reward_roles(uuid),app.reward_access(uuid),app.reward_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_roles(uuid),app.reward_access(uuid),app.reward_admin(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Only aggregate funding leaves this function. It never reveals a sibling request's people or pay.
-- Taking the annual parent lock serializes submissions across every child review of that budget.
CREATE FUNCTION app.reward_funding(wanted_unit uuid, lock_parent boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE child reward_unit; parent reward_unit; committed_standard bigint; committed_h bigint; duplicate_open boolean;
BEGIN
 SELECT * INTO child FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id();
 IF child.id IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(child.id)) THEN RAISE EXCEPTION 'Reward funding access denied'; END IF;
 IF child.parent_unit_id IS NULL THEN RETURN jsonb_build_object('standard',0,'h',0,'duplicate',false); END IF;
 IF lock_parent THEN
  SELECT * INTO parent FROM reward_unit WHERE id=child.parent_unit_id AND tenant_id=child.tenant_id FOR UPDATE;
 ELSE SELECT * INTO parent FROM reward_unit WHERE id=child.parent_unit_id AND tenant_id=child.tenant_id; END IF;
 IF parent.id IS NULL OR parent.status<>'posted' OR parent.kind<>'annual' OR parent.company_id<>child.company_id OR parent.business_unit_id<>child.business_unit_id THEN RAISE EXCEPTION 'Invalid annual funding source'; END IF;
 SELECT coalesce(sum((reserved_cents->>'standard')::bigint),0),coalesce(sum((reserved_cents->>'h')::bigint),0)
 INTO committed_standard,committed_h FROM reward_unit
 WHERE tenant_id=child.tenant_id AND parent_unit_id=parent.id AND id<>child.id AND status NOT IN ('draft','rejected','withdrawn');
 SELECT EXISTS(SELECT 1 FROM reward_entry own_entry JOIN reward_entry other_entry ON own_entry.employment_id=other_entry.employment_id
 JOIN reward_unit other_unit ON other_unit.id=other_entry.unit_id
 WHERE own_entry.unit_id=child.id AND other_unit.parent_unit_id=parent.id AND other_unit.id<>child.id
 AND other_unit.tenant_id=child.tenant_id AND other_unit.status IN ('bg','gr','ctro','ec','approved')) INTO duplicate_open;
 RETURN jsonb_build_object('standard',greatest(0,(parent.funding_cents->>'standard')::bigint-committed_standard),'h',greatest(0,(parent.funding_cents->>'h')::bigint-committed_h),'duplicate',duplicate_open);
END $$;
REVOKE ALL ON FUNCTION app.reward_funding(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_funding(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_current_source(wanted_unit uuid, wanted_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('compensationId',c.id,'basicCents',round(c.basic_salary*100),'currency',c.currency,'payMode',c.pay_mode,
 'gradeId',e.grade_id,'grade',regexp_replace(coalesce(g.code,''),'^JG\s*','','i'),'lastPayChange',c.valid_from,
 'notice',e.tender_resignation_date IS NOT NULL OR e.resignation_date IS NOT NULL,'confirmedOn',e.confirmation_date)
 FROM reward_entry r JOIN reward_unit u ON u.id=r.unit_id AND u.tenant_id=r.tenant_id
 JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id AND e.company_id=u.company_id
 JOIN compensation c ON c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_to IS NULL AND c.superseded_at IS NULL
 LEFT JOIN job_grade g ON g.id=e.grade_id
 WHERE r.unit_id=wanted_unit AND r.employment_id=wanted_employment AND r.tenant_id=app.current_tenant_id()
 AND e.terminated_on IS NULL AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) role WHERE role IN ('bu','bg','gr'))
$$;
REVOKE ALL ON FUNCTION app.reward_current_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_current_source(uuid,uuid) TO ai_hr_app;
