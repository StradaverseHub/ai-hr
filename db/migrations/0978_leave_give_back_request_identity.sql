-- Give-back requests originate with the employee and retain their nominated source.
CREATE FUNCTION app.leave_give_back_request_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NEW; END IF;

 IF TG_OP='INSERT' THEN
  IF NEW.status='pending' AND NEW.decided_by_employment_id IS NULL AND NEW.decided_at IS NULL
   AND app.principal_snapshot_current()
   AND EXISTS (
    SELECT FROM public.leave_request source
    JOIN public.employment subject ON subject.tenant_id=source.tenant_id AND subject.id=source.employment_id
    WHERE source.tenant_id=app.current_tenant_id() AND source.tenant_id=NEW.tenant_id
     AND source.id=NEW.leave_request_id AND source.employment_id=NEW.employment_id
     AND source.status='approved' AND app.is_self_person(subject.person_id)
   ) THEN RETURN NEW; END IF;
 ELSIF (to_jsonb(NEW)-ARRAY['status','decided_by_employment_id','decided_at'])
       IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decided_by_employment_id','decided_at']) THEN
  RETURN NEW;
 END IF;

 RAISE EXCEPTION 'Leave give-back source identity unavailable' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION app.leave_give_back_request_identity_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER aaa_leave_give_back_request_identity BEFORE INSERT OR UPDATE ON public.leave_cancellation_request
 FOR EACH ROW EXECUTE FUNCTION app.leave_give_back_request_identity_guard();
