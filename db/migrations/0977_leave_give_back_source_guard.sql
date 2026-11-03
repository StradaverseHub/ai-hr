-- A fresh split group is required for a give-back, but is not a source by itself.
CREATE OR REPLACE FUNCTION app.leave_approved_cancellation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;

 IF NEW.parent_group_id IS DISTINCT FROM OLD.parent_group_id THEN
  IF NEW.parent_group_id IS NOT NULL
   AND NEW.start_date >= OLD.start_date AND NEW.end_date <= OLD.end_date
   AND NEW.start_date <= NEW.end_date AND NEW.days > 0 AND NEW.days <= OLD.days
   AND (to_jsonb(NEW)-ARRAY['status','start_date','end_date','days','parent_group_id'])
     IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','start_date','end_date','days','parent_group_id'])
   AND EXISTS (
    SELECT FROM public.leave_cancellation_request request
    WHERE request.tenant_id=OLD.tenant_id AND request.leave_request_id=OLD.id
     AND request.employment_id=OLD.employment_id AND request.status='pending'
     AND request.requested_days >= NEW.days
     AND request.cancel_dates ? NEW.start_date::text
     AND request.cancel_dates ? NEW.end_date::text
     AND NOT EXISTS (
      SELECT FROM public.leave_cancellation_step step
      WHERE step.tenant_id=request.tenant_id AND step.cancellation_request_id=request.id
       AND step.status<>'approved'
     )
   ) THEN RETURN NEW; END IF;
 ELSIF app.leave_employee_record_cancel_allowed(OLD.id)
  AND (to_jsonb(NEW)-'status') IS NOT DISTINCT FROM (to_jsonb(OLD)-'status') THEN
  RETURN NEW;
 END IF;

 RAISE EXCEPTION 'Approved Leave cancellation source unavailable' USING ERRCODE='42501';
END $$;
