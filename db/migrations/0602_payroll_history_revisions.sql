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

--> statement-breakpoint
-- Existing SECURITY DEFINER metadata readers bypass payslip RLS. Apply the same effective-version
-- rule inside their canonical owners; ordinary payroll behavior and authorization stay unchanged.
CREATE OR REPLACE FUNCTION app.my_ea_source_options()
RETURNS TABLE(employment_id uuid, employee_code text, company_id uuid, company text,
 country text, year text, available boolean, is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,e.employee_code,c.id,c.legal_name,c.country,left(b.pay_period,4),
   bool_and(b.status::text='closed' AND (b.released_at IS NULL OR b.released_at<=now())
     AND b.pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
   AND NOT EXISTS(SELECT 1 FROM public.payslip malformed JOIN public.payroll_batch bad ON bad.id=malformed.batch_id AND bad.tenant_id=malformed.tenant_id
     WHERE app.payroll_history_effective(malformed.id) AND malformed.employment_id=e.id AND malformed.tenant_id=e.tenant_id AND bad.company_id=c.id AND bad.pay_period !~ '^[0-9]{4}'),e.company_id=c.id
 FROM public.app_user u
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN public.payslip p ON p.employment_id=e.id AND p.tenant_id=e.tenant_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=e.tenant_id
 JOIN public.company c ON c.id=b.company_id AND c.tenant_id=e.tenant_id
 WHERE app.principal_snapshot_current() AND u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND app.payroll_history_effective(p.id) AND b.pay_period ~ '^[0-9]{4}'
 GROUP BY e.id,e.tenant_id,e.employee_code,c.id,c.legal_name,c.country,left(b.pay_period,4),e.company_id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ea_signatory(p_employment_id uuid, p_company_id uuid, p_year text)
RETURNS TABLE(officer_name text, officer_position text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT sp.full_name, title.title
  FROM public.employment subject
  JOIN public.company co ON co.id = p_company_id AND co.tenant_id = subject.tenant_id
  JOIN public.company_statutory_authority auth
    ON auth.company_id = co.id AND auth.tenant_id = co.tenant_id AND auth.authority = 'lhdn'
  JOIN public.person sp ON sp.id = auth.signatory_person_id AND sp.tenant_id = co.tenant_id
  LEFT JOIN LATERAL (
    SELECT pos.title
    FROM public.employment se
    JOIN public.assignment a ON a.employment_id = se.id AND a.tenant_id = se.tenant_id
    JOIN public.position pos ON pos.id = a.position_id AND pos.tenant_id = se.tenant_id
    WHERE se.person_id = sp.id AND se.company_id = co.id AND se.tenant_id = co.tenant_id
      AND se.hired_on <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (se.terminated_on IS NULL OR se.terminated_on >= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND a.superseded_at IS NULL
      AND a.valid_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (a.valid_to IS NULL OR a.valid_to > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND COALESCE(a.company_id, se.company_id) = co.id
    ORDER BY a.valid_from DESC, se.hired_on DESC, a.id
    LIMIT 1
  ) title ON true
  WHERE subject.id = p_employment_id AND subject.tenant_id = app.current_tenant_id()
    AND p_year ~ '^[0-9]{4}$'
    AND (
      EXISTS (SELECT 1 FROM public.app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = subject.tenant_id AND u.person_id = subject.person_id)
      OR (app.can_admin_payroll_for(subject.company_id) AND app.can_admin_payroll_for(co.id))
    )
    AND (subject.company_id = co.id OR EXISTS (
      SELECT 1 FROM public.payslip ps
      JOIN public.payroll_batch pb ON pb.id = ps.batch_id AND pb.tenant_id = ps.tenant_id
      WHERE app.payroll_history_effective(ps.id) AND ps.employment_id = subject.id AND ps.tenant_id = subject.tenant_id
        AND pb.company_id = co.id AND pb.pay_period LIKE p_year || '-%'
    ));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_payroll_protection_rows(subject_id uuid)
RETURNS TABLE(batch_id uuid, status text, pay_period text, policy_config jsonb, attendance_cutoff_day integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject employment;
BEGIN
 SELECT * INTO STRICT subject FROM employment WHERE id=subject_id AND tenant_id=app.current_tenant_id();
 -- Include former assignment companies even before a draft has generated its first payslip.
 -- Membership also covers older runs whose original placement predates dated entity history.
 PERFORM b.id FROM payroll_batch b
 WHERE b.tenant_id=subject.tenant_id AND (
  b.company_id=subject.company_id
  OR EXISTS (SELECT 1 FROM assignment a LEFT JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id
             WHERE a.tenant_id=subject.tenant_id AND a.employment_id=subject.id AND coalesce(a.company_id,d.company_id)=b.company_id)
  OR EXISTS (SELECT 1 FROM payslip ps WHERE app.payroll_history_effective(ps.id) AND ps.tenant_id=subject.tenant_id AND ps.batch_id=b.id AND ps.employment_id=subject.id)
 ) ORDER BY b.id FOR UPDATE;
 RETURN QUERY
 SELECT b.id,b.status::text,b.pay_period::text,
        CASE WHEN policy.status='active' THEN jsonb_build_object('cutOff',policy.config->'cutOff','frequency',policy.config->'frequency') ELSE NULL END,
        cfg.attendance_cut_off_day
 FROM payroll_batch b
 LEFT JOIN company_payroll_config cfg ON cfg.company_id=b.company_id AND cfg.tenant_id=subject.tenant_id
 -- A newly assigned destination-company policy cannot change an earlier employer's cut-off.
 LEFT JOIN payroll_policy assigned ON assigned.id=subject.payroll_policy_id AND assigned.tenant_id=subject.tenant_id AND assigned.company_id=b.company_id
 LEFT JOIN payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=subject.tenant_id AND policy.company_id=b.company_id
 WHERE b.tenant_id=subject.tenant_id AND b.status IN ('processed','closed')
   AND EXISTS (SELECT 1 FROM payslip ps WHERE app.payroll_history_effective(ps.id) AND ps.batch_id=b.id AND ps.employment_id=subject.id AND ps.tenant_id=subject.tenant_id)
 ORDER BY b.id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.leave_payroll_coverage(request_ids uuid[])
RETURNS TABLE(request_id uuid,employment_id uuid,batch_id uuid,company_id uuid,status text,pay_period text,
 policy_config jsonb,unpaid_leave_cutoff_day integer,coverage_from date,coverage_to date,segment jsonb,
 salary_cutoff_day integer,run_policy_config jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF cardinality(request_ids) IS NULL OR cardinality(request_ids)>10000 OR EXISTS (
   SELECT 1 FROM unnest(request_ids) wanted(id)
   LEFT JOIN leave_request lr ON lr.id=wanted.id AND lr.tenant_id=app.current_tenant_id()
   WHERE lr.id IS NULL OR NOT (app.can_see_employment(lr.employment_id) OR app.can_decide_via_delegation(lr.employment_id))
 ) OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
   RAISE EXCEPTION 'Leave visibility required';
 END IF;
 -- NOWAIT is intentional: a leave transaction may already hold the audit-chain lock.
 -- Waiting on a payroll writer that next appends an event would invert that lock order.
 -- Refuse atomically and let the caller retry; never leave a decided request with stale pay.
 PERFORM b.id FROM payroll_batch b WHERE b.tenant_id=app.current_tenant_id()
 AND b.pay_period >= (SELECT to_char(min(lr.start_date),'YYYY-MM') FROM leave_request lr WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id)
 AND b.pay_period <= (SELECT to_char(max(lr.end_date)+interval '1 month','YYYY-MM') FROM leave_request lr WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id)
 AND EXISTS (
  SELECT 1 FROM leave_request lr JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
  WHERE lr.id=ANY(request_ids) AND lr.tenant_id=b.tenant_id AND (
   b.company_id=e.company_id OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=b.company_id)
   OR EXISTS(SELECT 1 FROM payslip ps WHERE app.payroll_history_effective(ps.id) AND ps.batch_id=b.id AND ps.employment_id=e.id AND ps.tenant_id=e.tenant_id)
  )
 ) ORDER BY b.id FOR UPDATE NOWAIT;
 RETURN QUERY
 SELECT lr.id,lr.employment_id,b.id,b.company_id,b.status::text,b.pay_period::text,
   CASE WHEN policy.status='active' THEN jsonb_build_object('cutOff',policy.config->'cutOff','frequency',policy.config->'frequency',
     'leave',jsonb_build_object('deductAbsentDays',policy.config->'leave'->'deductAbsentDays')) ELSE NULL END,
   cfg.unpaid_leave_cut_off_day,ps.coverage_from,ps.coverage_to,jsonb_build_object('segment',jsonb_build_object(
    'companyId',ps.statutory->'segment'->'companyId','from',ps.statutory->'segment'->'from','to',ps.statutory->'segment'->'to')),
   cfg.cut_off_day,CASE WHEN run_policy.status='active' THEN jsonb_build_object('cutOff',run_policy.config->'cutOff','frequency',run_policy.config->'frequency') ELSE NULL END
 FROM leave_request lr JOIN payslip ps ON ps.employment_id=lr.employment_id AND ps.tenant_id=lr.tenant_id
 JOIN employment e ON e.id=lr.employment_id AND e.tenant_id=lr.tenant_id
 JOIN payroll_batch b ON b.id=ps.batch_id AND b.tenant_id=lr.tenant_id
 LEFT JOIN company_payroll_config cfg ON cfg.company_id=b.company_id AND cfg.tenant_id=b.tenant_id
 LEFT JOIN payroll_policy run_policy ON run_policy.id=cfg.default_payroll_policy_id AND run_policy.tenant_id=b.tenant_id AND run_policy.company_id=b.company_id
 LEFT JOIN payroll_policy assigned ON assigned.id=e.payroll_policy_id AND assigned.tenant_id=e.tenant_id AND assigned.company_id=b.company_id
 LEFT JOIN payroll_policy policy ON policy.id=coalesce(assigned.id,cfg.default_payroll_policy_id) AND policy.tenant_id=b.tenant_id AND policy.company_id=b.company_id
 WHERE app.payroll_history_effective(ps.id) AND lr.id=ANY(request_ids) AND lr.tenant_id=app.current_tenant_id() AND b.status IN ('processed','closed')
 ORDER BY b.id,lr.id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.record_leave_payroll_effect(wanted_request uuid,wanted_batch uuid,action text,dates jsonb,revision text DEFAULT 'completed')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE lr leave_request; b payroll_batch; exception_id uuid; added boolean;
BEGIN
 SELECT * INTO lr FROM leave_request WHERE id=wanted_request AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT (app.can_see_employment(lr.employment_id) OR app.can_decide_via_delegation(lr.employment_id))
   OR action IS NULL OR action NOT IN ('approval','charged_import','cancellation','paid_setting')
   OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=lr.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
   RAISE EXCEPTION 'Leave visibility required';
 END IF;
 IF jsonb_typeof(dates) IS DISTINCT FROM 'array' OR jsonb_array_length(dates)=0 OR revision IS NULL OR length(revision)>4096 THEN RAISE EXCEPTION 'Affected dates and source revision required'; END IF;
 SELECT * INTO b FROM payroll_batch WHERE id=wanted_batch AND tenant_id=lr.tenant_id FOR UPDATE NOWAIT;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM payslip ps WHERE app.payroll_history_effective(ps.id) AND ps.batch_id=b.id AND ps.employment_id=lr.employment_id AND ps.tenant_id=lr.tenant_id) THEN
   RAISE EXCEPTION 'Leave payroll membership required';
 END IF;
 IF b.status='processed' THEN
   added:=NOT (coalesce(b.recalc_employment_ids,'[]'::jsonb) @> jsonb_build_array(lr.employment_id::text));
   UPDATE payroll_batch SET needs_recalc_at=coalesce(needs_recalc_at,now()),
     recalc_employment_ids=CASE WHEN added THEN coalesce(recalc_employment_ids,'[]'::jsonb)||jsonb_build_array(lr.employment_id::text) ELSE recalc_employment_ids END WHERE id=b.id;
   IF added THEN INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
     VALUES(lr.tenant_id,'payroll-batch',b.id,'payroll-batch.recalc-required','user',app.current_user_id(),
       jsonb_build_object('addedEmploymentIds',jsonb_build_array(lr.employment_id::text),'leaveRequestId',lr.id,'sourceAction',action)); END IF;
 ELSIF b.status='closed' THEN
   IF action NOT IN ('approval','charged_import') OR NOT (lr.status='approved' OR (action='approval' AND lr.status='pending' AND EXISTS (
    SELECT 1 FROM leave_request_date d WHERE d.leave_request_id=lr.id AND d.tenant_id=lr.tenant_id AND d.status='approved' AND dates @> jsonb_build_array(d.leave_date::text)
   ))) THEN RAISE EXCEPTION 'Closed payroll cannot be changed by this leave action'; END IF;
   IF lr.imported_history AND NOT EXISTS(SELECT 1 FROM leave_ledger ll WHERE ll.tenant_id=lr.tenant_id AND ll.source_request_id=lr.id AND ll.entry_type='debit') THEN RETURN; END IF;
   INSERT INTO payroll_leave_exception(tenant_id,batch_id,employment_id,leave_request_id,source_action,source_revision,affected_dates,created_by)
    VALUES(lr.tenant_id,b.id,lr.employment_id,lr.id,action,md5(revision),dates,app.current_user_id())
    ON CONFLICT(tenant_id,batch_id,leave_request_id,source_action,source_revision) DO NOTHING RETURNING id INTO exception_id;
   IF exception_id IS NOT NULL THEN INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
    VALUES(lr.tenant_id,'payroll-leave-exception',exception_id,'payroll-leave-exception.opened','user',app.current_user_id(),
      jsonb_build_object('batchId',b.id,'leaveRequestId',lr.id,'sourceAction',action)); END IF;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.resolve_leave_payroll_exception(wanted_exception uuid,outcome text,adjustment uuid,note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item payroll_leave_exception; employer uuid;
BEGIN
 SELECT * INTO item FROM payroll_leave_exception WHERE id=wanted_exception AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll leave exception unavailable'; END IF;
 SELECT company_id INTO employer FROM payroll_batch WHERE id=item.batch_id AND tenant_id=item.tenant_id;
 IF NOT app.is_admin_for(employer) OR NOT app.can_admin_payroll_for(employer)
   OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=item.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Payroll HR authority required'; END IF;
 IF item.status<>'open' OR outcome IS NULL OR outcome NOT IN ('adjustment','no_adjustment') OR note IS NULL OR length(btrim(note))<10 OR length(note)>2000 THEN
   RAISE EXCEPTION 'An open exception and a clear resolution explanation are required';
 END IF;
 IF outcome='adjustment' AND NOT EXISTS (
   SELECT 1 FROM payroll_batch b JOIN payslip ps ON ps.batch_id=b.id AND ps.tenant_id=b.tenant_id
   WHERE b.history_import_attempt_id IS NULL AND app.payroll_history_effective(ps.id) AND b.id=adjustment AND b.id<>item.batch_id AND b.tenant_id=item.tenant_id AND b.status='closed' AND b.run_type='adjustment'
    AND ps.employment_id=item.employment_id AND app.is_admin_for(b.company_id) AND app.can_admin_payroll_for(b.company_id)
 ) THEN RAISE EXCEPTION 'Select a closed adjustment run containing this employee'; END IF;
 IF outcome='no_adjustment' AND adjustment IS NOT NULL THEN RAISE EXCEPTION 'No-adjustment resolution cannot reference an adjustment'; END IF;
 UPDATE payroll_leave_exception SET status='resolved',resolution=outcome,adjustment_batch_id=adjustment,explanation=btrim(note),resolved_by=app.current_user_id(),resolved_at=now() WHERE id=item.id;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(item.tenant_id,'payroll-leave-exception',item.id,'payroll-leave-exception.resolved','user',app.current_user_id(),
    jsonb_build_object('resolution',outcome,'adjustmentBatchId',adjustment));
END $$;
--> statement-breakpoint
