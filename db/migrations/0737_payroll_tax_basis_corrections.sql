-- Explicit tax-basis corrections preserve every original payroll snapshot and cash figure.
CREATE TABLE payroll_tax_basis_preview (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 created_by uuid NOT NULL REFERENCES app_user(id),preview jsonb NOT NULL,selection jsonb NOT NULL,preview_hash text NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id)
);
CREATE TABLE payroll_tax_basis_batch (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 preview_id uuid NOT NULL REFERENCES payroll_tax_basis_preview(id),created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(preview_id),UNIQUE(tenant_id,id)
);
CREATE TABLE payroll_tax_basis_event (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 batch_id uuid NOT NULL REFERENCES payroll_tax_basis_batch(id),employment_id uuid REFERENCES employment(id),actor_id uuid NOT NULL REFERENCES app_user(id),
 kind text NOT NULL CHECK(kind IN ('pending','processing','completed','completed_with_errors','failed','employee_completed','employee_failed')),
 detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payroll_tax_basis_employee_once ON payroll_tax_basis_event(batch_id,employment_id) WHERE kind='employee_completed';
CREATE TABLE payroll_tax_basis_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 employment_id uuid NOT NULL REFERENCES employment(id),payslip_id uuid NOT NULL REFERENCES payslip(id),period text NOT NULL CHECK(period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),ordinal integer NOT NULL CHECK(ordinal>0),batch_id uuid NOT NULL REFERENCES payroll_tax_basis_batch(id),
 basis jsonb NOT NULL CHECK(basis->>'version'='1'),supersedes uuid[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(payslip_id,ordinal),UNIQUE(batch_id,payslip_id)
);
CREATE INDEX payroll_tax_basis_revision_employment_period ON payroll_tax_basis_revision(tenant_id,employment_id,period);
CREATE INDEX payroll_tax_basis_batch_company ON payroll_tax_basis_batch(tenant_id,company_id,created_at);
CREATE INDEX payroll_tax_basis_event_batch ON payroll_tax_basis_event(batch_id,created_at,id);
--> statement-breakpoint
-- Match lib/payroll-permissions.ts override-set semantics at the SQL boundary as well.
CREATE FUNCTION app.payroll_tax_basis_permission(target uuid,permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH configured AS (SELECT role,allowed,company_id FROM public.payroll_permission_grant WHERE tenant_id=app.current_tenant_id() AND permission_key=permission AND (company_id=target OR company_id IS NULL)),
 effective AS (SELECT role,allowed FROM configured WHERE (company_id=target AND EXISTS(SELECT 1 FROM configured WHERE company_id=target)) OR (company_id IS NULL AND NOT EXISTS(SELECT 1 FROM configured WHERE company_id=target)))
 SELECT permission IN ('payroll.tax-basis.view','payroll.tax-basis.recalculate') AND app.principal_snapshot_current() AND app.can_admin_payroll_for(target) AND
 CASE WHEN EXISTS(SELECT 1 FROM effective) THEN EXISTS(SELECT 1 FROM effective a WHERE a.allowed AND app.has_role_for(a.role,target) AND NOT EXISTS(SELECT 1 FROM effective d WHERE d.role=a.role AND NOT d.allowed))
 ELSE app.has_role_for('hr_admin',target) OR app.has_role_for('super_admin',target) END
$$;
REVOKE ALL ON FUNCTION app.payroll_tax_basis_permission(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_permission(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_tax_basis_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() OR NOT app.payroll_tax_basis_permission(NEW.company_id,'payroll.tax-basis.recalculate')
 THEN RAISE EXCEPTION 'Payroll tax-basis authority unavailable'; END IF;
 IF TG_TABLE_NAME='payroll_tax_basis_preview' THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
  THEN RAISE EXCEPTION 'Tax preview identity mismatch'; END IF;
 ELSIF TG_TABLE_NAME='payroll_tax_basis_batch' THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() OR NOT EXISTS(SELECT 1 FROM public.payroll_tax_basis_preview p WHERE p.id=NEW.preview_id AND p.tenant_id=NEW.tenant_id AND p.company_id=NEW.company_id AND p.created_by=NEW.created_by)
  THEN RAISE EXCEPTION 'Tax batch identity mismatch'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.payroll_tax_basis_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id)
  THEN RAISE EXCEPTION 'Tax correction batch identity mismatch'; END IF;
  IF TG_TABLE_NAME='payroll_tax_basis_event' THEN
   IF NEW.actor_id IS DISTINCT FROM app.current_user_id() OR (NEW.employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id WHERE p.employment_id=NEW.employment_id AND p.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.status IN ('processed','closed')))
   THEN RAISE EXCEPTION 'Tax outcome identity mismatch'; END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id WHERE p.id=NEW.payslip_id AND p.tenant_id=NEW.tenant_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND p.employment_id=NEW.employment_id AND b.pay_period=NEW.period AND b.status IN ('processed','closed'))
   THEN RAISE EXCEPTION 'Tax basis source identity mismatch'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_tax_basis_preview','payroll_tax_basis_batch','payroll_tax_basis_event','payroll_tax_basis_revision'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tax_basis_admin_read ON %I FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.payroll_tax_basis_permission(company_id,''payroll.tax-basis.view''))',t);
  EXECUTE format('CREATE POLICY tax_basis_admin_insert ON %I FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.payroll_tax_basis_permission(company_id,''payroll.tax-basis.recalculate''))',t);
  EXECUTE format('CREATE TRIGGER tax_basis_binding BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION app.payroll_tax_basis_bind()',t);
  EXECUTE format('CREATE TRIGGER tax_basis_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable()',t);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO ai_hr_app',t);
  EXECUTE format('REVOKE UPDATE,DELETE,TRUNCATE ON %I FROM ai_hr_app',t);
 END LOOP;
END $$;
-- Own corrected tax inputs can feed self-service annual reports without exposing the admin batch log.
CREATE POLICY tax_basis_own_read ON payroll_tax_basis_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.employment e WHERE e.id=employment_id AND e.tenant_id=payroll_tax_basis_revision.tenant_id AND app.is_self_person(e.person_id)));
GRANT UPDATE(id) ON payroll_tax_basis_preview,payroll_tax_basis_batch TO ai_hr_app;
CREATE POLICY tax_basis_preview_lock ON payroll_tax_basis_preview FOR UPDATE USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id)) WITH CHECK(false);
CREATE POLICY tax_basis_batch_lock ON payroll_tax_basis_batch FOR UPDATE USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current() AND app.can_admin_payroll_for(company_id)) WITH CHECK(false);

--> statement-breakpoint
-- Historical employer authority is checked on the original batch, never borrowed from a transfer destination.
CREATE FUNCTION app.payroll_tax_basis_subjects(target uuid,assessment_year integer,up_to_month integer)
RETURNS TABLE(id uuid,"employeeNo" text,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT DISTINCT e.id,coalesce(e.employee_code,''),p.full_name FROM public.employment e JOIN public.person p ON p.id=e.person_id
 JOIN public.payslip s ON s.employment_id=e.id JOIN public.payroll_batch b ON b.id=s.batch_id
 WHERE app.payroll_tax_basis_permission(target,'payroll.tax-basis.view')
 AND b.tenant_id=app.current_tenant_id() AND s.tenant_id=b.tenant_id AND e.tenant_id=b.tenant_id AND p.tenant_id=b.tenant_id
 AND b.company_id=target AND b.status IN ('processed','closed') AND app.payroll_history_effective(s.id)
 AND (assessment_year IS NULL OR (b.pay_period>=assessment_year::text||'-01' AND b.pay_period<=assessment_year::text||'-'||lpad(up_to_month::text,2,'0')))
$$;
REVOKE ALL ON FUNCTION app.payroll_tax_basis_subjects(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_subjects(uuid,integer,integer) TO ai_hr_app;

--> statement-breakpoint
-- A permitted payroll calculation/report must consume corrected inputs even when its actor cannot
-- open the administrative correction log. The original payslip RLS remains the read boundary.
CREATE POLICY tax_basis_payroll_source_read ON payroll_tax_basis_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id WHERE p.tenant_id=payroll_tax_basis_revision.tenant_id AND b.tenant_id=p.tenant_id AND p.employment_id=payroll_tax_basis_revision.employment_id AND b.company_id=payroll_tax_basis_revision.company_id AND b.pay_period=payroll_tax_basis_revision.period));

--> statement-breakpoint
-- A rollback must not silently read an uncorrected tax basis. New transaction owners declare
-- the implemented reader contract; legacy readers fail closed on affected payroll source contexts.
-- The definer checks only revision/batch/employment tables, never payslip, avoiding policy recursion.
CREATE FUNCTION app.payroll_tax_basis_reader_compatible(subject_employment uuid,source_batch uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
BEGIN
 IF current_setting('app.payroll_tax_basis_reader',true)='1' THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.payroll_tax_basis_revision r JOIN public.payroll_batch b ON b.id=source_batch
  WHERE r.tenant_id=app.current_tenant_id() AND b.tenant_id=r.tenant_id AND r.employment_id=subject_employment
  AND r.company_id=b.company_id AND r.period=b.pay_period
  AND app.principal_snapshot_current() AND (app.can_admin_payroll_for(b.company_id) OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=subject_employment AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id))))
 THEN RAISE EXCEPTION 'A correction-aware income-tax reader is required for this payroll history' USING ERRCODE='55000'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.payroll_tax_basis_reader_compatible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_tax_basis_reader_compatible(uuid,uuid) TO ai_hr_app;
CREATE POLICY payroll_tax_basis_reader_guard ON payslip AS RESTRICTIVE FOR SELECT TO ai_hr_app USING(app.payroll_tax_basis_reader_compatible(employment_id,batch_id));
