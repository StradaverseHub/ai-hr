-- Immutable history imports. Corrections append payslips and revisions; closed snapshots never change.
CREATE TABLE payroll_history_import_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 created_by uuid NOT NULL REFERENCES app_user(id), operation_key uuid NOT NULL,
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 255), mime_type text NOT NULL,
 source_hash text NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'), source_content bytea NOT NULL CHECK(octet_length(source_content)<=10485760),
 company_ids uuid[] NOT NULL, plan jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_hash=encode(sha256(source_content),'hex')),
 CHECK((plan->>'sourceHash') IS NOT DISTINCT FROM source_hash),
 UNIQUE(tenant_id,created_by,operation_key)
);
CREATE INDEX payroll_history_attempt_created_idx ON payroll_history_import_attempt(tenant_id,created_at);
--> statement-breakpoint
ALTER TABLE payroll_batch ADD COLUMN history_import_attempt_id uuid REFERENCES payroll_history_import_attempt(id);
ALTER TABLE payroll_batch ADD COLUMN history_import_cycle_name text;
--> statement-breakpoint
CREATE TABLE payroll_history_import_record (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id),employment_id uuid NOT NULL REFERENCES employment(id),
 period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),cycle_id uuid NOT NULL REFERENCES payroll_cycle(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,company_id,employment_id,period,cycle_id)
);
CREATE TABLE payroll_history_import_snapshot (
 id uuid PRIMARY KEY REFERENCES payslip(id),tenant_id uuid NOT NULL REFERENCES tenant(id),record_id uuid NOT NULL REFERENCES payroll_history_import_record(id),
 value_hash text NOT NULL CHECK(value_hash ~ '^[0-9a-f]{64}$'),"values" jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payroll_history_import_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),record_id uuid NOT NULL REFERENCES payroll_history_import_record(id),
 ordinal integer NOT NULL CHECK(ordinal>0),attempt_id uuid NOT NULL REFERENCES payroll_history_import_attempt(id),snapshot_id uuid REFERENCES payroll_history_import_snapshot(id),
 previous_revision_id uuid REFERENCES payroll_history_import_revision(id),kind text NOT NULL CHECK(kind IN ('import','correction','revert')),
 cycle_name text NOT NULL CHECK(length(cycle_name) BETWEEN 1 AND 300),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(record_id,ordinal),CHECK(snapshot_id IS NOT NULL OR kind='revert')
);
CREATE INDEX payroll_history_revision_attempt_idx ON payroll_history_import_revision(tenant_id,attempt_id);
CREATE TABLE payroll_history_import_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),attempt_id uuid NOT NULL REFERENCES payroll_history_import_attempt(id),
 kind text NOT NULL CHECK(kind IN ('confirmed','failed','reverted','revert_failed')),actor_id uuid NOT NULL REFERENCES app_user(id),
 changes jsonb NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payroll_history_confirm_once_uq ON payroll_history_import_event(attempt_id) WHERE kind='confirmed';
CREATE UNIQUE INDEX payroll_history_revert_once_uq ON payroll_history_import_event(attempt_id) WHERE kind='reverted';
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_attempt_access(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a
  WHERE a.id=subject AND a.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
  AND (a.created_by=app.current_user_id() OR cardinality(a.company_ids)>0)
  AND NOT EXISTS(SELECT 1 FROM unnest(a.company_ids) c WHERE NOT app.can_admin_payroll_for(c)))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_attempt_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_attempt_access(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Only names of actors already recorded in an accessible attempt; no personnel directory access.
CREATE FUNCTION app.payroll_history_actor_label(subject uuid,actor uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT nullif(btrim(p.full_name),'') FROM public.app_user u JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=actor AND u.tenant_id=app.current_tenant_id() AND app.payroll_history_attempt_access(subject)
 AND (EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a WHERE a.id=subject AND a.tenant_id=u.tenant_id AND a.created_by=u.id)
  OR EXISTS(SELECT 1 FROM public.payroll_history_import_event e WHERE e.attempt_id=subject AND e.tenant_id=u.tenant_id AND e.actor_id=u.id))
$$;
REVOKE ALL ON FUNCTION app.payroll_history_actor_label(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_actor_label(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE payroll_history_import_attempt ENABLE ROW LEVEL SECURITY;
-- Inline the new row for INSERT RETURNING. A STABLE function looking up this table cannot
-- observe a row inserted by its own command; the helper remains appropriate for child rows.
CREATE POLICY payroll_history_attempt_read ON payroll_history_import_attempt FOR SELECT USING(
 tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (created_by=app.current_user_id() OR cardinality(company_ids)>0)
 AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.can_admin_payroll_for(c)));
CREATE POLICY payroll_history_attempt_insert ON payroll_history_import_attempt FOR INSERT WITH CHECK(
 tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current()
 AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.can_admin_payroll_for(c)));
ALTER TABLE payroll_history_import_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_history_record_read ON payroll_history_import_record FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id));
CREATE POLICY payroll_history_record_insert ON payroll_history_import_record FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id));
ALTER TABLE payroll_history_import_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_history_snapshot_read ON payroll_history_import_snapshot FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM payroll_history_import_record r WHERE r.id=record_id AND r.tenant_id=payroll_history_import_snapshot.tenant_id));
CREATE POLICY payroll_history_snapshot_insert ON payroll_history_import_snapshot FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM payroll_history_import_record r WHERE r.id=record_id AND r.tenant_id=payroll_history_import_snapshot.tenant_id));
ALTER TABLE payroll_history_import_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_history_revision_read ON payroll_history_import_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM payroll_history_import_record r WHERE r.id=record_id AND r.tenant_id=payroll_history_import_revision.tenant_id));
CREATE POLICY payroll_history_revision_insert ON payroll_history_import_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.payroll_history_attempt_access(attempt_id) AND EXISTS(SELECT 1 FROM payroll_history_import_record r WHERE r.id=record_id AND r.tenant_id=payroll_history_import_revision.tenant_id));
ALTER TABLE payroll_history_import_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_history_event_read ON payroll_history_import_event FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.payroll_history_attempt_access(attempt_id));
CREATE POLICY payroll_history_event_insert ON payroll_history_import_event FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.payroll_history_attempt_access(attempt_id));
GRANT SELECT,INSERT ON payroll_history_import_attempt,payroll_history_import_record,payroll_history_import_snapshot,payroll_history_import_revision,payroll_history_import_event TO ai_hr_app;
-- SELECT FOR UPDATE is required for transactional compare-and-swap; update triggers below still forbid mutations.
GRANT UPDATE(id) ON payroll_history_import_attempt,payroll_history_import_record TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Payroll import provenance is immutable; append a correction or revert revision'; END $$;
CREATE TRIGGER payroll_history_attempt_immutable BEFORE UPDATE OR DELETE ON payroll_history_import_attempt FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
CREATE TRIGGER payroll_history_record_immutable BEFORE UPDATE OR DELETE ON payroll_history_import_record FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
CREATE TRIGGER payroll_history_snapshot_immutable BEFORE UPDATE OR DELETE ON payroll_history_import_snapshot FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
CREATE TRIGGER payroll_history_revision_immutable BEFORE UPDATE OR DELETE ON payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
CREATE TRIGGER payroll_history_event_immutable BEFORE UPDATE OR DELETE ON payroll_history_import_event FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_bind_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.payroll_cycle c ON c.id=NEW.cycle_id
  WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id AND c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id)
 THEN RAISE EXCEPTION 'Payroll import record identity mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_history_record_binding BEFORE INSERT ON payroll_history_import_record FOR EACH ROW EXECUTE FUNCTION app.payroll_history_bind_record();
CREATE FUNCTION app.payroll_history_bind_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r JOIN public.payslip p ON p.id=NEW.id
  JOIN public.payroll_batch b ON b.id=p.batch_id
  WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND p.tenant_id=r.tenant_id AND b.tenant_id=r.tenant_id
  AND p.employment_id=r.employment_id AND b.company_id=r.company_id AND b.pay_period=r.period
  AND b.payroll_cycle_id=r.cycle_id AND b.history_import_attempt_id IS NOT NULL AND b.status='closed'
  AND NEW."values"=jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text)
  AND EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a, jsonb_array_elements(a.plan->'rows') planned
   WHERE a.id=b.history_import_attempt_id AND a.tenant_id=r.tenant_id
   AND planned->>'companyId'=r.company_id::text AND planned->>'employmentId'=r.employment_id::text
   AND planned->>'period'=r.period AND planned->>'cycleId'=r.cycle_id::text
   AND planned->>'operation' IN ('create','replace') AND planned->'values'=NEW."values" AND planned->>'valueHash'=NEW.value_hash))
 THEN RAISE EXCEPTION 'Payroll import snapshot identity mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_history_snapshot_binding BEFORE INSERT ON payroll_history_import_snapshot FOR EACH ROW EXECUTE FUNCTION app.payroll_history_bind_snapshot();
CREATE FUNCTION app.payroll_history_bind_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE r public.payroll_history_import_record;previous public.payroll_history_import_revision;
BEGIN
 SELECT * INTO r FROM public.payroll_history_import_record WHERE id=NEW.record_id FOR UPDATE;
 IF r.id IS NULL OR r.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'Payroll import revision identity mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.payroll_history_import_attempt a WHERE a.id=NEW.attempt_id AND a.tenant_id=r.tenant_id AND r.company_id=ANY(a.company_ids))
 THEN RAISE EXCEPTION 'Payroll import attempt identity mismatch'; END IF;
 IF NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s WHERE s.id=NEW.snapshot_id AND s.record_id=r.id AND s.tenant_id=r.tenant_id)
 THEN RAISE EXCEPTION 'Payroll import snapshot belongs to another record'; END IF;
 SELECT * INTO previous FROM public.payroll_history_import_revision WHERE record_id=r.id ORDER BY ordinal DESC LIMIT 1;
 IF NEW.ordinal<>coalesce(previous.ordinal,0)+1 OR NEW.previous_revision_id IS DISTINCT FROM previous.id
 THEN RAISE EXCEPTION 'Payroll import record changed; validate a new attempt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_history_revision_binding BEFORE INSERT ON payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_bind_revision();
--> statement-breakpoint
-- One effective snapshot is enforced for EVERY ordinary application reader, including raw SQL/YTD
-- and statutory owners. The function reads provenance only; it grants no payroll data access.
CREATE FUNCTION app.payroll_history_effective(subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot s
  WHERE s.id=subject AND s.tenant_id=app.current_tenant_id()
  AND (SELECT r.snapshot_id FROM public.payroll_history_import_revision r WHERE r.record_id=s.record_id ORDER BY r.ordinal DESC LIMIT 1) IS DISTINCT FROM subject)
$$;
REVOKE ALL ON FUNCTION app.payroll_history_effective(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_effective(uuid) TO ai_hr_app;
CREATE POLICY payroll_history_effective_only ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.payroll_history_effective(id));
--> statement-breakpoint
-- A specialized unlock flag cannot reopen an imported snapshot through the ordinary payroll path.
CREATE FUNCTION app.payroll_history_guard_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.history_import_attempt_id IS NOT NULL AND OLD.status='closed' THEN RAISE EXCEPTION 'Imported payroll history requires an append-only correction'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER payroll_history_batch_immutable BEFORE UPDATE OR DELETE ON payroll_batch FOR EACH ROW EXECUTE FUNCTION app.payroll_history_guard_batch();
--> statement-breakpoint
-- Batch summaries remain derived; the stored historical counters are immutable audit snapshots.
CREATE FUNCTION app.payroll_history_batch_totals(subject uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('employeeCount',count(*),'gross',coalesce(sum(gross_pay),0),'net',coalesce(sum(net_pay),0),
 'epfEmployee',coalesce(sum((statutory->>'epfEmployee')::numeric),0),'epfEmployer',coalesce(sum((statutory->>'epfEmployer')::numeric),0),
 'socsoEmployee',coalesce(sum((statutory->>'socsoEmployee')::numeric),0),'socsoEmployer',coalesce(sum((statutory->>'socsoEmployer')::numeric),0),
 'eisEmployee',coalesce(sum((statutory->>'eisEmployee')::numeric),0),'eisEmployer',coalesce(sum((statutory->>'eisEmployer')::numeric),0),'pcb',coalesce(sum((statutory->>'pcb')::numeric),0))
 FROM public.payslip WHERE batch_id=subject AND app.payroll_history_effective(id)
$$;
REVOKE ALL ON FUNCTION app.payroll_history_batch_totals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_history_batch_totals(uuid) TO ai_hr_app;
DO $$ DECLARE columns text; BEGIN
 SELECT string_agg(CASE a.attname
  WHEN 'totals' THEN 'CASE WHEN b.history_import_attempt_id IS NULL THEN b.totals ELSE app.payroll_history_batch_totals(b.id) END AS totals'
  WHEN 'employee_count' THEN 'CASE WHEN b.history_import_attempt_id IS NULL THEN b.employee_count ELSE (app.payroll_history_batch_totals(b.id)->>''employeeCount'')::integer END AS employee_count'
  ELSE format('b.%I',a.attname) END,',' ORDER BY a.attnum) INTO columns
 FROM pg_attribute a WHERE a.attrelid='public.payroll_batch'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 EXECUTE 'CREATE VIEW public.payroll_history_effective_batch WITH (security_invoker=true) AS SELECT '||columns||' FROM public.payroll_batch b';
END $$;
GRANT SELECT ON payroll_history_effective_batch TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY payroll_history_attempt_lock ON payroll_history_import_attempt FOR UPDATE USING(app.payroll_history_attempt_access(id)) WITH CHECK(false);
CREATE POLICY payroll_history_record_lock ON payroll_history_import_record FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id)) WITH CHECK(false);
