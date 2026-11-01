-- ADR-0170 step 5a (§3.10, §3.11, §11.3 change 5): the outcome record, task-memory persistence and
-- work-job mandates. Provisional DEVELOPMENT source allocation 0890 / when1793330000290 (docs/MIGRATION-
-- ALLOCATION.md); it grants no installation, and the journal position is re-frozen at integration.
--
-- Nothing here is read by the production Assistant. Every table is tenant-isolated by RLS and carries
-- explicit grants: the cluster's default privileges would otherwise hand ai_hr_app full CRUD, so every
-- privilege a table must NOT have is revoked here, not merely left ungranted.
--
-- Shared helper: bump a version column on every content change. The version is never written by a caller:
-- a supplied value is overwritten, so "versioned automatically on every edit" cannot be bypassed.
CREATE FUNCTION app.teras_bump_version() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE col text:=TG_ARGV[0];previous integer:=(to_jsonb(OLD)->>TG_ARGV[0])::integer;
BEGIN
 IF (to_jsonb(NEW)-col-'updated_at'-'changed_at'-'changed_by_user_id') IS DISTINCT FROM (to_jsonb(OLD)-col-'updated_at'-'changed_at'-'changed_by_user_id') THEN
  NEW:=jsonb_populate_record(NEW,jsonb_build_object(col,previous+1));
 ELSE
  NEW:=jsonb_populate_record(NEW,jsonb_build_object(col,previous));
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_bump_version() FROM PUBLIC;
--> statement-breakpoint
-- Key 1 of two (§3.10 rule 2): a tenant administrator enables a work-job type, with ceilings. No row, or
-- enabled=false, means nobody in the tenant can delegate that job (default: none enabled). The job-type list
-- is closed in the database as well as in code (core/mandates/job-types.ts): a decision job, pay, payroll
-- close, employment status, access or anything irreversible has no value here to enable.
CREATE TABLE public.teras_mandate_job_type_enablement (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 job_type text NOT NULL CHECK (job_type IN ('team_absence_weekly_summary')),
 enabled boolean NOT NULL DEFAULT false,
 max_validity_days integer NOT NULL DEFAULT 90 CHECK (max_validity_days BETWEEN 1 AND 365),
 max_runs_per_day integer NOT NULL DEFAULT 1 CHECK (max_runs_per_day BETWEEN 1 AND 24),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,job_type)
);
--> statement-breakpoint
CREATE TRIGGER teras_mandate_job_type_enablement_version BEFORE UPDATE ON public.teras_mandate_job_type_enablement
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- The tenant-wide stop switch (§3.10 rule 7). No row means not stopped; a stopped tenant runs no mandate.
CREATE TABLE public.teras_mandate_control (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 stopped boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER teras_mandate_control_version BEFORE UPDATE ON public.teras_mandate_control
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- A work-job mandate: one person's explicit, limited, revocable grant. One agent identity per mandate
-- (agent_identity_id), shown as acting FOR the grantor. Scope, limits, schedule and notification choice are
-- fixed at grant; changing them means revoking and granting again. Only revocation and renewal change a row,
-- and each bumps `version` (guarded below).
CREATE TABLE public.teras_mandate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 job_type text NOT NULL CHECK (job_type IN ('team_absence_weekly_summary')),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 grantor_user_id uuid NOT NULL REFERENCES public.app_user(id),
 grantor_person_id uuid NOT NULL REFERENCES public.person(id),
 agent_identity_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object'),
 limits jsonb NOT NULL CHECK (jsonb_typeof(limits)='object'),
 schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule)='object'),
 notify text NOT NULL CHECK (notify IN ('each_action','daily_summary')),
 valid_from timestamptz NOT NULL,
 valid_until timestamptz NOT NULL,
 revoked_at timestamptz,
 revoked_by_user_id uuid REFERENCES public.app_user(id),
 revoked_by text CHECK (revoked_by IN ('grantor','administrator')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,id),
 CHECK (valid_until>valid_from),
 CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL) AND (revoked_at IS NULL)=(revoked_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX teras_mandate_grantor_idx ON public.teras_mandate(tenant_id,grantor_user_id);
--> statement-breakpoint
CREATE FUNCTION app.teras_mandate_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A mandate is revoked, never deleted' USING ERRCODE='42501';END IF;
 IF OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'A revoked mandate is final' USING ERRCODE='42501';END IF;
 IF (to_jsonb(NEW)-'version'-'valid_until'-'revoked_at'-'revoked_by_user_id'-'revoked_by')
   IS DISTINCT FROM (to_jsonb(OLD)-'version'-'valid_until'-'revoked_at'-'revoked_by_user_id'-'revoked_by') THEN
  RAISE EXCEPTION 'Only revocation and renewal change a mandate' USING ERRCODE='42501';
 END IF;
 IF NEW.revoked_at IS NOT NULL THEN
  IF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN RAISE EXCEPTION 'Revocation cannot also renew' USING ERRCODE='42501';END IF;
  -- Owner connections carry no login; a login revokes only as itself.
  IF app.current_user_id() IS NOT NULL AND NEW.revoked_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Revocation is attributed to the caller' USING ERRCODE='42501';END IF;
  IF NEW.revoked_by='grantor' AND NEW.revoked_by_user_id IS DISTINCT FROM OLD.grantor_user_id THEN
   RAISE EXCEPTION 'Only the grantor revokes as grantor' USING ERRCODE='42501';END IF;
  IF NEW.revoked_by='administrator' AND app.current_user_id() IS NOT NULL AND app.is_group_admin() IS NOT TRUE THEN
   RAISE EXCEPTION 'Only an administrator revokes as administrator' USING ERRCODE='42501';END IF;
 ELSIF NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
  IF app.current_user_id() IS NOT NULL AND app.current_user_id() IS DISTINCT FROM OLD.grantor_user_id THEN
   RAISE EXCEPTION 'Only the grantor renews a mandate' USING ERRCODE='42501';END IF;
  -- The hard ceiling; the tenant's own ceiling (enablement.max_validity_days) is enforced in code.
  IF OLD.valid_until<=now() OR NEW.valid_until<=now() OR NEW.valid_until>now()+interval '365 days' THEN
   RAISE EXCEPTION 'A mandate renews only while valid, for at most a year' USING ERRCODE='42501';END IF;
 ELSE
  RETURN OLD;
 END IF;
 NEW.version:=OLD.version+1;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_mandate_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_mandate_guard BEFORE UPDATE OR DELETE ON public.teras_mandate
 FOR EACH ROW EXECUTE FUNCTION app.teras_mandate_guard();
--> statement-breakpoint
-- The outcome record (§3.11 and §11.3 change 5): one row per AI run. It holds references, names, versions,
-- counts and verdicts, never HR data, question text or reply text; the data stays in its native owners.
-- Append-only like domain_event (ADR-0030): no UPDATE, DELETE or TRUNCATE privilege, and a trigger that
-- refuses UPDATE and DELETE for every role including the owner. TRUNCATE stays an owner-only operation (no
-- privilege for the app role), as for domain_event, so tenant teardown and fixture resets still cascade. Retention follows audit retention: rows are
-- kept with the audit trail; any future purge is an explicit, logged owner migration. Erasure: a row names
-- people only by internal ids, so erasing a person's data in its native owner (core/pdpa.ts) leaves an
-- opaque reference here and nothing to erase.
CREATE TABLE public.teras_outcome_record (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid REFERENCES public.company(id),
 run_id uuid NOT NULL,
 run_kind text NOT NULL CHECK (run_kind IN ('turn','mandate_run')),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 authority_kind text NOT NULL CHECK (authority_kind IN ('person','mandate')),
 asked_by_user_id uuid REFERENCES public.app_user(id),
 mandate_id uuid,
 mandate_version integer,
 grantor_user_id uuid REFERENCES public.app_user(id),
 agent_identity text NOT NULL CHECK (agent_identity ~ '^[a-z0-9_.:-]{1,120}$'),
 reads jsonb NOT NULL CHECK (jsonb_typeof(reads)='array'),
 checks jsonb NOT NULL CHECK (jsonb_typeof(checks)='array'),
 replay jsonb NOT NULL CHECK (jsonb_typeof(replay)='object'),
 outcome_kind text NOT NULL CHECK (outcome_kind IN ('answered','suggested','prepared','done','fallback','refused','stopped')),
 outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome)='object'),
 human_involvement text NOT NULL CHECK (human_involvement IN ('none','reviewed','decided')),
 notice text NOT NULL CHECK (notice IN ('not_applicable','given','not_given')),
 trace jsonb CHECK (trace IS NULL OR jsonb_typeof(trace)='object'),
 UNIQUE (tenant_id,run_id),
 UNIQUE (tenant_id,id),
 FOREIGN KEY (tenant_id,mandate_id) REFERENCES public.teras_mandate(tenant_id,id),
 CHECK (finished_at>=started_at),
 CHECK ((authority_kind='person' AND asked_by_user_id IS NOT NULL AND mandate_id IS NULL AND mandate_version IS NULL AND grantor_user_id IS NULL)
   OR (authority_kind='mandate' AND asked_by_user_id IS NULL AND mandate_id IS NOT NULL AND mandate_version>=1 AND grantor_user_id IS NOT NULL
    AND run_kind='mandate_run'))
);
--> statement-breakpoint
CREATE INDEX teras_outcome_record_mandate_idx ON public.teras_outcome_record(tenant_id,mandate_id,started_at) WHERE mandate_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX teras_outcome_record_asker_idx ON public.teras_outcome_record(tenant_id,asked_by_user_id,started_at) WHERE asked_by_user_id IS NOT NULL;
--> statement-breakpoint
-- What happened after the run: the person's decision, a mandate's automatic completion (decision jobs only,
-- step 5b; work jobs never write one), an undo, or notice given to the affected person. Append-only too.
CREATE TABLE public.teras_outcome_followup (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 record_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('decision','mandate_completion','undo','notice')),
 decision text CHECK (decision IN ('accepted','rejected','completed','undone')),
 human_involvement text NOT NULL CHECK (human_involvement IN ('none','reviewed','decided')),
 notice text CHECK (notice IN ('not_applicable','given','not_given')),
 notice_channel text CHECK (notice_channel IN ('in_app','email')),
 by_user_id uuid REFERENCES public.app_user(id),
 reference jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reference)='object'),
 at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,record_id) REFERENCES public.teras_outcome_record(tenant_id,id),
 CHECK ((kind='decision' AND decision IN ('accepted','rejected') AND by_user_id IS NOT NULL)
   OR (kind='mandate_completion' AND decision='completed' AND by_user_id IS NULL)
   OR (kind='undo' AND decision='undone' AND by_user_id IS NOT NULL)
   OR (kind='notice' AND decision IS NULL AND notice IS NOT NULL)),
 CHECK ((notice='given')=(notice_channel IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX teras_outcome_followup_record_idx ON public.teras_outcome_followup(tenant_id,record_id);
--> statement-breakpoint
CREATE FUNCTION app.teras_outcome_append_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'The outcome record is append-only' USING ERRCODE='42501'; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_outcome_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_outcome_record_append_only BEFORE UPDATE OR DELETE ON public.teras_outcome_record
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
CREATE TRIGGER teras_outcome_followup_append_only BEFORE UPDATE OR DELETE ON public.teras_outcome_followup
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- Task memory (ADR-0170 §3.3) behind the step 1 storage interface: one row per (tenant, login,
-- conversation). Only that login reads or writes it; an agent context never does. Advisory, never HR truth.
CREATE TABLE public.teras_task_memory (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 app_user_id uuid NOT NULL REFERENCES public.app_user(id),
 conversation_id text NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 200),
 memory jsonb NOT NULL CHECK (jsonb_typeof(memory)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,app_user_id,conversation_id)
);
--> statement-breakpoint
-- Erased with the transcript: retiring (or deleting) any of a login's Assistant exchanges erases that
-- login's task memory, whichever path retired them (own erasure, review redaction or retention expiry).
-- Exchanges carry no conversation id, so erasure is per login: it may drop more memory than the exchange
-- retired, never less.
CREATE FUNCTION app.teras_task_memory_erased_with_transcript() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_ public.assistant_exchange%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN row_:=OLD;ELSE row_:=NEW;END IF;
 IF row_.app_user_id IS NOT NULL THEN
  DELETE FROM public.teras_task_memory m WHERE m.tenant_id=row_.tenant_id AND m.app_user_id=row_.app_user_id;
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_task_memory_erased_with_transcript() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_task_memory_transcript_retired AFTER UPDATE OF content_retired_at ON public.assistant_exchange
 FOR EACH ROW WHEN (OLD.content_retired_at IS NULL AND NEW.content_retired_at IS NOT NULL)
 EXECUTE FUNCTION app.teras_task_memory_erased_with_transcript();
--> statement-breakpoint
CREATE TRIGGER teras_task_memory_transcript_deleted AFTER DELETE ON public.assistant_exchange
 FOR EACH ROW EXECUTE FUNCTION app.teras_task_memory_erased_with_transcript();
--> statement-breakpoint
-- ── RLS ──
ALTER TABLE public.teras_mandate_job_type_enablement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_mandate_control ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_mandate ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_outcome_record ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_outcome_followup ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_task_memory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Enablement and the stop switch: readable in the tenant (a person sees what can be delegated; the agent
-- checks both keys), written only by a current group administrator.
CREATE POLICY teras_job_type_read ON public.teras_mandate_job_type_enablement FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_job_type_admin_insert ON public.teras_mandate_job_type_enablement FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_job_type_admin_update ON public.teras_mandate_job_type_enablement FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_control_read ON public.teras_mandate_control FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_control_admin_insert ON public.teras_mandate_control FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_control_admin_update ON public.teras_mandate_control FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
-- Mandates: the grantor and group administrators read them; the agent principal reads them to run. A person
-- grants only as themself, only while both keys are open; the stop switch closes granting as well.
CREATE POLICY teras_mandate_read ON public.teras_mandate FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND (app.current_agent_principal() IS NOT NULL
  OR (app.current_user_id() IS NOT NULL AND (grantor_user_id=app.current_user_id() OR app.is_group_admin()))));
--> statement-breakpoint
CREATE POLICY teras_mandate_grant ON public.teras_mandate FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL
  AND grantor_user_id=app.current_user_id() AND app.principal_snapshot_current() IS TRUE
  AND revoked_at IS NULL AND version=1 AND valid_until<=valid_from+interval '365 days'
  AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.id=teras_mandate.grantor_user_id AND u.tenant_id=teras_mandate.tenant_id
   AND u.person_id=teras_mandate.grantor_person_id AND u.archived_at IS NULL)
  AND EXISTS (SELECT 1 FROM public.teras_mandate_job_type_enablement k WHERE k.tenant_id=app.current_tenant_id() AND k.job_type=teras_mandate.job_type AND k.enabled)
  AND NOT EXISTS (SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.stopped));
--> statement-breakpoint
CREATE POLICY teras_mandate_change ON public.teras_mandate FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND (grantor_user_id=app.current_user_id() OR app.is_group_admin()))
 WITH CHECK (tenant_id=app.current_tenant_id());
--> statement-breakpoint
-- Outcome records: a person writes one only for their own turn; the agent principal writes one only for a
-- mandate run naming that mandate's current version, grantor and agent identity. Readers: the person who
-- asked, the grantor, group administrators, and the agent for mandate runs (it counts its own runs).
CREATE POLICY teras_outcome_record_insert ON public.teras_outcome_record FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND (
  (authority_kind='person' AND app.current_agent_principal() IS NULL AND asked_by_user_id=app.current_user_id())
  OR (authority_kind='mandate' AND app.current_agent_principal() IS NOT NULL AND EXISTS (
   SELECT 1 FROM public.teras_mandate m WHERE m.tenant_id=app.current_tenant_id() AND m.id=teras_outcome_record.mandate_id
    AND m.version=teras_outcome_record.mandate_version AND m.grantor_user_id=teras_outcome_record.grantor_user_id
    AND teras_outcome_record.agent_identity='mandate-agent:'||m.agent_identity_id::text))));
--> statement-breakpoint
CREATE POLICY teras_outcome_record_read ON public.teras_outcome_record FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND (
  (app.current_agent_principal() IS NOT NULL AND authority_kind='mandate')
  OR (app.current_user_id() IS NOT NULL AND (asked_by_user_id=app.current_user_id() OR grantor_user_id=app.current_user_id() OR app.is_group_admin()))));
--> statement-breakpoint
CREATE POLICY teras_outcome_followup_insert ON public.teras_outcome_followup FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND by_user_id=app.current_user_id()
  AND kind<>'mandate_completion'
  AND EXISTS (SELECT 1 FROM public.teras_outcome_record r WHERE r.tenant_id=app.current_tenant_id() AND r.id=teras_outcome_followup.record_id
   AND (r.asked_by_user_id=app.current_user_id() OR r.grantor_user_id=app.current_user_id() OR app.is_group_admin())));
--> statement-breakpoint
CREATE POLICY teras_outcome_followup_read ON public.teras_outcome_followup FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.teras_outcome_record r
  WHERE r.tenant_id=app.current_tenant_id() AND r.id=teras_outcome_followup.record_id));
--> statement-breakpoint
CREATE POLICY teras_task_memory_own ON public.teras_task_memory FOR ALL TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id())
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app_user_id=app.current_user_id());
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.teras_mandate_job_type_enablement,public.teras_mandate_control,public.teras_mandate,
 public.teras_outcome_record,public.teras_outcome_followup,public.teras_task_memory FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_mandate_job_type_enablement,public.teras_mandate_control,public.teras_mandate TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_outcome_record,public.teras_outcome_followup TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON public.teras_task_memory TO ai_hr_app;
