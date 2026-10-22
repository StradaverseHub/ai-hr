-- Private, unsubmitted input; Payroll still consumes only the canonical employee_tp3 projection.
-- Reserved Board2@1791900000067. Register only with the ascending 0576-0586 union.
CREATE TABLE public.employee_tp3_draft (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 person_id uuid NOT NULL REFERENCES public.person(id),employment_id uuid NOT NULL REFERENCES public.employment(id),
 assessment_year integer NOT NULL,baseline_revision text NOT NULL DEFAULT 'absent' CHECK(baseline_revision='absent'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),deduction_month smallint CHECK(deduction_month BETWEEN 1 AND 12),
 previous_employers jsonb NOT NULL,payload jsonb NOT NULL,declaration_accepted boolean NOT NULL DEFAULT false,
 canonical_id uuid, -- retained submission reference survives an authorized HR deletion of the mastersubmitted_at timestamptz,commit_xid xid8,
 projection_finished boolean NOT NULL DEFAULT false,projection_outcome jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT employee_tp3_draft_person_year_uq UNIQUE(tenant_id,person_id,assessment_year),
 CHECK((submitted_at IS NULL AND canonical_id IS NULL AND commit_xid IS NULL AND NOT projection_finished)
   OR(submitted_at IS NOT NULL AND canonical_id IS NOT NULL AND commit_xid IS NOT NULL)),
 CHECK(jsonb_typeof(previous_employers)='array' AND jsonb_typeof(payload)='object' AND NOT payload ? 'remarks')
);
ALTER TABLE public.employee_tp3_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_tp3_draft FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.employee_tp3_draft FROM PUBLIC,ai_hr_app;
GRANT SELECT ON public.employee_tp3_draft TO ai_hr_app;
CREATE POLICY employee_tp3_draft_owner ON public.employee_tp3_draft FOR ALL
 USING(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.is_self_person(person_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND app.is_self_person(person_id));
-- The legacy ALL policy's USING admitted self DELETE despite admin-only WITH CHECK. Keep HR deletion.
CREATE POLICY employee_tp3_delete_admin_only ON public.employee_tp3 AS RESTRICTIVE FOR DELETE TO ai_hr_app USING(app.is_admin());
--> statement-breakpoint
CREATE FUNCTION app.my_tp3_eligible(wanted_employment uuid) RETURNS public.employment
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;u public.app_user;today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;joined date;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'TP3 own identity required'; END IF;
 SELECT a.* INTO u FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()
  AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) FOR SHARE;
 IF NOT FOUND OR u.person_id IS NULL THEN RAISE EXCEPTION 'TP3 own identity required'; END IF;
 SELECT r.* INTO e FROM public.employment r WHERE r.id=wanted_employment AND r.tenant_id=u.tenant_id AND r.person_id=u.person_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'TP3 own employment required'; END IF;
 joined:=coalesce(e.join_date,e.hired_on);
 IF e.blacklisted_at IS NOT NULL OR e.hired_on>today OR e.terminated_on<today
   OR least(e.resignation_date,e.last_working_date)<today OR joined IS NULL OR joined>today
   OR extract(year FROM joined)<>extract(year FROM today) THEN RAISE EXCEPTION 'TP3 current-year Join Date eligibility changed'; END IF;
 RETURN e;
END $$;
REVOKE ALL ON FUNCTION app.my_tp3_eligible(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.my_tp3_save_draft(wanted_employment uuid,wanted_year integer,expected_revision integer,
 wanted_month smallint,wanted_employers jsonb,wanted_payload jsonb,wanted_declaration boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;d public.employee_tp3_draft;result uuid;y integer;
BEGIN
 e:=app.my_tp3_eligible(wanted_employment);y:=extract(year FROM coalesce(e.join_date,e.hired_on));
 IF wanted_year IS DISTINCT FROM y OR expected_revision<0 OR expected_revision IS NULL OR wanted_declaration IS NULL
  OR wanted_month NOT BETWEEN 1 AND 12 OR jsonb_typeof(wanted_employers) IS DISTINCT FROM 'array'
  OR jsonb_typeof(wanted_payload) IS DISTINCT FROM 'object' OR wanted_payload->>'form' IS DISTINCT FROM 'tp3-2026'
  OR wanted_payload ? 'remarks' OR pg_column_size(wanted_payload)>30000 OR pg_column_size(wanted_employers)>10000
  OR (SELECT count(*) FROM jsonb_object_keys(wanted_payload))<>3 OR NOT wanted_payload ?& ARRAY['form','sectionC','sectionD'] THEN RAISE EXCEPTION 'Invalid TP3 draft'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('tp3|'||e.tenant_id::text||'|'||e.person_id::text||'|'||y::text,0));
 IF EXISTS(SELECT 1 FROM public.employee_tp3 c WHERE c.tenant_id=e.tenant_id AND c.person_id=e.person_id AND c.assessment_year=y) THEN RAISE EXCEPTION 'TP3 canonical record already exists; ask Payroll for correction'; END IF;
 SELECT r.* INTO d FROM public.employee_tp3_draft r WHERE r.tenant_id=e.tenant_id AND r.person_id=e.person_id AND r.assessment_year=y FOR UPDATE;
 IF FOUND THEN
  IF d.submitted_at IS NOT NULL OR d.revision IS DISTINCT FROM expected_revision OR d.employment_id<>e.id THEN RAISE EXCEPTION 'TP3 draft changed; reload before saving'; END IF;
  UPDATE public.employee_tp3_draft SET deduction_month=wanted_month,previous_employers=wanted_employers,payload=wanted_payload,
   declaration_accepted=wanted_declaration,revision=revision+1,updated_at=clock_timestamp() WHERE id=d.id RETURNING id INTO result;
 ELSE
  IF expected_revision<>0 THEN RAISE EXCEPTION 'TP3 draft changed; reload before saving'; END IF;
  INSERT INTO public.employee_tp3_draft(tenant_id,person_id,employment_id,assessment_year,deduction_month,previous_employers,payload,declaration_accepted)
   VALUES(e.tenant_id,e.person_id,e.id,y,wanted_month,wanted_employers,wanted_payload,wanted_declaration) RETURNING id INTO result;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.my_tp3_save_draft(uuid,integer,integer,smallint,jsonb,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tp3_save_draft(uuid,integer,integer,smallint,jsonb,jsonb,boolean) TO ai_hr_app;
--> statement-breakpoint
-- These two narrow storage ports are called by the shared validated TP3 writer. Neither grants a
-- general canonical upsert or statutory-profile UPDATE. A deferred guard refuses a half-published form.
CREATE FUNCTION app.my_tp3_insert(wanted_draft uuid,expected_revision integer,wanted_month smallint,wanted_employers jsonb,wanted_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_tp3_draft;e public.employment;result uuid;
BEGIN
 SELECT r.* INTO d FROM public.employee_tp3_draft r WHERE r.id=wanted_draft AND r.tenant_id=app.current_tenant_id() AND app.is_self_person(r.person_id);
 IF NOT FOUND THEN RAISE EXCEPTION 'TP3 draft unavailable'; END IF;
 e:=app.my_tp3_eligible(d.employment_id);
 PERFORM pg_advisory_xact_lock(hashtextextended('tp3|'||e.tenant_id::text||'|'||e.person_id::text||'|'||d.assessment_year::text,0));
 SELECT r.* INTO STRICT d FROM public.employee_tp3_draft r WHERE r.id=d.id FOR UPDATE;
 IF d.person_id<>e.person_id OR d.tenant_id<>e.tenant_id OR d.assessment_year<>extract(year FROM coalesce(e.join_date,e.hired_on))
  OR d.revision IS DISTINCT FROM expected_revision OR d.submitted_at IS NOT NULL OR NOT d.declaration_accepted
  OR d.deduction_month IS DISTINCT FROM wanted_month OR d.previous_employers IS DISTINCT FROM wanted_employers OR d.payload IS DISTINCT FROM wanted_payload
  OR EXISTS(SELECT 1 FROM public.employee_tp3 c WHERE c.tenant_id=d.tenant_id AND c.person_id=d.person_id AND c.assessment_year=d.assessment_year)
  THEN RAISE EXCEPTION 'TP3 draft or canonical record changed; reload before submitting'; END IF;
 INSERT INTO public.employee_tp3(tenant_id,person_id,assessment_year,deduction_month,previous_employers,payload,declared_at,remarks)
  VALUES(d.tenant_id,d.person_id,d.assessment_year,d.deduction_month,d.previous_employers,d.payload,clock_timestamp(),NULL) RETURNING id INTO result;
 UPDATE public.employee_tp3_draft SET canonical_id=result,submitted_at=clock_timestamp(),commit_xid=pg_current_xact_id(),revision=revision+1,updated_at=clock_timestamp() WHERE id=d.id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.my_tp3_insert(uuid,integer,smallint,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tp3_insert(uuid,integer,smallint,jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.my_tp3_projection(wanted_draft uuid,wanted_projection jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_tp3_draft;s public.employee_statutory_my;k text;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'TP3 own identity required'; END IF;
 SELECT r.* INTO d FROM public.employee_tp3_draft r WHERE r.id=wanted_draft AND r.tenant_id=app.current_tenant_id() AND app.is_self_person(r.person_id) FOR UPDATE;
 IF NOT FOUND OR d.canonical_id IS NULL OR d.commit_xid IS DISTINCT FROM pg_current_xact_id() OR d.projection_finished THEN RAISE EXCEPTION 'TP3 active submission required'; END IF;
 SELECT r.* INTO s FROM public.employee_statutory_my r WHERE r.tenant_id=d.tenant_id AND r.person_id=d.person_id FOR UPDATE;
 IF NOT FOUND THEN
  IF wanted_projection IS NOT NULL THEN RAISE EXCEPTION 'TP3 statutory profile changed'; END IF;
  UPDATE public.employee_tp3_draft SET projection_finished=true,projection_outcome=jsonb_build_object('applied',false,'reason','noStatutoryProfile') WHERE id=d.id;RETURN;
 END IF;
 IF s.tp3_year>d.assessment_year THEN
  IF wanted_projection IS NOT NULL THEN RAISE EXCEPTION 'TP3 statutory year changed'; END IF;
  UPDATE public.employee_tp3_draft SET projection_finished=true,projection_outcome=jsonb_build_object('applied',false,'reason','laterYearHoldsColumns','heldBy',s.tp3_year) WHERE id=d.id;RETURN;
 END IF;
 IF jsonb_typeof(wanted_projection) IS DISTINCT FROM 'object' OR (wanted_projection->>'tp3Year')::integer IS DISTINCT FROM d.assessment_year
  OR (SELECT count(*) FROM jsonb_object_keys(wanted_projection))<>7
  OR NOT wanted_projection ?& ARRAY['tp3Year','tp3NetRemuneration','tp3EpfClaimed','tp3PcbPaid','tp3ZakatPaid','tp3Lp','tp3ExemptionUsed'] THEN RAISE EXCEPTION 'Invalid TP3 projection'; END IF;
 FOREACH k IN ARRAY ARRAY['tp3NetRemuneration','tp3EpfClaimed','tp3PcbPaid','tp3ZakatPaid','tp3Lp'] LOOP
  IF wanted_projection->>k IS NULL OR (wanted_projection->>k)!~'^[0-9]{1,10}\.[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid TP3 projection amount'; END IF;
 END LOOP;
 IF wanted_projection->'tp3ExemptionUsed'<>'null'::jsonb THEN
  IF jsonb_typeof(wanted_projection->'tp3ExemptionUsed')<>'object' THEN RAISE EXCEPTION 'Invalid TP3 exemption projection'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(wanted_projection->'tp3ExemptionUsed') entry WHERE jsonb_typeof(entry.value)<>'number' OR entry.key!~'^[A-Z][A-Z0-9_]{1,63}$') THEN RAISE EXCEPTION 'Invalid TP3 exemption projection'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(wanted_projection->'tp3ExemptionUsed') entry WHERE (entry.value::text)::numeric<0 OR (entry.value::text)::numeric>9999999999.99) THEN RAISE EXCEPTION 'Invalid TP3 exemption projection'; END IF;
 END IF;
 UPDATE public.employee_statutory_my SET tp3_year=d.assessment_year,
  tp3_net_remuneration=(wanted_projection->>'tp3NetRemuneration')::numeric,tp3_epf_claimed=(wanted_projection->>'tp3EpfClaimed')::numeric,
  tp3_pcb_paid=(wanted_projection->>'tp3PcbPaid')::numeric,tp3_zakat_paid=(wanted_projection->>'tp3ZakatPaid')::numeric,
  tp3_lp=(wanted_projection->>'tp3Lp')::numeric,tp3_exemption_used=nullif(wanted_projection->'tp3ExemptionUsed','null'::jsonb),updated_at=clock_timestamp() WHERE id=s.id;
 UPDATE public.employee_tp3_draft SET projection_finished=true,projection_outcome=jsonb_build_object('applied',true) WHERE id=d.id;
END $$;
REVOKE ALL ON FUNCTION app.my_tp3_projection(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_tp3_projection(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.my_tp3_complete_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.employee_tp3_draft d WHERE d.id=NEW.id AND d.canonical_id IS NOT NULL AND (NOT d.projection_finished OR NOT EXISTS(SELECT 1 FROM public.employee_tp3 c WHERE c.id=d.canonical_id AND c.tenant_id=d.tenant_id AND c.person_id=d.person_id AND c.assessment_year=d.assessment_year AND c.deduction_month IS NOT DISTINCT FROM d.deduction_month AND c.previous_employers=d.previous_employers AND c.payload=d.payload AND c.declared_at IS NOT NULL AND c.remarks IS NULL))) THEN RAISE EXCEPTION 'TP3 form and projection must commit together'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.my_tp3_complete_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER employee_tp3_complete_submission AFTER INSERT OR UPDATE ON public.employee_tp3_draft DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.my_tp3_complete_guard();
