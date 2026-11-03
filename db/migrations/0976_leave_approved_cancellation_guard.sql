-- Whole-record cancellation changes only status. The existing give-back owner
-- resegments the request and assigns a fresh parent group.
CREATE FUNCTION app.leave_approved_cancellation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_storage_owner()
 AND NEW.parent_group_id IS NOT DISTINCT FROM OLD.parent_group_id
 AND (NOT app.leave_employee_record_cancel_allowed(OLD.id)
      OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')) THEN
  RAISE EXCEPTION 'Approved Leave cancellation source unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.leave_approved_cancellation_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aaa_leave_approved_cancellation BEFORE UPDATE ON public.leave_request
 FOR EACH ROW WHEN (OLD.status='approved' AND NEW.status='cancelled')
 EXECUTE FUNCTION app.leave_approved_cancellation_guard();
