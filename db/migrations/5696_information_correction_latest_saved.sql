-- Board 4604dccc revision 4 (docs/MIGRATION-ALLOCATION.md): 5696_information_correction_latest_saved, idx 5096, when 1793330005396.
-- ADR 2026-11-15 dated information corrections, revision 4: the LATEST SAVED information correction controls each
-- field it changes from its Effective Date onward. The SQL readers that answer a day from a correction's before-image
-- move from "the earliest-saved correction dated after the day" to the rule of core/information-correction-history.ts
-- employmentInformationAt: the before-image comes only from a correction saved after the one in force on the day (the
-- latest saved correction that changed the field and is dated on or before it), the earliest such one first. When the
-- corrections were saved in Effective Date order every correction dated after the day was saved after the one in force,
-- so every answer is the same as before.
--
-- Each reader is re-created from its INSTALLED definition (pg_get_functiondef), which keeps its signature, SECURITY
-- DEFINER, SET options, owner, grants and every earlier rewrite (5012's release-aware import predicate), after checking
-- that it belongs to the migration owner and has exactly the reviewed number of before-image reads. A reader that
-- already carries this rewrite (the in_force bound) is left as it is, so replaying this file after a test oracle
-- re-installs an older owner (test/performance/personnel-search-fixture.ts) restores only what the oracle replaced.
-- No table, grant, policy or row changes.
--
--  * app.company_org_employment_company(uuid,date) (2126) and its set-based copies app._personnel_employment_tags,
--    app.personnel_overview_facts, app.personnel_overview_filter_fields (5121) and app.personnel_overview_narrow_rows
--    (5010, rewritten by 5012): the company before-image read gains the in-force sequence bound for companyId. Their
--    tenant-wide "any correction dated after the day" presence gates are unchanged (a superset).
--  * app.information_report_records(text,uuid,text) (0698): its one before-image lateral, read for companyId, hiredOn
--    and joinDate, becomes one lateral per field, each with that field's in-force bound.
DO $$
DECLARE r record; def text; found integer; owner_ name;
 pattern constant text:=$p$ev\.event_type='employment\.information\.corrected' AND ev\.payload->>'effectiveOn'>(p_[a-z_]+)::text$p$;
 bounded constant text:=$r$ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>\1::text AND ev.sequence>coalesce((SELECT max(in_force.sequence) FROM public.domain_event in_force WHERE in_force.tenant_id=ev.tenant_id AND in_force.subject_employment_id=ev.subject_employment_id AND in_force.event_type='employment.information.corrected' AND in_force.payload->>'effectiveOn'<=\1::text AND CASE WHEN jsonb_typeof(in_force.payload->'fields')='array' THEN in_force.payload->'fields' @> '["companyId"]'::jsonb ELSE (in_force.payload->'before'->>'companyId') IS DISTINCT FROM (in_force.payload->'after'->>'companyId') END),0)$r$;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('app.company_org_employment_company(uuid,date)'),
  ('app._personnel_employment_tags(uuid[],date)'),
  ('app.personnel_overview_facts(date,uuid[])'),
  ('app.personnel_overview_filter_fields(date,uuid[])'),
  ('app.personnel_overview_narrow_rows(date,uuid[])')
 ) v(sig) LOOP
  SELECT o.rolname INTO owner_ FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid=r.sig::regprocedure;
  IF owner_<>current_user THEN RAISE EXCEPTION 'latest saved correction: % belongs to %, not the migration owner',r.sig,owner_ USING ERRCODE='42501'; END IF;
  def:=pg_catalog.pg_get_functiondef(r.sig::regprocedure);
  CONTINUE WHEN position('in_force' IN def)<>0;
  SELECT count(*) INTO found FROM regexp_matches(def,pattern,'g');
  IF found<>1 THEN RAISE EXCEPTION 'latest saved correction: % has % before-image reads, expected 1',r.sig,found USING ERRCODE='55000'; END IF;
  EXECUTE regexp_replace(def,pattern,bounded,'g');
 END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE def text; owner_ name; edit record;
 day_ constant text:=$d$CASE WHEN length(p_period)=4 THEN p_period||'-12-31' ELSE p_period||'-01' END$d$;
 lateral_ constant text:=$o$ LEFT JOIN LATERAL(SELECT ev.payload->'before' AS value FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>CASE WHEN length(p_period)=4 THEN p_period||'-12-31' ELSE p_period||'-01' END ORDER BY ev.sequence LIMIT 1) prior ON true$o$;
 replacement text:='';
 field text; alias_ text;
BEGIN
 IF position('in_force' IN pg_catalog.pg_get_functiondef('app.information_report_records(text,uuid,text)'::regprocedure))<>0 THEN RETURN; END IF;
 SELECT o.rolname INTO owner_ FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid=p.proowner WHERE p.oid='app.information_report_records(text,uuid,text)'::regprocedure;
 IF owner_<>current_user THEN RAISE EXCEPTION 'latest saved correction: app.information_report_records belongs to %, not the migration owner',owner_ USING ERRCODE='42501'; END IF;
 def:=pg_catalog.pg_get_functiondef('app.information_report_records(text,uuid,text)'::regprocedure);
 IF (length(def)-length(replace(def,lateral_,'')))/length(lateral_)<>1 THEN
  RAISE EXCEPTION 'latest saved correction: app.information_report_records differs from its reviewed predecessor' USING ERRCODE='55000';
 END IF;
 -- One before-image per field, each bounded by the correction in force for that field.
 FOR field,alias_ IN SELECT * FROM (VALUES ('companyId','prior_company'),('hiredOn','prior_hired'),('joinDate','prior_join')) v(f,a) LOOP
  replacement:=replacement||format($l$ LEFT JOIN LATERAL(SELECT ev.payload->'before' AS value FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>%1$s AND ev.sequence>coalesce((SELECT max(in_force.sequence) FROM public.domain_event in_force WHERE in_force.tenant_id=ev.tenant_id AND in_force.subject_employment_id=ev.subject_employment_id AND in_force.event_type='employment.information.corrected' AND in_force.payload->>'effectiveOn'<=%1$s AND CASE WHEN jsonb_typeof(in_force.payload->'fields')='array' THEN in_force.payload->'fields' @> jsonb_build_array(%2$L::text) ELSE (in_force.payload->'before'->>%2$L) IS DISTINCT FROM (in_force.payload->'after'->>%2$L) END),0) ORDER BY ev.sequence LIMIT 1) %3$s ON true$l$,day_,field,alias_);
 END LOOP;
 def:=replace(def,lateral_,replacement);
 FOR edit IN SELECT * FROM (VALUES
  ($e$coalesce(prior.value->>'companyId',e.company_id::text)$e$,$e$coalesce(prior_company.value->>'companyId',e.company_id::text)$e$),
  ($e$coalesce(prior.value->>'hiredOn',e.hired_on::text)$e$,$e$coalesce(prior_hired.value->>'hiredOn',e.hired_on::text)$e$),
  ($e$CASE WHEN prior.value IS NOT NULL THEN prior.value->>'joinDate' ELSE e.join_date::text END$e$,$e$CASE WHEN prior_join.value IS NOT NULL THEN prior_join.value->>'joinDate' ELSE e.join_date::text END$e$)
 ) v(old_text,new_text) LOOP
  IF (length(def)-length(replace(def,edit.old_text,'')))/length(edit.old_text)<>1 THEN
   RAISE EXCEPTION 'latest saved correction: app.information_report_records reads % an unexpected number of times',edit.old_text USING ERRCODE='55000';
  END IF;
  def:=replace(def,edit.old_text,edit.new_text);
 END LOOP;
 IF position('prior.' IN def)<>0 THEN RAISE EXCEPTION 'latest saved correction: app.information_report_records keeps an unbounded before-image read' USING ERRCODE='55000'; END IF;
 EXECUTE def;
END $$;
