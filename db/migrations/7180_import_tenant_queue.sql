-- Queue additional submissions under the existing tenant/kind worker ordering.
-- Preserve existing active rows and creator-scoped operation keys.
DO $migration$
DECLARE changed integer;
BEGIN
 UPDATE public.bulk_job_kind SET exclusive='tenant_queue'
 WHERE kind IN ('employee_import','clocking_import','system_label_import','reward_person_history')
   AND exclusive='tenant';
 GET DIAGNOSTICS changed = ROW_COUNT;
 IF changed <> 4 THEN
  RAISE EXCEPTION 'Unexpected import job admission configuration' USING ERRCODE='55000';
 END IF;
END;
$migration$;
--> statement-breakpoint
CREATE FUNCTION app.bulk_job_order_queued_import() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE newest timestamptz;
BEGIN
 -- bulk_job_enqueue holds the tenant/kind admission lock before reaching this trigger.
 -- Transaction start time can predate an already submitted job. Assign an order here,
 -- after admission is serialized, so a late commit cannot jump an active import.
 SELECT max(j.created_at) INTO newest FROM public.bulk_job j
 WHERE j.tenant_id=NEW.tenant_id AND j.kind=NEW.kind
   AND j.state IN ('queued','preparing','running','finalizing','discarding');
 NEW.created_at:=greatest(clock_timestamp(),newest+interval '1 microsecond');
 NEW.updated_at:=NEW.created_at;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bulk_job_order_queued_import() FROM PUBLIC;
--> statement-breakpoint
-- PostgreSQL runs BEFORE INSERT triggers by name. The canonical admission trigger runs first.
CREATE TRIGGER bulk_job_order_queued_import BEFORE INSERT ON public.bulk_job
 FOR EACH ROW WHEN (NEW.kind IN ('employee_import','clocking_import','system_label_import','reward_person_history'))
 EXECUTE FUNCTION app.bulk_job_order_queued_import();
