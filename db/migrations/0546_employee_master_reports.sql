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
 enabled boolean NOT NULL DEFAULT false,config jsonb NOT NULL,recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
 report_version integer NOT NULL CHECK(report_version>0),reviewed_digest text NOT NULL CHECK(reviewed_digest ~ '^[a-f0-9]{64}$'),reviewed_revision uuid NOT NULL DEFAULT gen_random_uuid(),next_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(config-ARRAY['frequency','day','hour','minute','timezone']='{}'::jsonb AND jsonb_typeof(config)='object' AND octet_length(config::text)<=512 AND config ?& ARRAY['frequency','day','hour','minute','timezone'] AND jsonb_typeof(config->'frequency')='string' AND jsonb_typeof(config->'day')='number' AND jsonb_typeof(config->'hour')='number' AND jsonb_typeof(config->'minute')='number' AND jsonb_typeof(config->'timezone')='string' AND config->>'frequency' IN ('weekly','monthly')
 AND (config->>'day') ~ '^([0-9]|[12][0-9]|3[01])$' AND (config->>'hour') ~ '^([0-9]|1[0-9]|2[0-3])$'
 AND (config->>'minute') ~ '^([0-9]|[1-5][0-9])$' AND length(config->>'timezone') BETWEEN 1 AND 64
 AND (CASE WHEN config->>'frequency'='weekly' THEN (config->>'day')::int BETWEEN 0 AND 6 ELSE (config->>'day')::int BETWEEN 1 AND 31 END)),
 CHECK(jsonb_typeof(recipients)='array' AND jsonb_array_length(recipients)<=100 AND octet_length(recipients::text)<=14000),CHECK(NOT enabled OR (next_run_at IS NOT NULL AND jsonb_array_length(recipients)>0))
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
 schedule_id uuid NOT NULL,report_id uuid NOT NULL,schedule_revision uuid NOT NULL,reviewed_digest text NOT NULL CHECK(reviewed_digest ~ '^[a-f0-9]{64}$'),
 owner_user_id uuid NOT NULL,recipient_user_id uuid NOT NULL,recipient_employment_id uuid NOT NULL,scheduled_for timestamptz NOT NULL,report_version integer NOT NULL CHECK(report_version>0),
 consent_after_sequence bigint NOT NULL CHECK(consent_after_sequence>=0),policy_after_sequence bigint NOT NULL CHECK(policy_after_sequence>=0),
 consent_updated_at timestamptz NOT NULL,policy_updated_at timestamptz NOT NULL,consent_verified_at timestamptz NOT NULL,
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
 IF jsonb_typeof(NEW.recipients)<>'array' OR jsonb_array_length(NEW.recipients)>100 THEN RAISE EXCEPTION 'Invalid schedule recipients'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.recipients) r WHERE jsonb_typeof(r)<>'object' OR NOT (r ?& ARRAY['userId','employmentId']) OR r-ARRAY['userId','employmentId']<>'{}'::jsonb OR coalesce(r->>'userId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' OR coalesce(r->>'employmentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RAISE EXCEPTION 'Invalid schedule recipient identity'; END IF;
 IF jsonb_array_length(NEW.recipients)<>(SELECT count(DISTINCT r->>'userId') FROM jsonb_array_elements(NEW.recipients) r) OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.recipients) r WHERE NOT EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id=(r->>'userId')::uuid AND e.id=(r->>'employmentId')::uuid AND u.tenant_id=NEW.tenant_id)) THEN RAISE EXCEPTION 'Schedule recipient unavailable'; END IF;
 IF NEW.enabled AND NOT EXISTS(SELECT 1 FROM custom_report r WHERE r.id=NEW.report_id AND r.tenant_id=NEW.tenant_id AND r.version=NEW.report_version) THEN RAISE EXCEPTION 'Review the changed report before enabling delivery'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER custom_report_schedule_identity_guard BEFORE INSERT OR UPDATE ON custom_report_schedule FOR EACH ROW EXECUTE FUNCTION app.custom_report_schedule_identity_guard();

--> statement-breakpoint
REVOKE ALL ON FUNCTION app.custom_report_schedule_identity_guard() FROM PUBLIC;

--> statement-breakpoint
-- A distinct OFF-by-default preference/policy category; workflow dispatcher categories are unchanged.
ALTER TABLE notification_email_policy DROP CONSTRAINT notification_email_policy_category_check;
--> statement-breakpoint
ALTER TABLE notification_email_policy ADD CONSTRAINT notification_email_policy_category_check CHECK(category IN ('attendance','claims','delegation','leave','notice','offboarding','payroll','performance','profile','readiness','review','rewards','toil','employee_master_reports'));
--> statement-breakpoint
ALTER TABLE notification_pref ADD COLUMN report_consent_issuer text,ADD COLUMN report_consent_subject text,
 ADD COLUMN report_consent_address_hash text,ADD COLUMN report_consent_verified_at timestamptz;
--> statement-breakpoint
ALTER TABLE notification_pref ADD CONSTRAINT notification_pref_report_binding CHECK(
 (num_nonnulls(report_consent_issuer,report_consent_subject,report_consent_address_hash,report_consent_verified_at)=0 AND NOT(category='employee_master_reports' AND channel='email' AND enabled))
 OR (num_nonnulls(report_consent_issuer,report_consent_subject,report_consent_address_hash,report_consent_verified_at)=4 AND category='employee_master_reports' AND channel='email' AND (NOT enabled OR (email_consent_user_id IS NOT NULL AND email_after_sequence IS NOT NULL)) AND length(report_consent_issuer) BETWEEN 1 AND 2048 AND length(report_consent_subject) BETWEEN 1 AND 512 AND report_consent_address_hash ~ '^[a-f0-9]{64}$' AND report_consent_verified_at IS NOT NULL));
--> statement-breakpoint
-- Current identity eligibility owned by Notifications, never report-supplied addresses or consent.
-- Verification at opt-in is recorded here; fresh provider emailVerified is ALSO required by transport.
CREATE FUNCTION app.employee_master_report_recipients(p_user uuid DEFAULT NULL,p_employment uuid DEFAULT NULL)
RETURNS TABLE(user_id uuid,person_id uuid,employment_id uuid,company_id uuid,employee_code text,full_name text,company_name text,
 consent_after_sequence bigint,policy_after_sequence bigint,consent_updated_at timestamptz,policy_updated_at timestamptz,consent_verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT u.id,e.person_id,e.id,e.company_id,e.employee_code,p.full_name,c.legal_name,
 pref.email_after_sequence,policy.after_sequence,pref.updated_at,policy.updated_at,pref.report_consent_verified_at
 FROM notification_pref pref JOIN employment e ON e.id=pref.recipient_employment_id AND e.tenant_id=pref.tenant_id
 JOIN app_user u ON u.id=pref.email_consent_user_id AND u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 JOIN notification_email_policy policy ON policy.tenant_id=e.tenant_id AND policy.category='employee_master_reports' AND policy.enabled
 JOIN app_external_identity i ON i.app_user_id=u.id AND i.issuer=pref.report_consent_issuer AND i.subject=pref.report_consent_subject AND i.revoked_at IS NULL
 WHERE pref.tenant_id=app.current_tenant_id() AND pref.category='employee_master_reports' AND pref.channel='email' AND pref.enabled
 AND pref.email_after_sequence IS NOT NULL AND pref.report_consent_verified_at IS NOT NULL
 AND pref.report_consent_address_hash=encode(sha256(convert_to(lower(p.primary_email),'UTF8')),'hex')
 AND p.primary_email IS NOT NULL AND length(p.primary_email)>0 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
 AND app.current_user_id() IS NOT NULL AND app.can_see_employment(e.id)
 AND (p_user IS NULL OR u.id=p_user) AND (p_employment IS NULL OR e.id=p_employment)
 ORDER BY p.full_name,e.employee_code,e.id,u.id LIMIT 1001;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_master_report_recipients(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employee_master_report_recipients(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.custom_report_occurrence_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.tenant_id,NEW.schedule_id,NEW.report_id,NEW.schedule_revision,NEW.reviewed_digest,NEW.owner_user_id,NEW.recipient_user_id,NEW.recipient_employment_id,NEW.scheduled_for,NEW.report_version,NEW.consent_after_sequence,NEW.policy_after_sequence,NEW.consent_updated_at,NEW.policy_updated_at,NEW.consent_verified_at,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.schedule_id,OLD.report_id,OLD.schedule_revision,OLD.reviewed_digest,OLD.owner_user_id,OLD.recipient_user_id,OLD.recipient_employment_id,OLD.scheduled_for,OLD.report_version,OLD.consent_after_sequence,OLD.policy_after_sequence,OLD.consent_updated_at,OLD.policy_updated_at,OLD.consent_verified_at,OLD.created_at) THEN RAISE EXCEPTION 'Delivery identity and reviewed revisions are immutable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER custom_report_occurrence_identity_guard BEFORE UPDATE ON custom_report_occurrence FOR EACH ROW EXECUTE FUNCTION app.custom_report_occurrence_identity_guard();
--> statement-breakpoint
-- Changing an address revokes report consent durably, including change-away/change-back. A hash
-- comparison at send time alone would otherwise revive an old opt-in after the address is restored.
CREATE FUNCTION app.employee_master_report_email_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF lower(NEW.primary_email) IS DISTINCT FROM lower(OLD.primary_email) THEN
  UPDATE notification_pref pref SET enabled=false,email_consent_user_id=NULL,email_after_sequence=NULL,
   report_consent_issuer=NULL,report_consent_subject=NULL,report_consent_address_hash=NULL,report_consent_verified_at=NULL,updated_at=now()
  FROM employment e WHERE pref.tenant_id=NEW.tenant_id AND pref.recipient_employment_id=e.id AND e.tenant_id=NEW.tenant_id
  AND e.person_id=NEW.id AND pref.category='employee_master_reports' AND pref.channel='email';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_master_report_email_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER employee_master_report_email_changed AFTER UPDATE OF primary_email ON person FOR EACH ROW EXECUTE FUNCTION app.employee_master_report_email_changed();
