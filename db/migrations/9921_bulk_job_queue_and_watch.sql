-- UNALLOCATED DRAFT on branch claude/bulkjob-roster-20261110 (assigned draft range 9920-9929): not a reservation, not an
-- installation allocation. The journal position (idx 9921, when 1793330099921) exists only so this branch's schema is
-- executable and reviewable; the integration owner assigns the final tag/idx/when per docs/MIGRATION-ALLOCATION.md.
--
-- KERNEL EXTENSION (shared bulk-job kernel, 9003; to be reconciled at integration with the other kernel clients):
--  1. Exclusivity 'tenant_queue': one job of the kind RUNS at a time per tenant, but a later one is always admitted
--     and waits in 'queued' until every earlier active job of its kind has ended; the worker then starts it by
--     itself (core/bulk-job-worker.ts claim). No admission is refused, so a second administrator never sees a
--     "busy" refusal. app.bulk_job_waiting tells the creator's screen that its own job is waiting behind another.
--  2. bulk_job.watched_at: the creator's progress screen stamps it while it polls, so a short job the creator
--     watched to its end can skip its completion notice (BulkJobHandler.quietNotice).
-- Roster bulk operations and Schedule Group bulk assignment move from 'tenant' to 'tenant_queue'.
ALTER TABLE bulk_job_kind DROP CONSTRAINT bulk_job_kind_exclusive_check;
--> statement-breakpoint
ALTER TABLE bulk_job_kind ADD CONSTRAINT bulk_job_kind_exclusive_check CHECK (exclusive IN ('tenant','creator','tenant_queue'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.bulk_job_admit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mode text;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Bulk job access denied' USING ERRCODE='42501';END IF;
 SELECT k.exclusive INTO mode FROM public.bulk_job_kind k WHERE k.kind=NEW.kind;
 IF mode IS NULL THEN RAISE EXCEPTION 'Unknown bulk job kind' USING ERRCODE='22023';END IF;
 NEW.context:=jsonb_build_object('tenantId',app.current_tenant_id(),'userId',app.current_user_id(),
  'roles',to_jsonb(app.current_roles()),'grants',coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb));
 -- A queued kind's key is the job's own id, so bulk_job_one_active never refuses it; the worker serialises instead.
 NEW.exclusive_key:=CASE mode WHEN 'tenant' THEN 'tenant' WHEN 'tenant_queue' THEN 'queue:'||NEW.id::text ELSE NEW.created_by::text END;
 NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
 NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;NEW.watched_at:=NULL;
 RETURN NEW;
END $$;
--> statement-breakpoint
ALTER TABLE bulk_job ADD COLUMN watched_at timestamptz;
--> statement-breakpoint
GRANT UPDATE(watched_at) ON bulk_job TO ai_hr_app;
--> statement-breakpoint
UPDATE bulk_job_kind SET exclusive='tenant_queue' WHERE kind IN ('roster_bulk','schedule_group_bulk');
--> statement-breakpoint
-- Whether the caller's own queued job of a queued kind waits behind an earlier active job of its kind (any creator).
-- Reveals one boolean about the caller's own job and nothing about the other job.
CREATE FUNCTION app.bulk_job_waiting(p_job uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.bulk_job j
  JOIN public.bulk_job_kind k ON k.kind=j.kind AND k.exclusive='tenant_queue'
  WHERE j.id=p_job AND j.state='queued' AND app.bulk_job_access(j.id)
   AND EXISTS(SELECT 1 FROM public.bulk_job o WHERE o.tenant_id=j.tenant_id AND o.kind=j.kind AND o.id<>j.id
    AND o.state IN ('queued','preparing','running','finalizing','discarding') AND (o.created_at,o.id)<(j.created_at,j.id)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_waiting(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bulk_job_waiting(uuid) TO ai_hr_app;
