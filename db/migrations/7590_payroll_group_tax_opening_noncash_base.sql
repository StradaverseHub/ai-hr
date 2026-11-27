-- Board d9ded29c (approved plan revision 1, 27 November 2026): taxable BIK/VOLA in a group company's imported or
-- reviewed months reaches Y at the company the person moved to.
--
-- A saved Income Tax Correction revision or an accepted import projection (TaxBasisValue version 1) records `pcb` as the
-- cash base (normal + additional) and keeps the month's taxable benefits beside it in `pcbNonCash`. Live payroll stamps
-- `bases.pcb` as cash PLUS the month's cumulative taxable benefits, and Y folds as base - (cumulative - owned). 7550 took
-- the saved cash base as the whole base, so Y lost the benefits that month owned. This replaces only the function body,
-- guarded by the 7550 body it replaces:
--   * for a version 1 saved basis with its own noncash snapshot, the base is basis.pcb plus that snapshot's cumulative
--     taxable BIK + VOLA (the canonical reader's effectiveTaxBasisPcb, core/payroll-tax-basis-read.ts), so Y adds the
--     month's own taxable benefits once. A native month (bases.pcb stamp) is unchanged;
--   * noncash_complete is true for a month read through a saved basis that has no noncash snapshot: an accepted import
--     or reviewed correction states its benefits completely, so none is a known zero (an imported bonus-only month).
--     A native month without a snapshot still reads as incomplete.
-- Signature, volatility, SECURITY DEFINER, search_path, owner, the authority gate, the returned columns, the bound and
-- grants are unchanged (the grants are restated, identical). No stored payslip, revision or import byte changes.
DO $guard$
BEGIN
 IF md5((SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid='app.payroll_group_tax_opening(uuid,text,uuid[])'::regprocedure)) IS DISTINCT FROM '23764b9bb7b9ebd73c722933c48d5225' THEN
  RAISE EXCEPTION 'Unexpected payroll_group_tax_opening predecessor (7550)' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_group_tax_opening(run_company uuid,p_period text,p_employments uuid[])
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
   -- Strictly boolean: a NULL here would read a native payslip as an import with no receipts.
   (coalesce(jsonb_typeof(ef.statutory->'importedTaxBasis'),'')='object' OR (ef.in_history_run AND NOT app.payroll_history_native_baseline(ef.id))) AS imported
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
   -- d9ded29c: a saved correction or accepted import basis (version 1) records pcb as cash only; its own noncash snapshot
   -- carries the month's taxable benefits, which the PCB base includes as live payroll stamps it.
   (coalesce(b.basis->>'version','')='1') AS saved_basis,
   (coalesce(b.basis->>'version','')='1' AND jsonb_typeof(b.basis->'pcbNonCash')='object') AS saved_cash_base,
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
 ), slip_base AS (
  SELECT s.*,s.base+CASE WHEN s.saved_cash_base THEN s.cum_bik+s.cum_vola ELSE 0 END AS effective_base
  FROM slip_money s
 ), month AS (
  SELECT m.run_employment,m.source_company,m.pay_period,
   CASE WHEN bool_and(m.imported) THEN 'imported' WHEN bool_or(m.imported) THEN 'mixed' ELSE 'processed' END AS source,
   count(*)::integer AS slips,CASE WHEN bool_and(m.slip_end IS NOT NULL) THEN max(m.slip_end) END AS ends_on,
   round(sum(m.effective_base-CASE WHEN m.nc IS NULL THEN 0 ELSE m.cum_bik+m.cum_vola-m.owned_bik-m.owned_vola END),2) AS y,
   round(sum(m.epf),2) AS epf,round(sum(m.pcb),2) AS pcb,round(sum(m.zakat),2) AS zakat,round(sum(m.zakat_rebate),2) AS zakat_rebate,
   round(sum(m.lp),2) AS lp,round(sum(m.tp1_lp),2) AS tp1_lp,round(sum(m.owned_bik),2) AS bik,round(sum(m.owned_vola),2) AS vola,
   bool_and(m.nc IS NOT NULL OR m.saved_basis) AS noncash_complete,min(m.unusable) AS unusable,
   coalesce(jsonb_agg(DISTINCT coalesce(m.rules_receipt,'null'::jsonb)) FILTER (WHERE m.imported),'[]'::jsonb) AS rules_receipts
  FROM slip_base m GROUP BY m.run_employment,m.source_company,m.pay_period
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
