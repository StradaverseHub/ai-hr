-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5031_leave_ledger_stage, idx 4431, when 1793330004731.
-- Draft name on its branch: 9901_leave_ledger_stage. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110 (leave family on the shared bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9901, when 1793330099901) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Requires 5011 (bulk_job).
--
-- STAGED LEAVE LEDGER ROWS. A leave operation that used to be ONE transaction (all-or-nothing) now runs in batches
-- of employees on the job kernel. Its batches write their ledger rows STAGED: invisible to every other session until
-- the job releases them all at once, so a failure part-way leaves nothing visible, exactly as the old transaction's
-- rollback did. Same shape as the staged employee import (5010/5012): a marker column, a restrictive policy, and a
-- constant-time release row.
--  * leave_ledger.stage_id  NULL for every ordinary row. A transaction that sets app.leave_stage (transaction-local)
--    stamps its inserts with that stage; the job's own transactions list their stages in app.leave_stage_visible.
--  * app.leave_stage_release  one row per released stage. Release is that one insert (constant time, under the
--    job's re-checked authority and the subjects' locks), so every reader sees the whole run at the same instant.
--    The worker then clears the markers in bounded batches ("settle"), which changes nothing anyone can see, and
--    deletes the release row.
--  * Discard deletes the stage's rows in bounded batches on the queue-owner connection. They were never visible.
-- The five SECURITY DEFINER readers of leave_ledger (own_earned_credit_actors, record_leave_payroll_effect,
-- employment_void_blockers and two Assistant review verifiers) read TOIL credits by id, debits by request, or count
-- rows to refuse a void; none of them reads a row a cohort writer stages as a balance, and a staged row counting as
-- a void blocker is the conservative answer. They are unchanged.
ALTER TABLE public.leave_ledger ADD COLUMN stage_id uuid;
--> statement-breakpoint
CREATE INDEX leave_ledger_stage_idx ON public.leave_ledger(tenant_id,stage_id) WHERE stage_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE app.leave_stage_release (
 stage_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 job_id uuid NOT NULL REFERENCES public.bulk_job(id) ON DELETE CASCADE,
 released_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX leave_stage_release_tenant ON app.leave_stage_release(tenant_id);
--> statement-breakpoint
REVOKE ALL ON app.leave_stage_release FROM PUBLIC;
--> statement-breakpoint
-- The current tenant's released stages, for the policy (an InitPlan evaluated only for a row that carries a marker).
CREATE FUNCTION app.leave_stage_released_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(r.stage_id),'{}'::uuid[]) FROM app.leave_stage_release r WHERE r.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.leave_stage_released_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.leave_stage_released_ids() TO ai_hr_app;
--> statement-breakpoint
-- Release: the job's own fenced transaction (the creator's authority, the bulk_job row visible to it) records the
-- stage as released. Refuses a stage of another job, tenant or creator.
CREATE FUNCTION app.leave_stage_release(p_job uuid,p_stage uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.bulk_job_access(p_job) THEN RAISE EXCEPTION 'Leave stage release denied' USING ERRCODE='42501'; END IF;
 INSERT INTO app.leave_stage_release(stage_id,tenant_id,job_id) VALUES(p_stage,app.current_tenant_id(),p_job) ON CONFLICT(stage_id) DO NOTHING;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.leave_stage_release(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.leave_stage_release(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.leave_ledger_stage_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.stage_id IS NULL THEN NEW.stage_id:=nullif(current_setting('app.leave_stage',true),'')::uuid; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.leave_ledger_stage_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER leave_ledger_stage_stamp BEFORE INSERT ON public.leave_ledger FOR EACH ROW EXECUTE FUNCTION app.leave_ledger_stage_stamp();
--> statement-breakpoint
CREATE POLICY leave_ledger_stage_hidden ON public.leave_ledger AS RESTRICTIVE FOR ALL TO ai_hr_app
 USING (stage_id IS NULL OR stage_id::text = ANY(string_to_array(current_setting('app.leave_stage_visible',true),','))
  OR stage_id = ANY((SELECT app.leave_stage_released_ids())::uuid[]))
 WITH CHECK (stage_id IS NULL OR stage_id::text = ANY(string_to_array(current_setting('app.leave_stage_visible',true),',')));
