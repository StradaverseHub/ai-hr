-- Owner decision, 9 November 2026: missed clock-outs prepare human-review cards only.
-- Preserve historical configurations and every action/decision. Effective level is authoritative;
-- old stored Act rows cannot execute, and safe unchanged-level metadata/stop operations remain possible.
CREATE OR REPLACE FUNCTION app.teras_loop_level_of(p_worker text,p_company uuid) RETURNS smallint
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_worker='loop_missed_clock_outs' THEN least(coalesce((SELECT l.level FROM public.teras_loop_level l
  WHERE l.tenant_id=app.current_tenant_id() AND l.worker_id=p_worker AND l.company_id=p_company),1::smallint),1::smallint)
 ELSE coalesce((SELECT l.level FROM public.teras_loop_level l WHERE l.tenant_id=app.current_tenant_id()
  AND l.worker_id=p_worker AND l.company_id=p_company),1::smallint) END
$$;
--> statement-breakpoint
CREATE FUNCTION app.teras_clock_out_review_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.worker_id='loop_missed_clock_outs' AND NEW.level>1 THEN
  IF TG_OP='INSERT' THEN
   RAISE EXCEPTION 'Missed clock-outs require human approval and stay at Prepare' USING ERRCODE='42501';
  ELSIF NEW.level>OLD.level OR NEW.max_actions_per_night>OLD.max_actions_per_night
    OR NEW.undo_days<OLD.undo_days OR NEW.act_condition IS DISTINCT FROM OLD.act_condition THEN
   RAISE EXCEPTION 'Missed clock-outs require human approval and stay at Prepare' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_clock_out_review_only_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_clock_out_review_only_guard BEFORE INSERT OR UPDATE ON public.teras_loop_level
FOR EACH ROW EXECUTE FUNCTION app.teras_clock_out_review_only_guard();
--> statement-breakpoint
-- The retired attribution can still describe historical records; it cannot authorise a new
-- automatic application or compensation. Run after the original attribution stamp on INSERT only.
CREATE FUNCTION app.teras_clock_out_correction_review_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.agent_worker_id='loop_missed_clock_outs' THEN
  RAISE EXCEPTION 'A missed clock-out correction requires a new human review' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_clock_out_correction_review_only_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER b_teras_clock_out_correction_review_only_guard BEFORE INSERT ON public.attendance_correction
FOR EACH ROW EXECUTE FUNCTION app.teras_clock_out_correction_review_only_guard();
--> statement-breakpoint
CREATE FUNCTION app.teras_clock_out_undo_review_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.teras_loop_action a WHERE a.id=NEW.action_id AND a.tenant_id=NEW.tenant_id
   AND a.worker_id='loop_missed_clock_outs') THEN
  RAISE EXCEPTION 'A historical missed clock-out action requires a new human review' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_clock_out_undo_review_only_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_clock_out_undo_review_only_guard BEFORE INSERT ON public.teras_loop_action_undo
FOR EACH ROW EXECUTE FUNCTION app.teras_clock_out_undo_review_only_guard();
