-- Board 8cff7fef: payment method is an employment-effective fact, independent of pay mode and frequency.
CREATE TABLE public.employment_payment_method_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 employment_id uuid NOT NULL REFERENCES public.employment(id),
 effective_on date NOT NULL,
 payment_method text CHECK(payment_method IN ('bank_transfer','cheque','cash')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 recorded_by uuid REFERENCES public.app_user(id),
 superseded_at timestamptz,
 source text NOT NULL CHECK(source IN ('legacy_snapshot','maintenance','movement')),
 CONSTRAINT employment_payment_method_history_employment_tenant_fk
  FOREIGN KEY(employment_id,tenant_id) REFERENCES public.employment(id,tenant_id),
 CONSTRAINT employment_payment_method_history_actor_tenant_fk
  FOREIGN KEY(recorded_by,tenant_id) REFERENCES public.app_user(id,tenant_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX employment_payment_method_history_effective_uq
 ON public.employment_payment_method_history(employment_id,effective_on) WHERE superseded_at IS NULL;
--> statement-breakpoint
CREATE INDEX employment_payment_method_history_date_idx
 ON public.employment_payment_method_history(tenant_id,employment_id,effective_on DESC) WHERE superseded_at IS NULL;
--> statement-breakpoint
-- The old field has no reliable effective date. Record only what is known on this installation day.
INSERT INTO public.employment_payment_method_history(tenant_id,employment_id,effective_on,payment_method,source)
 SELECT tenant_id,id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,payment_method,'legacy_snapshot'
 FROM public.employment WHERE payment_method IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.employment_payment_method_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.employment_payment_method_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employment_payment_method_history_owner ON public.employment_payment_method_history
 FOR ALL USING(current_user<>'ai_hr_app') WITH CHECK(current_user<>'ai_hr_app');
--> statement-breakpoint
CREATE POLICY employment_payment_method_history_read ON public.employment_payment_method_history FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND (app.can_admin_employment(employment_id) OR EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=employment_id AND app.is_self_person(e.person_id))));
--> statement-breakpoint
CREATE POLICY employment_payment_method_history_write ON public.employment_payment_method_history FOR ALL
 USING(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
  AND app.access_workforce_employment(employment_id,'workforce.maintain'))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
  AND app.access_workforce_employment(employment_id,'workforce.maintain'));
--> statement-breakpoint
REVOKE ALL ON public.employment_payment_method_history FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.employment_payment_method_history TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.employment_payment_method_on(wanted uuid,wanted_date date) RETURNS text
LANGUAGE sql STABLE SET search_path TO pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.employment_payment_method_history h
   WHERE h.employment_id=wanted AND h.tenant_id=app.current_tenant_id()) THEN
  (SELECT h.payment_method FROM public.employment_payment_method_history h
   WHERE h.employment_id=wanted AND h.tenant_id=app.current_tenant_id() AND h.superseded_at IS NULL
    AND h.effective_on<=wanted_date ORDER BY h.effective_on DESC LIMIT 1)
 ELSE (SELECT e.payment_method FROM public.employment e WHERE e.id=wanted AND e.tenant_id=app.current_tenant_id()) END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employment_payment_method_on(uuid,date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employment_payment_method_on(uuid,date) TO ai_hr_app;
