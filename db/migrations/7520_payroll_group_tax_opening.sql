-- Board 4ce2c481, owner decision of 26 November 2026 ("Automatic group TP3"): an employee's income-tax history follows
-- them across the group's companies. Earlier months of the same assessment year that OTHER companies of the tenant paid
-- the same person (imported history or processed payroll) feed the current company's PCB/MTD as an automatic
-- previous-employer opening, the role Form TP3 plays. No LHDN table, rate, relief or formula changes; EA/CP8A, CP39 and
-- Form E stay per company; no payslip is moved, copied or changed.
--
-- The run company's payroll administrator usually may NOT read the other company's payslips (row security fences them
-- by company), yet the calculation must not depend on who presses Process. So the only bridge is this definer, and it
-- returns TOTALS per contributing company and month, never a payslip, a line, an item or a payslip id:
--
--   * gated by app.can_admin_payroll_for(run company) within the current tenant (raises otherwise, so a calculation
--     can never silently proceed without the history it needs);
--   * only for requested employments that belong to the run company (today, by a dated assignment, or by a payslip
--     on one of its runs);
--   * contributing payslips: the same person, the same assessment year, a pay period up to the run's, another company,
--     a processed or closed run, effective under the payroll history barrier (staged and replaced rows excluded). The
--     run's own employment contributes its other-company months (an Entity Transfer keeps the employment); another
--     employment of the person contributes only when it ended before the run employment started (a previous job). Two
--     jobs held at the same time stay separate, as ADR-0009 section 4 and ADR-0014 point 4 still say for them;
--   * the tax basis of each payslip is the effective one the canonical reader uses: the latest income-tax correction
--     revision; otherwise an accepted imported projection that is ready and matches its saved base; otherwise the
--     native bases.pcb stamp. An imported month whose saved Pay Item receipts no longer match today's Pay Item
--     settings is unusable as the canonical reader makes it (its assessment-year rules receipt comes back for the caller
--     to compare). A month with no usable basis is returned as unusable with its reason, so the caller holds the
--     employee with the month named and never falls back to gross pay or zero.
--
-- Same-month rows carry ends_on (the other company's segment end, or the previous employment's end) so the caller
-- counts only a company the person LEFT before this company's part of the month began. The TP3 previous-employer tax
-- numbers of the person's canonical TP3 for the year come back beside the rows so a TP3 that lists a contributing
-- group company is replaced, never added on top. Read only; one statement for a whole processing chunk.
CREATE FUNCTION app.payroll_group_tax_opening(run_company uuid,p_period text,p_employments uuid[])
RETURNS TABLE(employment_id uuid,company_id uuid,company_name text,employer_numbers text[],period text,source text,slips integer,ends_on date,
 y numeric,epf numeric,pcb numeric,zakat numeric,zakat_rebate numeric,lp numeric,tp1_lp numeric,exemption_used jsonb,bik numeric,vola numeric,
 noncash_complete boolean,unusable text,rules_receipts jsonb,tp3_numbers text[],tp3_unnumbered integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_tenant uuid:=app.current_tenant_id();
BEGIN
 IF run_company IS NULL OR p_period IS NULL OR p_period!~'^[0-9]{4}-(0[1-9]|1[0-2])$' OR p_employments IS NULL OR coalesce(cardinality(p_employments),0)>2000 THEN
  RAISE EXCEPTION 'Invalid group tax opening request' USING ERRCODE='22023';
 END IF;
 IF v_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=run_company AND c.tenant_id=v_tenant) OR NOT app.can_admin_payroll_for(run_company) THEN
  RAISE EXCEPTION 'Payroll administration of the run company is required for the group tax opening' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 WITH run AS MATERIALIZED (
  SELECT DISTINCT e.id AS run_employment,e.person_id,coalesce(e.join_date,e.hired_on) AS starts_on
  FROM unnest(p_employments) req(id) JOIN public.employment e ON e.id=req.id AND e.tenant_id=v_tenant
  WHERE e.company_id=run_company
   OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=v_tenant AND a.company_id=run_company)
   OR EXISTS(SELECT 1 FROM public.payslip s JOIN public.payroll_batch b ON b.id=s.batch_id AND b.tenant_id=v_tenant
    WHERE s.employment_id=e.id AND s.tenant_id=v_tenant AND b.company_id=run_company)
 ), source_employment AS MATERIALIZED (
  SELECT r.run_employment,x.id AS source_id,(x.id=r.run_employment) AS same_employment,
   coalesce(least(x.terminated_on,x.resignation_date),x.last_working_date) AS ended_on
  FROM run r JOIN public.employment x ON x.person_id=r.person_id AND x.tenant_id=v_tenant
  WHERE x.id=r.run_employment OR coalesce(least(x.terminated_on,x.resignation_date),x.last_working_date)<r.starts_on
 ), hidden AS MATERIALIZED (
  SELECT h.id FROM unnest(app.payroll_history_hidden_rows('payslip')) h(id)
 ), candidate AS MATERIALIZED (
  SELECT se.run_employment,se.same_employment,se.ended_on,s.id,s.statutory,b.company_id AS source_company,b.pay_period,
   (b.history_import_attempt_id IS NOT NULL) AS in_history_run
  FROM source_employment se JOIN public.payslip s ON s.employment_id=se.source_id AND s.tenant_id=v_tenant
  JOIN public.payroll_batch b ON b.id=s.batch_id AND b.tenant_id=v_tenant
  WHERE b.company_id<>run_company AND b.pay_period LIKE left(p_period,4)||'-%' AND b.pay_period<=p_period AND b.status IN ('processed','closed')
   AND NOT EXISTS(SELECT 1 FROM hidden WHERE hidden.id=s.id)
 ), effective AS MATERIALIZED (
  SELECT c.* FROM candidate c WHERE c.id IN (SELECT e.id FROM app.payroll_history_effective_ids(ARRAY(SELECT c2.id FROM candidate c2)) e(id))
 ), revision AS MATERIALIZED (
  SELECT DISTINCT ON (r.payslip_id) r.payslip_id,r.basis FROM public.payroll_tax_basis_revision r
  WHERE r.tenant_id=v_tenant AND r.payslip_id IN (SELECT ef.id FROM effective ef) ORDER BY r.payslip_id,r.ordinal DESC
 ), classified AS (
  SELECT ef.*,rv.basis AS revised,
   (jsonb_typeof(ef.statutory->'importedTaxBasis')='object' OR (ef.in_history_run AND NOT app.payroll_history_native_baseline(ef.id))) AS imported
  FROM effective ef LEFT JOIN revision rv ON rv.payslip_id=ef.id
 ), receipted AS (
  -- The reviewed or accepted import's Pay Item receipts, compared with today's settings exactly as the canonical reader
  -- compares them (core/payroll-import-tax-source.ts importedTaxSettingEvidence): same fields, the system basic salary
  -- receipt valid only while no BASIC Pay Item exists.
  SELECT c.*,CASE WHEN NOT c.imported THEN false
   WHEN coalesce(jsonb_typeof(CASE WHEN jsonb_typeof(c.revised)='object' THEN c.revised->'appliedSettings' ELSE c.statutory->'importedTaxBasis'->'settings' END),'')<>'array' THEN true
   ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.revised)='object' THEN c.revised->'appliedSettings' ELSE c.statutory->'importedTaxBasis'->'settings' END) st
    WHERE CASE WHEN st->>'id'='system-basic-salary' THEN EXISTS(SELECT 1 FROM public.pay_component pc WHERE pc.tenant_id=v_tenant AND upper(pc.code)='BASIC')
     ELSE NOT EXISTS(SELECT 1 FROM public.pay_component pc WHERE pc.tenant_id=v_tenant AND pc.id::text=st->>'id'
      AND coalesce(st->'code','null'::jsonb)=coalesce(to_jsonb(pc.code),'null'::jsonb) AND coalesce(st->'kind','null'::jsonb)=coalesce(to_jsonb(pc.kind),'null'::jsonb)
      AND coalesce(st->'includedInPcb','null'::jsonb)=coalesce(to_jsonb(pc.included_in_pcb),'null'::jsonb)
      AND coalesce(st->'pcbRemunerationType','null'::jsonb)=coalesce(to_jsonb(pc.pcb_remuneration_type),'null'::jsonb)
      AND coalesce(st->'pcbExemptionCode','null'::jsonb)=coalesce(to_jsonb(pc.pcb_exemption_code),'null'::jsonb)
      AND coalesce(st->'isNonPayable','null'::jsonb)=coalesce(to_jsonb(pc.is_non_payable),'null'::jsonb)
      AND coalesce(st->'epfBonus2012','null'::jsonb)=coalesce(to_jsonb(pc.epf_bonus_2012),'null'::jsonb)
      AND coalesce(st->'displayCategory','null'::jsonb)=coalesce(to_jsonb(pc.display_category),'null'::jsonb)
      AND coalesce(st->'eaFormLine','null'::jsonb)=coalesce(to_jsonb(pc.ea_form_line),'null'::jsonb)
      AND (coalesce(st->'archivedAt','null'::jsonb)='null'::jsonb)=(pc.archived_at IS NULL)) END) END AS settings_changed,
   CASE WHEN c.imported THEN CASE WHEN jsonb_typeof(c.revised)='object' THEN c.revised->'rulesState' ELSE c.statutory->'importedTaxBasis'->'rulesState' END END AS rules_receipt
  FROM classified c
 ), based AS (
  SELECT c.*,
   CASE WHEN jsonb_typeof(c.revised)='object' AND jsonb_typeof(c.revised->'pcb')='number' THEN c.revised
    WHEN c.imported THEN CASE WHEN c.statutory->'importedTaxBasis'->>'version'='1' AND c.statutory->'importedTaxBasis'->>'state'='ready'
      AND c.statutory->'importedTaxBasis'->>'year'=left(c.pay_period,4) AND jsonb_typeof(c.statutory->'importedTaxBasis'->'basis'->'pcb')='number'
      AND c.statutory->'bases'->'pcb'=c.statutory->'importedTaxBasis'->'basis'->'pcb' THEN c.statutory->'importedTaxBasis'->'basis' END
    WHEN jsonb_typeof(c.statutory->'bases'->'pcb')='number' THEN jsonb_build_object('pcb',c.statutory->'bases'->'pcb','exemptionUsed',c.statutory->'exemptionUsed')
   END AS basis
  FROM receipted c
 ), slip AS (
  SELECT b.run_employment,b.source_company,b.pay_period,b.imported,
   CASE WHEN b.same_employment THEN CASE WHEN b.statutory->'segment'->>'to' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN (b.statutory->'segment'->>'to')::date END ELSE b.ended_on END AS slip_end,
   CASE WHEN b.basis IS NOT NULL AND NOT b.settings_changed THEN NULL WHEN b.imported THEN 'imported_review' ELSE 'no_tax_basis' END AS unusable,
   b.rules_receipt,
   CASE WHEN b.basis IS NULL THEN '{}'::jsonb WHEN jsonb_typeof(b.basis->'exemptionUsed')='object' THEN b.basis->'exemptionUsed'
    WHEN b.revised IS NULL AND NOT b.imported AND jsonb_typeof(b.statutory->'exemptionUsed')='object' THEN b.statutory->'exemptionUsed' ELSE '{}'::jsonb END AS used,
   coalesce(CASE WHEN jsonb_typeof(b.basis->'pcbNonCash')='object' THEN b.basis->'pcbNonCash' END,
    CASE WHEN jsonb_typeof(b.statutory->'pcbNonCash')='object' THEN b.statutory->'pcbNonCash' END) AS nc,
   CASE WHEN jsonb_typeof(b.basis->'pcb')='number' THEN (b.basis->'pcb')::numeric ELSE 0 END AS base,
   CASE WHEN jsonb_typeof(b.statutory->'epfEmployee')='number' THEN (b.statutory->'epfEmployee')::numeric ELSE 0 END AS epf,
   CASE WHEN jsonb_typeof(b.statutory->'pcb')='number' THEN (b.statutory->'pcb')::numeric ELSE 0 END AS pcb,
   CASE WHEN jsonb_typeof(b.statutory->'zakat')='number' THEN (b.statutory->'zakat')::numeric ELSE 0 END AS zakat,
   CASE WHEN jsonb_typeof(b.statutory->'zakatRebateTp1')='number' THEN (b.statutory->'zakatRebateTp1')::numeric ELSE 0 END AS zakat_rebate,
   CASE WHEN jsonb_typeof(b.basis->'lp')='number' THEN (b.basis->'lp')::numeric WHEN jsonb_typeof(b.statutory->'lp')='number' THEN (b.statutory->'lp')::numeric ELSE 0 END AS lp,
   CASE WHEN jsonb_typeof(b.statutory->'lpDetail'->'tp1')='number' THEN (b.statutory->'lpDetail'->'tp1')::numeric ELSE 0 END AS tp1_lp
  FROM based b
 ), slip_money AS (
  SELECT s.*,
   CASE WHEN jsonb_typeof(s.nc->'owned'->'bik')='number' THEN (s.nc->'owned'->'bik')::numeric ELSE 0 END AS owned_bik,
   CASE WHEN jsonb_typeof(s.nc->'owned'->'vola')='number' THEN (s.nc->'owned'->'vola')::numeric ELSE 0 END AS owned_vola,
   CASE WHEN jsonb_typeof(s.nc->'cumulative'->'bik')='number' THEN (s.nc->'cumulative'->'bik')::numeric ELSE 0 END AS cum_bik,
   CASE WHEN jsonb_typeof(s.nc->'cumulative'->'vola')='number' THEN (s.nc->'cumulative'->'vola')::numeric ELSE 0 END AS cum_vola
  FROM slip s
 ), month AS (
  SELECT m.run_employment,m.source_company,m.pay_period,
   CASE WHEN bool_and(m.imported) THEN 'imported' WHEN bool_or(m.imported) THEN 'mixed' ELSE 'processed' END AS source,
   count(*)::integer AS slips,CASE WHEN bool_and(m.slip_end IS NOT NULL) THEN max(m.slip_end) END AS ends_on,
   round(sum(m.base-CASE WHEN m.nc IS NULL THEN 0 ELSE m.cum_bik+m.cum_vola-m.owned_bik-m.owned_vola END),2) AS y,
   round(sum(m.epf),2) AS epf,round(sum(m.pcb),2) AS pcb,round(sum(m.zakat),2) AS zakat,round(sum(m.zakat_rebate),2) AS zakat_rebate,
   round(sum(m.lp),2) AS lp,round(sum(m.tp1_lp),2) AS tp1_lp,round(sum(m.owned_bik),2) AS bik,round(sum(m.owned_vola),2) AS vola,
   bool_and(m.nc IS NOT NULL) AS noncash_complete,min(m.unusable) AS unusable,
   coalesce(jsonb_agg(DISTINCT coalesce(m.rules_receipt,'null'::jsonb)) FILTER (WHERE m.imported),'[]'::jsonb) AS rules_receipts
  FROM slip_money m GROUP BY m.run_employment,m.source_company,m.pay_period
 ), used AS (
  SELECT u.run_employment,u.source_company,u.pay_period,jsonb_object_agg(u.code,u.amount) AS used
  FROM (SELECT m.run_employment,m.source_company,m.pay_period,kv.key AS code,round(sum((kv.value)::numeric),2) AS amount
   FROM slip_money m CROSS JOIN LATERAL jsonb_each(m.used) kv WHERE jsonb_typeof(kv.value)='number'
   GROUP BY m.run_employment,m.source_company,m.pay_period,kv.key) u
  GROUP BY u.run_employment,u.source_company,u.pay_period
 ), tp3 AS MATERIALIZED (
  SELECT r.run_employment,
   coalesce(array_agg(DISTINCT upper(regexp_replace(pe->>'tin','[^A-Za-z0-9]','','g'))) FILTER (WHERE coalesce(regexp_replace(pe->>'tin','[^A-Za-z0-9]','','g'),'')<>''),'{}') AS numbers,
   count(*) FILTER (WHERE pe IS NOT NULL AND coalesce(regexp_replace(pe->>'tin','[^A-Za-z0-9]','','g'),'')='')::integer AS unnumbered
  FROM run r JOIN public.employee_tp3 t ON t.person_id=r.person_id AND t.tenant_id=v_tenant AND t.assessment_year=left(p_period,4)::integer
  LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.previous_employers)='array' THEN t.previous_employers ELSE '[]'::jsonb END) pe ON true
  GROUP BY r.run_employment
 )
 SELECT m.run_employment,m.source_company,co.legal_name,
  ARRAY(SELECT DISTINCT upper(regexp_replace(n,'[^A-Za-z0-9]','','g')) FROM unnest(ARRAY[cs.lhdn_employer_no,cs.myinvois_tin]) n WHERE coalesce(regexp_replace(n,'[^A-Za-z0-9]','','g'),'')<>'' ORDER BY 1),
  m.pay_period,m.source,m.slips,m.ends_on,m.y,m.epf,m.pcb,m.zakat,m.zakat_rebate,m.lp,m.tp1_lp,coalesce(u.used,'{}'::jsonb),m.bik,m.vola,
  m.noncash_complete,m.unusable,m.rules_receipts,coalesce(t.numbers,'{}'::text[]),coalesce(t.unnumbered,0)
 FROM month m JOIN public.company co ON co.id=m.source_company AND co.tenant_id=v_tenant
 LEFT JOIN public.company_statutory_my cs ON cs.company_id=m.source_company AND cs.tenant_id=v_tenant
 LEFT JOIN used u ON u.run_employment=m.run_employment AND u.source_company=m.source_company AND u.pay_period=m.pay_period
 LEFT JOIN tp3 t ON t.run_employment=m.run_employment
 ORDER BY m.run_employment,m.pay_period,m.source_company;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_group_tax_opening(uuid,text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_group_tax_opening(uuid,text,uuid[]) TO ai_hr_app;
