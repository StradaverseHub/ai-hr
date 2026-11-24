-- Replacement-holiday queue rows of voided employments (staging, 24 November 2026).
-- app.enqueue_replacement_holidays() (0547, last replaced by 5010) queued every employment of the changed row, voided
-- ones included. Every void is an UPDATE of employment.voided_at (the employee import Revert, the staged import
-- discard and the rehire Roll Back), so the void itself re-queued the employment it voided, and any later tenant-wide
-- change (a holiday, a shift, a company) re-queued every voided employment of the tenant. A voided employment is
-- hidden from ai_hr_app by employment_rls, so the minute sweep could never reconcile it: each row failed with
-- "Employee unavailable." and was retried every 15 minutes, forever. A void is final (employment_void_final), so the
-- row is dead work.
-- This replaces the body only: the employment's own void deletes its queue row in the void's transaction, and no
-- change queues a voided employment again. Same signature, owner, SECURITY DEFINER, search_path, triggers and
-- REVOKE. Guarded by the exact 5010 body and by its owner (it must be the migration owner, never a purpose role).
-- The replacement-holiday allocations and their revisions stay: they are the void's history, hidden with the
-- employment.
DO $source_guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.enqueue_replacement_holidays()'::regprocedure) IS DISTINCT FROM '8b857bbb04df1438c9c689e7b023cc6d4f3a4cae660f4c13f3f7dc9771675196' THEN RAISE EXCEPTION 'Expected the 5010 replacement holiday enqueue source';END IF;
 IF (SELECT o.rolname FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid='app.enqueue_replacement_holidays()'::regprocedure)<>current_user THEN RAISE EXCEPTION 'app.enqueue_replacement_holidays() must belong to the migration owner' USING ERRCODE='42501';END IF;
END;
$source_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enqueue_replacement_holidays()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE payload jsonb;tid uuid;eid uuid;
BEGIN
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 tid:=(payload->>'tenant_id')::uuid;
 IF TG_TABLE_NAME='employment' THEN eid:=(payload->>'id')::uuid;
  -- A voided employment is final and hidden from every reconciler: its queue row leaves in the void's transaction.
  IF TG_OP<>'DELETE' AND payload->>'voided_at' IS NOT NULL THEN
   DELETE FROM replacement_holiday_queue q WHERE q.tenant_id=tid AND q.employment_id=eid;
   RETURN NULL;
  END IF;
 ELSIF payload ? 'employment_id' THEN eid:=(payload->>'employment_id')::uuid;
 END IF;
 INSERT INTO replacement_holiday_queue(tenant_id,employment_id)
 SELECT e.tenant_id,e.id FROM employment e WHERE e.tenant_id=tid AND e.import_pending_attempt_id IS NULL AND e.voided_at IS NULL AND (eid IS NULL OR e.id=eid)
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET generation=replacement_holiday_queue.generation+1,requested_at=now(),claimed_at=NULL,claimed_generation=NULL;
 RETURN NULL;
END $function$;
--> statement-breakpoint
-- The rows the old body left behind: one set-based statement, the queue row only (allocations and revisions stay).
DELETE FROM replacement_holiday_queue q USING employment e WHERE e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.voided_at IS NOT NULL;
