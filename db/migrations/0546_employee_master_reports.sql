-- 5f9c8062: report ownership is privacy, including between HR administrators.
-- Append-only migration, allocated centrally after 0545. No salary or Personnel owner data is changed.
GRANT SELECT,INSERT,UPDATE,DELETE ON custom_report TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE custom_report ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE custom_report ADD COLUMN IF NOT EXISTS shared_role_ids text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
ALTER TABLE custom_report ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
--> statement-breakpoint
ALTER TABLE custom_report ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Legacy shared readership was admin-only at the route, then the per-report permission grid.
-- Preserve at most that intersection; never expand it to ordinary tenant members. Orphan/null owners
-- remain quarantined with an empty role list until a separately reviewed maintenance decision.
UPDATE custom_report r SET shared_role_ids =
  CASE WHEN coalesce(r.spec->'layout'->'permissions','{}'::jsonb) = '{}'::jsonb
       OR coalesce(r.spec->'layout'->'permissions'->'hr_admin','[]'::jsonb) ?| ARRAY['view','export','edit']
       THEN ARRAY['hr_admin','super_admin']::text[] ELSE ARRAY['super_admin']::text[] END
WHERE r.shared AND r.created_by_user_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=r.created_by_user_id AND u.tenant_id=r.tenant_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.custom_report_visible(p_owner uuid,p_shared boolean,p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT p_owner=app.current_user_id() OR (p_shared AND coalesce(p_roles,ARRAY[]::text[]) && app.current_roles()) $$;
--> statement-breakpoint
DROP POLICY IF EXISTS custom_report_read ON custom_report;
--> statement-breakpoint
DROP POLICY IF EXISTS custom_report_write ON custom_report;
--> statement-breakpoint
CREATE POLICY custom_report_read ON custom_report FOR SELECT USING
(tenant_id=app.current_tenant_id() AND app.custom_report_visible(created_by_user_id,shared,shared_role_ids));
--> statement-breakpoint
CREATE POLICY custom_report_insert ON custom_report FOR INSERT WITH CHECK
(tenant_id=app.current_tenant_id() AND created_by_user_id=app.current_user_id() AND app.current_user_id() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY custom_report_update ON custom_report FOR UPDATE USING
(tenant_id=app.current_tenant_id() AND app.custom_report_visible(created_by_user_id,shared,shared_role_ids)
 AND (created_by_user_id=app.current_user_id() OR app.is_admin())) WITH CHECK
(tenant_id=app.current_tenant_id() AND (created_by_user_id=app.current_user_id() OR app.is_admin()));
--> statement-breakpoint
CREATE POLICY custom_report_delete ON custom_report FOR DELETE USING
(tenant_id=app.current_tenant_id() AND app.custom_report_visible(created_by_user_id,shared,shared_role_ids)
 AND (created_by_user_id=app.current_user_id() OR app.is_admin()));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.custom_report_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Report identity and owner are immutable';
  END IF;
  IF ROW(NEW.name,NEW.description,NEW.dataset_id,NEW.spec,NEW.shared,NEW.shared_role_ids)
     IS DISTINCT FROM ROW(OLD.name,OLD.description,OLD.dataset_id,OLD.spec,OLD.shared,OLD.shared_role_ids) THEN
    NEW.version:=OLD.version+1;
  ELSE NEW.version:=OLD.version; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER custom_report_identity_guard BEFORE UPDATE ON custom_report FOR EACH ROW EXECUTE FUNCTION app.custom_report_identity_guard();
--> statement-breakpoint
CREATE TABLE custom_report_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),report_id uuid,
 actor_user_id uuid NOT NULL,report_version integer,kind text NOT NULL,format text,
 scope_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],row_count integer NOT NULL DEFAULT 0,
 outcome text NOT NULL CHECK(outcome IN ('success','failed','skipped')),reason text,
 ran_at timestamptz NOT NULL DEFAULT now(),CHECK(row_count>=0 AND row_count<=50000)
);
--> statement-breakpoint
CREATE INDEX custom_report_run_report_idx ON custom_report_run(tenant_id,report_id,ran_at);
--> statement-breakpoint
ALTER TABLE custom_report_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON custom_report_run TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY custom_report_run_read ON custom_report_run FOR SELECT USING(tenant_id=app.current_tenant_id() AND
 (actor_user_id=app.current_user_id() OR EXISTS(SELECT 1 FROM custom_report r WHERE r.id=report_id AND r.tenant_id=custom_report_run.tenant_id)));
--> statement-breakpoint
-- Readers can record their own authorised run without acquiring report-edit authority. The function
-- returns metadata only; its private-report predicate has no administrator override.
CREATE OR REPLACE FUNCTION app.record_custom_report_run(p_report uuid,p_version integer,p_kind text,p_format text,p_scope uuid[],p_rows integer,p_outcome text,p_reason text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ DECLARE v_id uuid; BEGIN
 IF app.current_user_id() IS NULL OR p_kind NOT IN ('preview','run','export','delivery') OR p_outcome NOT IN ('success','failed','skipped') OR (p_format IS NOT NULL AND p_format NOT IN ('xlsx','csv','pdf','docx')) OR p_rows<0 OR p_rows>50000 OR coalesce(array_length(p_scope,1),0)>100 OR length(coalesce(p_reason,''))>200 THEN RAISE EXCEPTION 'Invalid report audit attempt'; END IF;
 IF p_report IS NOT NULL AND NOT EXISTS(SELECT 1 FROM custom_report r WHERE r.id=p_report AND r.tenant_id=app.current_tenant_id() AND app.custom_report_visible(r.created_by_user_id,r.shared,r.shared_role_ids)) THEN RAISE EXCEPTION 'Report unavailable'; END IF;
 INSERT INTO custom_report_run(tenant_id,report_id,actor_user_id,report_version,kind,format,scope_ids,row_count,outcome,reason)
 VALUES(app.current_tenant_id(),p_report,app.current_user_id(),p_version,p_kind,p_format,coalesce(p_scope,ARRAY[]::uuid[]),p_rows,p_outcome,p_reason) RETURNING id INTO v_id;
 IF p_report IS NOT NULL AND p_outcome='success' THEN UPDATE custom_report SET last_run_at=now() WHERE id=p_report AND tenant_id=app.current_tenant_id() AND version=p_version; END IF;
 RETURN v_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.record_custom_report_run(uuid,integer,text,text,uuid[],integer,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.record_custom_report_run(uuid,integer,text,text,uuid[],integer,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE custom_report_schedule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 report_id uuid NOT NULL REFERENCES custom_report(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,config jsonb NOT NULL,recipient_user_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
 report_version integer NOT NULL CHECK(report_version>0),reviewed_digest text NOT NULL CHECK(reviewed_digest ~ '^[a-f0-9]{64}$'),next_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(jsonb_typeof(config)='object' AND octet_length(config::text)<=512 AND config ?& ARRAY['frequency','day','hour','minute','timezone'] AND jsonb_typeof(config->'frequency')='string' AND jsonb_typeof(config->'day')='number' AND jsonb_typeof(config->'hour')='number' AND jsonb_typeof(config->'minute')='number' AND jsonb_typeof(config->'timezone')='string' AND config->>'frequency' IN ('weekly','monthly')
 AND (config->>'day') ~ '^([0-9]|[12][0-9]|3[01])$' AND (config->>'hour') ~ '^([0-9]|1[0-9]|2[0-3])$'
 AND (config->>'minute') ~ '^([0-9]|[1-5][0-9])$' AND length(config->>'timezone') BETWEEN 1 AND 64
 AND (CASE WHEN config->>'frequency'='weekly' THEN (config->>'day')::int BETWEEN 0 AND 6 ELSE (config->>'day')::int BETWEEN 1 AND 31 END)),
 CHECK(coalesce(array_length(recipient_user_ids,1),0)<=100),CHECK(NOT enabled OR (next_run_at IS NOT NULL AND cardinality(recipient_user_ids)>0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX custom_report_schedule_report_uq ON custom_report_schedule(report_id);
--> statement-breakpoint
CREATE INDEX custom_report_schedule_due_idx ON custom_report_schedule(enabled,next_run_at);
--> statement-breakpoint
ALTER TABLE custom_report_schedule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON custom_report_schedule TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY custom_report_schedule_read ON custom_report_schedule FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM custom_report r WHERE r.id=report_id AND r.tenant_id=custom_report_schedule.tenant_id));
--> statement-breakpoint
CREATE POLICY custom_report_schedule_write ON custom_report_schedule FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM custom_report r WHERE r.id=report_id AND r.tenant_id=custom_report_schedule.tenant_id AND (r.created_by_user_id=app.current_user_id() OR app.is_admin())))
WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM custom_report r WHERE r.id=report_id AND r.tenant_id=custom_report_schedule.tenant_id AND (r.created_by_user_id=app.current_user_id() OR app.is_admin())));
--> statement-breakpoint
CREATE TABLE custom_report_occurrence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 -- Logical immutable IDs intentionally retain sent/uncertain history after template deletion.
 schedule_id uuid NOT NULL,report_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,recipient_user_id uuid NOT NULL,recipient_employment_id uuid NOT NULL,scheduled_for timestamptz NOT NULL,report_version integer NOT NULL CHECK(report_version>0),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','started','sent','failed','skipped','uncertain')),
 lease_token uuid,lease_until timestamptz,started_at timestamptz,finished_at timestamptz,row_count integer,
 reason text CHECK(length(reason)<=200),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(row_count IS NULL OR row_count BETWEEN 0 AND 50000),CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX custom_report_occurrence_identity_uq ON custom_report_occurrence(schedule_id,recipient_user_id,scheduled_for);
--> statement-breakpoint
CREATE INDEX custom_report_occurrence_work_idx ON custom_report_occurrence(status,scheduled_for,lease_until);
--> statement-breakpoint
ALTER TABLE custom_report_occurrence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT ON custom_report_occurrence TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY custom_report_occurrence_read ON custom_report_occurrence FOR SELECT USING(tenant_id=app.current_tenant_id() AND (owner_user_id=app.current_user_id() OR recipient_user_id=app.current_user_id() OR EXISTS(SELECT 1 FROM custom_report r WHERE r.id=report_id AND r.tenant_id=custom_report_occurrence.tenant_id)));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.custom_report_schedule_identity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.report_id IS DISTINCT FROM OLD.report_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN RAISE EXCEPTION 'Schedule identity is immutable'; END IF;
 IF cardinality(NEW.recipient_user_ids)<>(SELECT count(DISTINCT recipient) FROM unnest(NEW.recipient_user_ids) recipient) OR coalesce(array_length(NEW.recipient_user_ids,1),0)>100 OR EXISTS(SELECT 1 FROM unnest(NEW.recipient_user_ids) recipient WHERE NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=recipient AND u.tenant_id=NEW.tenant_id)) THEN RAISE EXCEPTION 'Schedule recipient unavailable'; END IF;
 IF NEW.enabled AND NOT EXISTS(SELECT 1 FROM custom_report r WHERE r.id=NEW.report_id AND r.tenant_id=NEW.tenant_id AND r.version=NEW.report_version) THEN RAISE EXCEPTION 'Review the changed report before enabling delivery'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER custom_report_schedule_identity_guard BEFORE INSERT OR UPDATE ON custom_report_schedule FOR EACH ROW EXECUTE FUNCTION app.custom_report_schedule_identity_guard();

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.custom_report_schedule_identity_guard() FROM PUBLIC;
