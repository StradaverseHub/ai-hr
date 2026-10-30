-- ADR-0151 personnel parity: one human-reviewed compensation register operation.
-- PROVISIONAL SOURCE CLAIM ONLY: 0715 / idx696 / when1793330000044. Reallocate above the
-- then-live accepted ledger at integration freeze. No installation priority or deployment authority.
-- Reuse the one prepared-action ledger and its generic ASSIGNED custody. Every prior kind retains
-- its prior constraints, binding, verifier and receipt behaviour; no historical SQL is edited.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('employees.compensation.maintain','employees','approve','pay','employees.compensation.maintain');
--> statement-breakpoint
-- Extend the existing HR generic branch itself, preserving its complete predicate. Other dedicated
-- receipt families retain their separate null-column CHECKs from 0622. Refuse unexpected schema drift.
DO $$
DECLARE previous text;marker constant text:='''employees.qualification.maintain''::text';
BEGIN
 SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
  WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname='assistant_review_kind_columns' AND c.contype='c';
 IF previous IS NULL OR (length(previous)-length(replace(previous,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION '0715: expected one existing HR generic column branch';END IF;
 ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT assistant_review_kind_columns;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK ('||
  replace(previous,marker,'''employees.qualification.maintain''::text, ''employees.compensation.maintain''::text')||')';
END $$;
--> statement-breakpoint
-- Preserve each remaining prior expression exactly, adding only a branch for this kind.
DO $$
DECLARE item record;previous text;added text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('assistant_review_decision_columns', 'decision_subject_person_id IS NOT NULL AND decision_request_id IS NULL AND decision_step_id IS NULL AND decision_event_id IS NULL AND decision_applicant_person_id IS NULL'),
  ('assistant_review_generic_receipt', 'receipt_subject_kind=''employment'' AND receipt_subject_id=employment_id AND ((state=''completed'')=(receipt_event_id IS NOT NULL))')
 ) AS requirements(name,expression) LOOP
  SELECT pg_get_expr(c.conbin,c.conrelid) INTO previous FROM pg_constraint c
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.conname=item.name AND c.contype='c';
  IF previous IS NULL THEN RAISE EXCEPTION '0715: missing custody constraint %',item.name;END IF;
  added:='CASE WHEN action_kind=''employees.compensation.maintain'' THEN ('||item.expression||') ELSE ('||previous||') END';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (%s)',item.name,added);
 END LOOP;
END $$;
--> statement-breakpoint
-- One pending review per employment PER ADMINISTRATOR, preserving every previous index predicate.
DO $$
DECLARE generic_predicate text;assigned_predicate text;
BEGIN
 SELECT pg_get_expr(indpred,indrelid) INTO generic_predicate FROM pg_index WHERE indexrelid='app.assistant_review_generic_pending_subject'::regclass;
 SELECT pg_get_expr(indpred,indrelid) INTO assigned_predicate FROM pg_index WHERE indexrelid='app.assistant_review_assigned_pending_subject'::regclass;
 IF generic_predicate IS NULL OR assigned_predicate IS NULL THEN RAISE EXCEPTION '0715: missing custody indexes';END IF;
 DROP INDEX app.assistant_review_generic_pending_subject;
 DROP INDEX app.assistant_review_assigned_pending_subject;
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id) WHERE ('||generic_predicate||') AND action_kind<>''employees.compensation.maintain''';
 EXECUTE 'CREATE UNIQUE INDEX assistant_review_assigned_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id,user_id) WHERE ('||assigned_predicate||') OR (action_kind=''employees.compensation.maintain'' AND receipt_subject_id IS NOT NULL AND state=''awaiting_confirmation'')';
END $$;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_subject_kind(text) RENAME TO _assistant_assigned_review_subject_kind_0715_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_kind='employees.compensation.maintain' THEN 'employment'
  ELSE app._assistant_assigned_review_subject_kind_0715_previous(p_kind) END;
$$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_subject_kind_0715_previous(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) RENAME TO _assistant_assigned_review_binding_0715_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_binding(p_kind text,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_assigned_review_binding_0715_previous(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 IF p_kind='employees.compensation.maintain' AND (p_subject IS DISTINCT FROM p_employment
  OR app.is_admin() IS NOT TRUE OR (app.can_admin_employment(p_employment) OR app.can_admin_perfcomp_employment(p_employment)) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Compensation review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_binding_0715_previous(text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0715_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();x xid:=pg_current_xact_id()::xid;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind<>'employees.compensation.maintain' THEN RETURN app._assistant_generic_review_verify_0715_previous(p_id,p_event);END IF;
 IF r.receipt_subject_kind IS DISTINCT FROM 'employment' OR r.receipt_subject_id IS DISTINCT FROM r.employment_id
  OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=r.employment_id AND e.tenant_id=t AND e.company_id=r.company_id AND e.person_id=r.decision_subject_person_id)
  OR r.person_id IS NOT DISTINCT FROM r.decision_subject_person_id
  OR EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id=r.decision_subject_person_id)
  OR app.is_admin() IS NOT TRUE OR (app.can_admin_employment(r.employment_id) OR app.can_admin_perfcomp_employment(r.employment_id)) IS NOT TRUE THEN RETURN false;END IF;
 -- Both the native row and event must have been written HERE, by THIS login, for THIS employment.
 -- A current event alone cannot bless an old/foreign row, a different aggregate, or a wrong state.
 RETURN EXISTS(SELECT 1 FROM public.compensation q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
  WHERE q.tenant_id=t AND q.employment_id=r.employment_id AND q.xmin=x AND d.id=p_event AND d.xmin=x
   AND d.aggregate_type='compensation' AND d.subject_employment_id=r.employment_id
   AND d.actor_type='user' AND d.actor_id=u
   AND ((d.event_type IN('compensation.set','compensation.updated') AND q.superseded_at IS NULL AND q.valid_to IS NULL)
    OR (d.event_type='compensation.superseded' AND q.superseded_at IS NOT NULL)));
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0715_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Extend whichever reviewed predecessor is present at freeze (including other personnel packages).
-- Preserve its closed kinds and event mapping; never replace another package with a copied old list.
DO $$
DECLARE previous text;marker text;replacement text;signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)'] LOOP
  previous:=pg_get_functiondef(signature::regprocedure);
  IF signature LIKE '%native_outcome_targets_require%' THEN
   marker:='WHEN ''employees.qualification.maintain'' THEN r.receipt_event_id';
   replacement:=marker||' WHEN ''employees.compensation.maintain'' THEN r.receipt_event_id';
  ELSE
   marker:='''employees.qualification.maintain''';
   replacement:=marker||',''employees.compensation.maintain''';
  END IF;
  IF (length(previous)-length(replace(previous,marker,'')))/length(marker)<>1 THEN
   RAISE EXCEPTION '0715: unexpected native outcome owner %',signature;END IF;
  previous:=replace(previous,marker,replacement);
  IF signature LIKE '%native_outcome_completed_review_choices%' THEN
   previous:=regexp_replace(previous,'NOT BETWEEN 1 AND [0-9]+','NOT BETWEEN 1 AND (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
   previous:=regexp_replace(previous,'LIMIT [0-9]+','LIMIT (SELECT count(*) FROM app.assistant_action_kind WHERE review_kind IS NOT NULL)','g');
  END IF;
  EXECUTE previous;
 END LOOP;
END $$;
