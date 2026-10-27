-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Requires the actual 0591 native TP3 owners.
-- Only an early Access/configuration phase is added to the same narrow SQL write signatures.
-- No new storage, marker, table/role grant, arithmetic or native payload interpretation.
-- Existing native identity/declaration/complete-submission guards and execute grants remain intact.
-- Whole top-level rollback on any busy/SQL refusal; no retries or continuing after partial ownership.
CREATE OR REPLACE FUNCTION app.my_tp3_save_draft(wanted_employment uuid,wanted_year integer,expected_revision integer,
 wanted_month smallint,wanted_employers jsonb,wanted_payload jsonb,wanted_declaration boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;d public.employee_tp3_draft;result uuid;y integer;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.current_tenant_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='55P03';END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.my_tp3_insert(wanted_draft uuid,expected_revision integer,wanted_month smallint,wanted_employers jsonb,wanted_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_tp3_draft;e public.employment;result uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.current_tenant_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='55P03';END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.my_tp3_projection(wanted_draft uuid,wanted_projection jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.employee_tp3_draft;s public.employee_statutory_my;k text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.current_tenant_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Statutory source unavailable' USING ERRCODE='55P03';END IF;
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
