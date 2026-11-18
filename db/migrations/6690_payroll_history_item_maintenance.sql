-- Canonical import revisions retain item contribution lineage. No separate money ledger or artifact mutation.
ALTER TABLE public.payroll_history_import_revision ADD COLUMN maintenance jsonb
 CHECK(maintenance IS NULL OR coalesce((jsonb_typeof(maintenance)='object' AND maintenance->>'version'='1' AND maintenance->'state'->>'version'='1' AND jsonb_typeof(maintenance->'state'->'chains')='object' AND length(maintenance->>'reason') BETWEEN 1 AND 2000),false));
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_revision_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE identity public.payroll_history_import_record; source public.payroll_history_import_attempt; planned jsonb; permission_key text;
BEGIN
 IF NEW.maintenance IS NULL THEN
  IF NEW.kind='revert' AND app.current_user_id() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_record r WHERE r.id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND app.payroll_history_maintenance_permission(r.company_id,'payroll.history.revert')) THEN RAISE EXCEPTION 'Payroll history withdrawal authority unavailable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO identity FROM public.payroll_history_import_record WHERE id=NEW.record_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO source FROM public.payroll_history_import_attempt WHERE id=NEW.attempt_id AND tenant_id=NEW.tenant_id;
 permission_key:=CASE WHEN NEW.kind='revert' OR NEW.snapshot_id IS NULL OR source.plan->'maintenance'->>'mode' IN ('remove_items','remove_batch') THEN 'payroll.history.revert' ELSE 'payroll.history.import' END;
 IF identity.id IS NULL OR source.id IS NULL OR NOT app.principal_snapshot_current() OR source.created_by IS DISTINCT FROM app.current_user_id()
 OR NOT app.payroll_history_maintenance_permission(identity.company_id,permission_key)
 OR source.plan->'maintenance'->>'version' IS DISTINCT FROM '1'
 OR NEW.maintenance->>'operation' IS DISTINCT FROM source.plan->'maintenance'->>'mode'
 OR NEW.maintenance->>'reason' IS DISTINCT FROM source.plan->'maintenance'->>'reason'
 OR source.plan->'maintenance'->>'mode' NOT IN ('replace','update_listed','edit','remove_items','remove_batch')
 OR CASE WHEN source.plan->'maintenance'->>'mode' IN ('edit','remove_items','remove_batch') THEN
   source.plan->'maintenance'->'request'->>'operation' IS DISTINCT FROM source.plan->'maintenance'->>'mode'
   OR source.plan->'maintenance'->'request'->>'version' IS DISTINCT FROM '1'
   OR source.plan->'maintenance'->'request'->>'reason' IS DISTINCT FROM source.plan->'maintenance'->>'reason'
  ELSE source.plan->'maintenance'->'request' IS NOT NULL AND source.plan->'maintenance'->'request'<>'null'::jsonb END
 THEN RAISE EXCEPTION 'Payroll history maintenance authority or source unavailable' USING ERRCODE='42501'; END IF;
 SELECT value INTO planned FROM jsonb_array_elements(source.plan->'rows') WHERE value->>'companyId'=identity.company_id::text
 AND value->>'employmentId'=identity.employment_id::text AND value->>'period'=identity.period AND value->>'cycleId'=identity.cycle_id::text;
 IF planned IS NULL OR planned->'contributions' IS DISTINCT FROM NEW.maintenance->'state'
 OR (planned->>'restoreSnapshotId' IS NOT NULL AND (planned->>'restoreSnapshotId')::uuid IS DISTINCT FROM NEW.snapshot_id)
 OR (planned->>'withdrawal'='true' AND planned->>'restoreSnapshotId' IS NULL AND NEW.snapshot_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Payroll history maintenance revision does not match its reviewed plan' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_revision_bind() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_history_maintenance_revision_binding BEFORE INSERT ON public.payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_maintenance_revision_bind();
--> statement-breakpoint
-- A contribution can refer only to an immutable accepted value of THIS record. This validates
-- source ownership; the existing analyzer remains the one owner of import folding and payroll arithmetic.
CREATE FUNCTION app.payroll_history_maintenance_item_proven(record_ uuid,baseline_ uuid,entry_ jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE item_ jsonb; source_ uuid; snapshot_ record; amount_ numeric; key_ text; property_ text; total_ numeric;
BEGIN
 item_:=entry_->'item'; IF item_='null'::jsonb THEN RETURN true;END IF;
 IF jsonb_typeof(item_) IS DISTINCT FROM 'object' OR coalesce(item_->>'amount','')!~'^[0-9]+\.[0-9]{2}$' OR length(item_->>'amount')>13 THEN RETURN false;END IF;
 amount_:=(item_->>'amount')::numeric;key_:=item_->>'key';
 source_:=nullif(entry_->>'attemptId','')::uuid;
 FOR snapshot_ IN SELECT s.id,s."values",r.maintenance FROM public.payroll_history_import_snapshot s JOIN public.payroll_history_import_revision r ON r.record_id=s.record_id AND r.snapshot_id=s.id
  WHERE s.record_id=record_ AND s.tenant_id=app.current_tenant_id() AND ((source_ IS NULL AND s.id=baseline_ AND r.kind='adopted') OR(source_ IS NOT NULL AND r.attempt_id=source_ AND r.kind IN ('import','correction')))
 LOOP
  IF snapshot_.maintenance IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each(snapshot_.maintenance->'state'->'chains') chain CROSS JOIN LATERAL jsonb_array_elements(chain.value) retained WHERE chain.key=key_ AND retained.value=entry_) THEN RETURN true;END IF;
  IF item_->>'destination'='basic' AND key_='destination:basic' AND amount_=(snapshot_."values"->>'basicSalary')::numeric THEN RETURN true;END IF;
  property_:=CASE item_->>'destination' WHEN 'epf_employee' THEN 'epfEmployee' WHEN 'epf_employer' THEN 'epfEmployer' WHEN 'socso_employee' THEN 'socsoEmployee' WHEN 'socso_employer' THEN 'socsoEmployer' WHEN 'socso_skbbk' THEN 'socsoSkbbk' WHEN 'eis_employee' THEN 'eisEmployee' WHEN 'eis_employer' THEN 'eisEmployer' WHEN 'pcb' THEN 'pcb' WHEN 'cp38' THEN 'cp38' WHEN 'zakat' THEN 'zakat' WHEN 'lp' THEN 'lp' WHEN 'hrdf' THEN 'hrdf' ELSE NULL END;
  IF property_ IS NOT NULL AND key_='statutory:'||(item_->>'destination') AND amount_=coalesce((snapshot_."values"->'statutory'->>property_)::numeric,0) THEN RETURN true;END IF;
  IF item_->>'direction'='noncash' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(snapshot_."values"->'statutory'->'importedTaxBasis'->'lines','[]'::jsonb)) line WHERE line->>'code'=item_->>'code' AND 'component:'||(line->>'settingId')=key_ AND (line->>'amount')::numeric=amount_ AND line->>'direction'='noncash') THEN RETURN true;END IF;
  ELSE
   SELECT coalesce(sum((line->>'amount')::numeric),0) INTO total_ FROM jsonb_array_elements(coalesce(snapshot_."values"->'statutory'->'importedLines',snapshot_."values"->'statutory'->'componentLines','[]'::jsonb)) line
    WHERE (line->>'code'=item_->>'code' OR (item_->'originalCodes')?(line->>'code'))
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(line->'buckets','[]'::jsonb)) bucket WHERE bucket->>'bucket'=CASE item_->>'destination' WHEN 'allowance' THEN 'wage' WHEN 'overtime' THEN 'ot' WHEN 'bonus' THEN 'bonus' WHEN 'other_deduction' THEN 'deduct' ELSE '' END);
   IF total_=amount_ AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(snapshot_."values"->'statutory'->'importedLines',snapshot_."values"->'statutory'->'componentLines','[]'::jsonb)) line WHERE line->>'code'=item_->>'code' OR(item_->'originalCodes')?(line->>'code')) AND EXISTS(SELECT 1 FROM public.pay_component c WHERE c.tenant_id=app.current_tenant_id() AND 'component:'||c.id::text=key_ AND upper(c.code)=upper(item_->>'code') UNION ALL SELECT 1 FROM public.payroll_import_code c WHERE c.tenant_id=app.current_tenant_id() AND 'component:'||c.id::text=key_ AND upper(c.code)=upper(item_->>'code') AND c.alias_for IS NULL) THEN RETURN true;END IF;
  END IF;
 END LOOP;
 RETURN false;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_item_proven(uuid,uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_state_matches(state_ jsonb,values_ jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE totals_ jsonb; scalar_ record; wanted_ numeric; actual_ numeric; cash_ numeric; zakat_ numeric; owned_nc_ jsonb; original_nc_ jsonb;
BEGIN
 IF jsonb_typeof(state_->'chains') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF values_ IS NULL OR values_='null'::jsonb THEN RETURN NOT EXISTS(SELECT 1 FROM jsonb_each(state_->'chains') chain WHERE chain.value->0->'item' IS DISTINCT FROM 'null'::jsonb);END IF;
 SELECT coalesce(jsonb_object_agg(destination,amount),'{}'::jsonb) INTO totals_ FROM(
  SELECT item->>'destination' as destination,sum((item->>'amount')::numeric) as amount FROM jsonb_each(state_->'chains') chain
  CROSS JOIN LATERAL(SELECT chain.value->0->'item' as item) owned WHERE item IS NOT NULL AND item<>'null'::jsonb GROUP BY item->>'destination') grouped;
 FOR scalar_ IN SELECT * FROM (VALUES('basic','basicSalary'),('allowance','allowance'),('overtime','overtimePay'),('bonus','bonus'),('other_deduction','otherDeductions')) owned(destination,property) LOOP
  IF coalesce((totals_->>scalar_.destination)::numeric,0) IS DISTINCT FROM (values_->>scalar_.property)::numeric THEN RETURN false;END IF;
 END LOOP;
 FOR scalar_ IN SELECT * FROM (VALUES('epf_employee','epfEmployee'),('epf_employer','epfEmployer'),('socso_employee','socsoEmployee'),('socso_employer','socsoEmployer'),('socso_skbbk','socsoSkbbk'),('eis_employee','eisEmployee'),('eis_employer','eisEmployer'),('pcb','pcb'),('cp38','cp38'),('zakat','zakat'),('lp','lp'),('hrdf','hrdf')) owned(destination,property) LOOP
  IF coalesce((totals_->>scalar_.destination)::numeric,0) IS DISTINCT FROM coalesce((values_->'statutory'->>scalar_.property)::numeric,0) THEN RETURN false;END IF;
 END LOOP;
 SELECT coalesce(jsonb_object_agg(code,amount),'{}'::jsonb) INTO owned_nc_ FROM(SELECT upper(item->>'code') code,sum((item->>'amount')::numeric) amount FROM jsonb_each(state_->'chains') chain CROSS JOIN LATERAL(SELECT chain.value->0->'item' item) owned WHERE item->>'direction'='noncash' GROUP BY upper(item->>'code')) grouped;
 IF jsonb_typeof(values_->'statutory'->'importedTaxBasis'->'lines')='array' THEN
  SELECT coalesce(jsonb_object_agg(code,amount),'{}'::jsonb) INTO original_nc_ FROM(SELECT upper(line->>'code') code,sum((line->>'amount')::numeric) amount FROM jsonb_array_elements(values_->'statutory'->'importedTaxBasis'->'lines') line WHERE line->>'direction'='noncash' GROUP BY upper(line->>'code')) grouped;
 ELSE
  SELECT coalesce(jsonb_object_agg(code,amount),'{}'::jsonb) INTO original_nc_ FROM(SELECT upper(line->>'code') code,sum((line->>'entered')::numeric) amount FROM jsonb_array_elements(coalesce(values_->'statutory'->'pcbNonCash'->'ownedEaEntries','[]'::jsonb)) line GROUP BY upper(line->>'code')) grouped;
 END IF;
 IF owned_nc_ IS DISTINCT FROM original_nc_ THEN RETURN false;END IF;
 wanted_:=coalesce((totals_->>'basic')::numeric,0)+coalesce((totals_->>'allowance')::numeric,0)+coalesce((totals_->>'overtime')::numeric,0)+coalesce((totals_->>'bonus')::numeric,0);
 IF wanted_ IS DISTINCT FROM (values_->>'grossPay')::numeric OR (values_->>'grossPay')::numeric-(values_->>'totalDeductions')::numeric IS DISTINCT FROM (values_->>'netPay')::numeric THEN RETURN false;END IF;
 cash_:=coalesce((totals_->>'other_deduction')::numeric,0)+coalesce((totals_->>'epf_employee')::numeric,0)+coalesce((totals_->>'socso_employee')::numeric,0)+coalesce((totals_->>'socso_skbbk')::numeric,0)+coalesce((totals_->>'eis_employee')::numeric,0)+coalesce((totals_->>'pcb')::numeric,0)+coalesce((totals_->>'cp38')::numeric,0)+coalesce((totals_->>'zakat')::numeric,0);
 zakat_:=coalesce((totals_->>'zakat')::numeric,0);actual_:=(values_->>'totalDeductions')::numeric;
 RETURN actual_=cash_ OR (zakat_>0 AND actual_=cash_-zakat_);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_state_matches(jsonb,jsonb) FROM PUBLIC;
--> statement-breakpoint
-- Legacy revisions replaced whole records. Validate every retained active prefix, including
-- explicit zero Pay Item lines, before admitting the first partial-ownership revision.
CREATE FUNCTION app.payroll_history_maintenance_legacy_proven(record_ uuid,previous_ uuid,state_ jsonb,new_owner_ uuid,removed_ uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE original_ record; projected_ jsonb; line_ jsonb; path_ uuid[]; baseline_ uuid;
BEGIN
 WITH RECURSIVE history AS(
  SELECT r.*,ARRAY[r.id] visited FROM public.payroll_history_import_revision r WHERE r.id=previous_ AND r.record_id=record_ AND r.tenant_id=app.current_tenant_id()
  UNION ALL
  SELECT parent.*,history.visited||parent.id FROM history JOIN LATERAL(
   SELECT p.* FROM public.payroll_history_import_revision p WHERE p.record_id=record_ AND p.tenant_id=app.current_tenant_id()
   AND p.id=CASE WHEN history.kind='revert' THEN(SELECT origin.id FROM public.payroll_history_import_revision origin WHERE origin.record_id=record_ AND origin.tenant_id=app.current_tenant_id() AND origin.snapshot_id=history.snapshot_id AND origin.kind IN('adopted','import','correction') AND origin.ordinal<history.ordinal ORDER BY origin.ordinal LIMIT 1) ELSE history.previous_revision_id END
  ) parent ON NOT(parent.id=ANY(history.visited))
 ) SELECT array_agg(id) INTO path_ FROM history WHERE kind<>'revert';
 baseline_:=nullif(state_->>'baselineSnapshotId','')::uuid;
 -- Every retained old entry must belong to this active path, never a reverted-away attempt.
 IF EXISTS(SELECT 1 FROM jsonb_each(state_->'chains') chain CROSS JOIN LATERAL jsonb_array_elements(chain.value) entry WHERE entry->>'attemptId' IS NOT NULL AND entry->>'attemptId'<>new_owner_::text AND NOT EXISTS(SELECT 1 FROM public.payroll_history_import_revision r WHERE r.id=ANY(path_) AND r.attempt_id=(entry->>'attemptId')::uuid)) THEN RETURN false;END IF;
 FOR original_ IN SELECT r.*,s."values" FROM public.payroll_history_import_revision r JOIN public.payroll_history_import_snapshot s ON s.id=r.snapshot_id AND s.record_id=r.record_id AND s.tenant_id=r.tenant_id WHERE r.id=ANY(path_) AND (removed_ IS NULL OR r.attempt_id<>removed_) ORDER BY r.ordinal LOOP
  SELECT jsonb_build_object('version',1,'baselineSnapshotId',baseline_,'chains',coalesce(jsonb_object_agg(key,retained) FILTER(WHERE jsonb_array_length(retained)>0),'{}'::jsonb)) INTO projected_ FROM(
   SELECT key,coalesce((SELECT jsonb_agg(entry.value ORDER BY entry.ordinal) FROM jsonb_array_elements(chain.value) WITH ORDINALITY entry(value,ordinal) WHERE entry.value->>'attemptId' IS NULL OR(entry.value->>'attemptId'<>new_owner_::text AND EXISTS(SELECT 1 FROM public.payroll_history_import_revision r WHERE r.id=ANY(path_) AND r.attempt_id=(entry.value->>'attemptId')::uuid AND r.ordinal<=original_.ordinal))),'[]'::jsonb) retained FROM jsonb_each(state_->'chains') chain
  ) chains;
  IF NOT app.payroll_history_maintenance_state_matches(projected_,original_."values") THEN RETURN false;END IF;
  FOR line_ IN SELECT value FROM jsonb_array_elements(coalesce(original_."values"->'statutory'->'importedLines',original_."values"->'statutory'->'componentLines','[]'::jsonb)) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_each(projected_->'chains') chain CROSS JOIN LATERAL jsonb_array_elements(chain.value) entry WHERE (CASE WHEN original_.kind='adopted' THEN entry->>'attemptId' IS NULL ELSE entry->>'attemptId'=original_.attempt_id::text END) AND entry->'item'<>'null'::jsonb AND (upper(entry->'item'->>'code')=upper(line_->>'code') OR(entry->'item'->'originalCodes')?(line_->>'code'))) THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_legacy_proven(uuid,uuid,jsonb,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_maintenance_state_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE previous_ public.payroll_history_import_revision; state_ jsonb; prior_ jsonb; expected_ jsonb; baseline_ uuid; first_baseline_ uuid; mode_ text; request_ jsonb; target_ uuid; chain_ record; entry_ jsonb; tail_ jsonb; item_ jsonb; count_ integer; old_ jsonb; prior_values_ jsonb; source_owner_ uuid; legacy_before_ jsonb; last_ordinal_ integer; ordinal_ integer;
BEGIN
 SELECT * INTO previous_ FROM public.payroll_history_import_revision WHERE id=NEW.previous_revision_id AND record_id=NEW.record_id AND tenant_id=NEW.tenant_id;
 IF previous_.maintenance IS NOT NULL AND NEW.maintenance IS NULL THEN RAISE EXCEPTION 'Payroll history maintenance cannot downgrade its immutable lineage' USING ERRCODE='23514';END IF;
 IF NEW.maintenance IS NULL THEN RETURN NEW;END IF;
 state_:=NEW.maintenance->'state';mode_:=NEW.maintenance->>'operation';
 IF mode_ IS NULL OR mode_ NOT IN ('replace','update_listed','edit','remove_items','remove_batch') OR NOT(state_?&ARRAY['version','baselineSnapshotId','chains']) THEN RAISE EXCEPTION 'Payroll history maintenance version or operation unavailable' USING ERRCODE='23514';END IF;
 SELECT a.plan->'maintenance'->'request' INTO request_ FROM public.payroll_history_import_attempt a WHERE a.id=NEW.attempt_id AND a.tenant_id=NEW.tenant_id;
 SELECT r.snapshot_id INTO first_baseline_ FROM public.payroll_history_import_revision r WHERE r.record_id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND r.ordinal=1 AND r.kind='adopted';
 baseline_:=nullif(state_->>'baselineSnapshotId','')::uuid;
 IF baseline_ IS DISTINCT FROM first_baseline_ THEN RAISE EXCEPTION 'Payroll history maintenance baseline identity changed' USING ERRCODE='23514';END IF;
 IF mode_ IN ('edit','remove_items') AND ((request_->>'recordId')::uuid IS DISTINCT FROM NEW.record_id OR(request_->>'expectedRevisionId')::uuid IS DISTINCT FROM NEW.previous_revision_id) THEN RAISE EXCEPTION 'Payroll history maintenance request revision changed' USING ERRCODE='23514';END IF;
 IF mode_='remove_batch' THEN
  target_:=(request_->>'attemptId')::uuid;
  IF target_ IS NULL OR target_=NEW.attempt_id OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_event event WHERE event.attempt_id=target_ AND event.tenant_id=NEW.tenant_id AND event.kind='confirmed') OR NOT EXISTS(SELECT 1 FROM public.payroll_history_import_revision r WHERE r.record_id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND r.attempt_id=target_) THEN RAISE EXCEPTION 'Payroll history maintenance removal ownership unavailable' USING ERRCODE='23514';END IF;
 END IF;
 FOR chain_ IN SELECT key,value FROM jsonb_each(state_->'chains') LOOP
  IF jsonb_typeof(chain_.value) IS DISTINCT FROM 'array' OR jsonb_array_length(chain_.value)<1 THEN RAISE EXCEPTION 'Payroll history maintenance chain unavailable' USING ERRCODE='23514';END IF;
  count_:=0;last_ordinal_:=2147483647;
  FOR entry_ IN SELECT value FROM jsonb_array_elements(chain_.value) LOOP
   item_:=entry_->'item';
   IF jsonb_typeof(entry_) IS DISTINCT FROM 'object' OR NOT(entry_?&ARRAY['attemptId','item']) OR (item_<>'null'::jsonb AND (jsonb_typeof(item_) IS DISTINCT FROM 'object' OR item_->>'key' IS DISTINCT FROM chain_.key OR coalesce(item_->>'amount','')!~'^[0-9]+\.[0-9]{2}$' OR length(item_->>'amount')>13 OR coalesce(item_->>'direction','') NOT IN ('earning','deduction','noncash','statutory'))) THEN RAISE EXCEPTION 'Payroll history maintenance item identity unavailable' USING ERRCODE='23514';END IF;
   IF item_<>'null'::jsonb AND NOT CASE item_->>'destination'
    WHEN 'basic' THEN item_->>'direction'='earning' AND chain_.key='destination:basic'
    WHEN 'allowance' THEN item_->>'direction'='earning' AND chain_.key LIKE 'component:%'
    WHEN 'overtime' THEN item_->>'direction'='earning' AND chain_.key LIKE 'component:%'
    WHEN 'bonus' THEN item_->>'direction'='earning' AND chain_.key LIKE 'component:%'
    WHEN 'other_deduction' THEN item_->>'direction'='deduction' AND chain_.key LIKE 'component:%'
    WHEN 'noncash' THEN item_->>'direction'='noncash' AND chain_.key LIKE 'component:%'
    ELSE item_->>'direction'='statutory' AND chain_.key='statutory:'||(item_->>'destination') AND item_->>'destination'=ANY(ARRAY['epf_employee','epf_employer','socso_employee','socso_employer','socso_skbbk','eis_employee','eis_employer','pcb','cp38','zakat','lp','hrdf']) END
   THEN RAISE EXCEPTION 'Payroll history maintenance monetary kind changed' USING ERRCODE='23514';END IF;
   IF entry_->>'attemptId'=NEW.attempt_id::text THEN
    IF count_<>0 THEN RAISE EXCEPTION 'Payroll history maintenance cannot rewrite an earlier owner' USING ERRCODE='23514';END IF;
   ELSE
    IF NOT app.payroll_history_maintenance_item_proven(NEW.record_id,baseline_,entry_) THEN RAISE EXCEPTION 'Payroll history maintenance original item proof unavailable' USING ERRCODE='23514';END IF;
    IF entry_->>'attemptId' IS NOT NULL THEN
     SELECT max(r.ordinal) INTO ordinal_ FROM public.payroll_history_import_revision r WHERE r.record_id=NEW.record_id AND r.tenant_id=NEW.tenant_id AND r.attempt_id=(entry_->>'attemptId')::uuid AND r.kind IN ('import','correction');
     IF ordinal_ IS NULL OR ordinal_>=last_ordinal_ THEN RAISE EXCEPTION 'Payroll history maintenance source order changed' USING ERRCODE='23514';END IF;last_ordinal_:=ordinal_;
    ELSE last_ordinal_:=0;END IF;
   END IF;count_:=count_+1;
  END LOOP;
 END LOOP;
 IF NOT app.payroll_history_maintenance_state_matches(state_,(SELECT s."values" FROM public.payroll_history_import_snapshot s WHERE s.id=NEW.snapshot_id AND s.record_id=NEW.record_id AND s.tenant_id=NEW.tenant_id)) THEN RAISE EXCEPTION 'Payroll history maintenance item totals do not match its snapshot' USING ERRCODE='23514';END IF;
 prior_:=previous_.maintenance->'state';
 IF prior_ IS NOT NULL THEN
  IF state_=prior_ THEN RETURN NEW;END IF;
  IF mode_='remove_batch' THEN
   SELECT jsonb_build_object('version',1,'baselineSnapshotId',prior_->'baselineSnapshotId','chains',coalesce(jsonb_object_agg(key,kept) FILTER(WHERE jsonb_array_length(kept)>0),'{}'::jsonb)) INTO expected_ FROM(SELECT key,coalesce((SELECT jsonb_agg(value ORDER BY ordinal) FROM jsonb_array_elements(chain.value) WITH ORDINALITY entry(value,ordinal) WHERE value->>'attemptId' IS DISTINCT FROM target_::text),'[]'::jsonb) kept FROM jsonb_each(prior_->'chains') chain) filtered;
  ELSIF mode_='remove_items' THEN
   expected_:=prior_;FOR chain_ IN SELECT key,value FROM jsonb_each(prior_->'chains') LOOP IF(request_->'itemKeys')?chain_.key THEN expected_:=jsonb_set(expected_,ARRAY['chains',chain_.key],jsonb_build_array(jsonb_build_object('attemptId',NEW.attempt_id,'item',NULL))||chain_.value);END IF;END LOOP;
  ELSE
   expected_:=prior_;
   FOR chain_ IN SELECT key,value FROM jsonb_each(state_->'chains') LOOP
    old_:=prior_->'chains'->chain_.key;
    IF chain_.value->0->>'attemptId'=NEW.attempt_id::text THEN
     tail_:=chain_.value-0;IF tail_ IS DISTINCT FROM coalesce(old_,'[]'::jsonb) THEN RAISE EXCEPTION 'Payroll history maintenance changed an earlier contribution' USING ERRCODE='23514';END IF;
     IF mode_='edit' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(request_->'items') change WHERE change->>'key'=chain_.key AND change->>'amount'=chain_.value->0->'item'->>'amount') THEN RAISE EXCEPTION 'Payroll history maintenance edit does not match its reviewed item' USING ERRCODE='23514';END IF;
     expected_:=jsonb_set(expected_,ARRAY['chains',chain_.key],chain_.value,true);
    ELSIF chain_.value IS DISTINCT FROM old_ THEN RAISE EXCEPTION 'Payroll history maintenance lost or forged an original owner' USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
  -- If all imported contributions are removed, restoration is the retained native owner only.
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(expected_->'chains') chain WHERE chain.value->0->'item'<>'null'::jsonb AND chain.value->0->>'attemptId' IS NOT NULL) THEN
   SELECT jsonb_build_object('version',1,'baselineSnapshotId',prior_->'baselineSnapshotId','chains',coalesce(jsonb_object_agg(key,jsonb_build_array(native)) FILTER(WHERE native IS NOT NULL),'{}'::jsonb)) INTO expected_ FROM(SELECT key,(SELECT value FROM jsonb_array_elements(chain.value) WITH ORDINALITY entry(value,ordinal) WHERE value->>'attemptId' IS NULL AND value->'item'<>'null'::jsonb ORDER BY ordinal LIMIT 1) native FROM jsonb_each(prior_->'chains') chain) baseline;
  END IF;
  IF state_ IS DISTINCT FROM expected_ THEN RAISE EXCEPTION 'Payroll history maintenance transition does not preserve its original lineage' USING ERRCODE='23514';END IF;
 ELSE
  IF NEW.kind='revert' THEN
   -- Full withdrawal/restoration cannot keep hidden imported owners to resurrect later.
   IF EXISTS(SELECT 1 FROM jsonb_each(state_->'chains') chain CROSS JOIN LATERAL jsonb_array_elements(chain.value) entry WHERE entry->>'attemptId' IS NOT NULL) OR NEW.snapshot_id IS DISTINCT FROM baseline_ THEN RAISE EXCEPTION 'Payroll history maintenance withdrawal baseline changed' USING ERRCODE='23514';END IF;
  ELSIF NOT app.payroll_history_maintenance_legacy_proven(NEW.record_id,NEW.previous_revision_id,state_,NEW.attempt_id,target_) THEN RAISE EXCEPTION 'Payroll history maintenance original chain does not match accepted legacy history' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION 'Payroll history maintenance source identity unavailable' USING ERRCODE='23514';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_maintenance_state_bind() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_history_maintenance_state_binding BEFORE INSERT ON public.payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_maintenance_state_bind();
