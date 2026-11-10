-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5011_bulk_job_kernel, idx 4411, when 1793330004711.
-- Draft name on its branch: 9003_bulk_job_kernel. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/import-staged-job-20261110 (shared background bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9003, when 1793330090003) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. 9002 is the leave-import proof on another branch.
--
-- One job/step store for every background bulk operation (ADR 2026-11-10 employee import, "Shared job kernel").
-- The web request only admits a row here; the protected import worker claims it with a lease, prepares once,
-- applies steps in short chunk transactions under the creator's fresh authority, finalizes and notifies.
-- Kinds are rows of bulk_job_kind; a new bulk operation adds one row in its own migration.
CREATE TABLE bulk_job_kind (
 kind text PRIMARY KEY CHECK(kind ~ '^[a-z][a-z0-9_]{1,40}$'),
 -- Import History kind whose company access the creator must keep to read the job (NULL: creator only).
 scope_kind text CHECK(scope_kind IS NULL OR scope_kind IN ('cost_allocations','bank_statutory','employee_full','movement','information_correction')),
 -- 'tenant': one active job of this kind per tenant; 'creator': one active job per person.
 exclusive text NOT NULL CHECK(exclusive IN ('tenant','creator'))
);
--> statement-breakpoint
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES('employee_import','employee_full','tenant');
--> statement-breakpoint
REVOKE ALL ON bulk_job_kind FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON bulk_job_kind TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE bulk_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 kind text NOT NULL REFERENCES bulk_job_kind(kind),
 created_by uuid NOT NULL REFERENCES app_user(id),
 context jsonb NOT NULL,
 operation_key uuid NOT NULL,
 exclusive_key text NOT NULL,
 company_ids uuid[] NOT NULL DEFAULT '{}',
 source_name text NOT NULL DEFAULT '' CHECK(length(source_name)<=255),
 source_hash text CHECK(source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$'),
 source_bytes integer NOT NULL DEFAULT 0 CHECK(source_bytes BETWEEN 0 AND 134217728),
 source_content bytea,
 input jsonb,
 plan jsonb,
 attempt_id uuid REFERENCES import_attempt(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','preparing','running','finalizing','discarding','completed','failed','cancelled')),
 -- Where a discarding job ends.
 outcome text CHECK(outcome IN ('failed','cancelled')),
 phase text CHECK(phase IS NULL OR phase ~ '^[a-z][a-z_]{0,40}$'),
 steps_total integer NOT NULL DEFAULT 0 CHECK(steps_total>=0),
 steps_done integer NOT NULL DEFAULT 0 CHECK(steps_done>=0),
 counters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(counters)='object'),
 metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metrics)='object'),
 result jsonb,
 error text CHECK(error IS NULL OR length(error)<=4000),
 errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(errors)='array'),
 cancel_requested_at timestamptz,
 transient_retries integer NOT NULL DEFAULT 0 CHECK(transient_retries>=0),
 not_before timestamptz,
 -- Worker claim. Written only by the queue owner; chunk transactions fence on the token.
 lease_token uuid,
 lease_expires_at timestamptz,
 notice_event_id uuid,
 notified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(tenant_id,created_by,operation_key),
 CHECK(state<>'discarding' OR outcome IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX bulk_job_one_active ON bulk_job(tenant_id,kind,exclusive_key) WHERE state IN ('queued','preparing','running','finalizing','discarding');
--> statement-breakpoint
CREATE INDEX bulk_job_queue ON bulk_job(updated_at) WHERE state IN ('queued','preparing','running','finalizing','discarding');
--> statement-breakpoint
CREATE INDEX bulk_job_creator ON bulk_job(tenant_id,created_by,kind,created_at DESC);
--> statement-breakpoint
-- Terminal jobs whose completion notice is still owed (normally none for longer than one worker tick).
CREATE INDEX bulk_job_unnotified ON bulk_job(finished_at) WHERE notified_at IS NULL AND state IN ('completed','failed','cancelled');
--> statement-breakpoint
CREATE TABLE bulk_job_step (
 job_id uuid NOT NULL REFERENCES bulk_job(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 seq integer NOT NULL CHECK(seq>=0),
 kind text NOT NULL CHECK(kind ~ '^[a-z][a-z_]{0,40}$'),
 row_num integer,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','failed')),
 payload jsonb NOT NULL,
 result jsonb,
 error text CHECK(error IS NULL OR length(error)<=1000),
 PRIMARY KEY(job_id,seq)
);
--> statement-breakpoint
CREATE INDEX bulk_job_step_pending ON bulk_job_step(job_id,seq) WHERE state='pending';
--> statement-breakpoint
-- Worker heartbeat: which kinds a running worker serves. Owner-only; the app reads readiness through a definer.
CREATE TABLE bulk_job_worker (
 id uuid PRIMARY KEY,
 kinds text[] NOT NULL,
 host text NOT NULL CHECK(length(host)<=255),
 pid integer NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 beat_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
REVOKE ALL ON bulk_job,bulk_job_step,bulk_job_worker FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT ON bulk_job TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(company_ids,source_content,input,plan,attempt_id,state,outcome,phase,steps_total,steps_done,counters,metrics,result,error,errors,cancel_requested_at,transient_retries,not_before,notice_event_id,notified_at,updated_at,finished_at) ON bulk_job TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON bulk_job_step TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(state,result,error) ON bulk_job_step TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE bulk_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bulk_job_step ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bulk_job_worker ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Admission: the database, not the caller, captures the creator's grants (same shape as bank_import_job_context,
-- 0685) and derives the exclusivity key from the kind, so no writer can opt out of one-active-per-scope.
CREATE FUNCTION app.bulk_job_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mode text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Bulk job access denied' USING ERRCODE='42501';END IF;
 SELECT k.exclusive INTO mode FROM public.bulk_job_kind k WHERE k.kind=NEW.kind;
 IF mode IS NULL THEN RAISE EXCEPTION 'Unknown bulk job kind' USING ERRCODE='22023';END IF;
 NEW.context:=jsonb_build_object('tenantId',app.current_tenant_id(),'userId',app.current_user_id(),
  'roles',to_jsonb(app.current_roles()),'grants',coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb));
 NEW.exclusive_key:=CASE mode WHEN 'tenant' THEN 'tenant' ELSE NEW.created_by::text END;
 NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
 NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_admit() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_admit() TO ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER bulk_job_admit BEFORE INSERT ON bulk_job FOR EACH ROW EXECUTE FUNCTION app.bulk_job_admit();
--> statement-breakpoint
-- The creator keeps reading a job only while the captured grants remain current and, for scoped kinds, while
-- every company of the job is still viewable for that Import History kind.
CREATE FUNCTION app.bulk_job_scope_current(p_kind text,p_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.bulk_job_kind k CROSS JOIN unnest(p_companies) c(id)
  WHERE k.kind=p_kind AND k.scope_kind IS NOT NULL AND NOT app.import_company_access(k.scope_kind,c.id,'view'));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_scope_current(text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_scope_current(text,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_access(wanted uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.bulk_job j WHERE j.id=wanted AND j.tenant_id=app.current_tenant_id()
  AND j.created_by=app.current_user_id() AND app.bank_import_context_current(j.context) AND app.bulk_job_scope_current(j.kind,j.company_ids));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_access(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY bulk_job_read ON bulk_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id()
 AND app.bank_import_context_current(context) AND app.bulk_job_scope_current(kind,company_ids));
--> statement-breakpoint
CREATE POLICY bulk_job_insert ON bulk_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY bulk_job_update ON bulk_job FOR UPDATE USING(app.bulk_job_access(id)) WITH CHECK(app.bulk_job_access(id));
--> statement-breakpoint
-- The authorized-job set is computed once per statement (bank_import_row shape, 0685).
CREATE POLICY bulk_job_step_access ON bulk_job_step FOR ALL USING(job_id IN (SELECT id FROM bulk_job)) WITH CHECK(job_id IN (SELECT id FROM bulk_job) AND tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- A queued job whose kind no live worker serves is shown as waiting for the import service, not as running.
CREATE FUNCTION app.bulk_job_worker_ready(p_kind text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.bulk_job_worker w WHERE p_kind=ANY(w.kinds) AND w.beat_at>now()-interval '90 seconds');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_worker_ready(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_worker_ready(text) TO ai_hr_app;
--> statement-breakpoint
-- Completion notice recipient: the creator's own current employment, only for the job's recorded notice event,
-- appended by the creator. A forged event cannot address anyone else, and a blocked login receives nothing new.
CREATE FUNCTION app.bulk_job_notice_recipients(p_event uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT target.id FROM public.domain_event ev
 JOIN public.bulk_job j ON j.notice_event_id=ev.id AND j.tenant_id=ev.tenant_id AND j.id=ev.aggregate_id AND j.created_by=ev.actor_id
  AND j.state IN ('completed','failed','cancelled')
 JOIN public.app_user u ON u.id=j.created_by AND u.tenant_id=j.tenant_id AND u.person_id IS NOT NULL
 CROSS JOIN LATERAL (SELECT e.id FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id
   AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
  ORDER BY (e.terminated_on IS NULL) DESC,e.hired_on DESC,e.id LIMIT 1) target
 WHERE ev.id=p_event AND ev.tenant_id=app.current_tenant_id() AND ev.event_type='bulk-job.finished'
  AND ev.aggregate_type='bulk-job' AND ev.actor_type='user' AND NOT app.login_blocked(u.id);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_notice_recipients(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_notice_recipients(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The employee import now runs on the kernel. Its phase-1 tables (5010, never installed) are replaced here.
DROP TABLE employee_import_step;
--> statement-breakpoint
DROP TABLE employee_import_job;
--> statement-breakpoint
DROP FUNCTION app.employee_import_job_access(uuid);
