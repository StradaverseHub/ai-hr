-- Fixed SECURITY DEFINER ports own employee and assigned changes. An invoker
-- trigger keeps those bounded commands separate from direct APP table writes.
CREATE FUNCTION app.lifecycle_offboarding_write_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE operation text;
BEGIN
 IF current_user<>'ai_hr_app' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='lc_v9_case' THEN
  operation:=CASE WHEN TG_OP='INSERT' THEN 'add'
   WHEN OLD.data->>'state' IS DISTINCT FROM 'cancelled' AND NEW.data->>'state'='cancelled' THEN 'delete'
   ELSE 'edit' END;
  IF TG_OP='UPDATE' AND NOT app.lifecycle_reward_notice_action('lifecycle',operation,OLD.company_id) THEN
   RAISE EXCEPTION 'Offboarding action unavailable in the original company' USING ERRCODE='42501';
  END IF;
 ELSE
  operation:='edit';
 END IF;
 IF NOT app.lifecycle_reward_notice_action('lifecycle',operation,NEW.company_id) THEN
  RAISE EXCEPTION 'Lifecycle administration action unavailable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_offboarding_write_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lifecycle_offboarding_action BEFORE INSERT OR UPDATE ON public.lc_v9_case
 FOR EACH ROW EXECUTE FUNCTION app.lifecycle_offboarding_write_guard();
CREATE TRIGGER lifecycle_case_file_action BEFORE INSERT ON public.lc_v9_file
 FOR EACH ROW EXECUTE FUNCTION app.lifecycle_offboarding_write_guard();
