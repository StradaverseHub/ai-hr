-- UNALLOCATED DRAFT on branch claude/bulkjob-leave-20261110: not a reservation, not an installation allocation. The
-- journal position (idx 9902, when 1793330099902) exists only so this branch's schema is executable and reviewable;
-- the integration owner assigns the final tag/idx/when, per docs/MIGRATION-ALLOCATION.md. Requires 9003.
--
-- KERNEL EXTENSION (shared with every bulk-job kind; note for integration). bulk_job_kind.exclusive gains 'none':
-- no one-active-job rule, so one person may have several active jobs of the kind at once. Used by follow-up work a
-- save starts and must never refuse (entitlement recalculation after a leave-type or table save; the A2C
-- re-projection after a Leave Year Type save): a second save while the first job still runs must queue a second
-- job, not fail the save as busy. Each such job re-reads the committed configuration per step and is idempotent,
-- so two of them converge. 'tenant' and 'creator' are unchanged: the admission trigger still derives the key, so
-- no writer can opt out of its kind's rule. With 'none' the key is the job's own id, which the partial unique index
-- bulk_job_one_active can never collide on.
ALTER TABLE public.bulk_job_kind DROP CONSTRAINT bulk_job_kind_exclusive_check;
--> statement-breakpoint
ALTER TABLE public.bulk_job_kind ADD CONSTRAINT bulk_job_kind_exclusive_check CHECK (exclusive IN ('tenant','creator','none'));
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
 IF NEW.id IS NULL THEN NEW.id:=gen_random_uuid(); END IF;
 NEW.exclusive_key:=CASE mode WHEN 'tenant' THEN 'tenant' WHEN 'creator' THEN NEW.created_by::text ELSE 'job:'||NEW.id::text END;
 NEW.state:='queued';NEW.outcome:=NULL;NEW.lease_token:=NULL;NEW.lease_expires_at:=NULL;NEW.notice_event_id:=NULL;NEW.notified_at:=NULL;
 NEW.created_at:=now();NEW.updated_at:=now();NEW.finished_at:=NULL;
 RETURN NEW;
END $$;
