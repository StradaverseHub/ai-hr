-- UNAPPLIED PROVISIONAL development compatibility allocation0754/idx733/when1793330000091.
-- Original0734/0744 and all historical SQL remain immutable. Reconcile actual ledger at integration.
-- Four exact live-target FKs become immutable historical bindings. Event FKs remain.
DO $$
DECLARE binding record;constraint_row record;found_count integer;
BEGIN
 FOR binding IN SELECT * FROM (VALUES
  ('payroll_reopen_batch_id','public.payroll_batch'),
  ('payroll_reopen_period_id','public.pay_period'),
  ('payroll_reset_batch_id','public.payroll_batch'),
  ('payroll_reset_period_id','public.pay_period')
 ) AS names(column_name,target_name) LOOP
  SELECT count(*) INTO found_count FROM pg_constraint c JOIN pg_attribute a
   ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f'
    AND cardinality(c.conkey)=1 AND a.attname=binding.column_name
    AND c.confrelid=binding.target_name::regclass AND c.confdeltype='a';
  IF found_count<>1 THEN RAISE EXCEPTION 'Payroll review live-target FK drift: %',binding.column_name;END IF;
  SELECT c.conname INTO constraint_row FROM pg_constraint c JOIN pg_attribute a
   ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f'
    AND cardinality(c.conkey)=1 AND a.attname=binding.column_name
    AND c.confrelid=binding.target_name::regclass AND c.confdeltype='a';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_row.conname);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_review_historical_binding() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch_id uuid;period_id uuid;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'Payroll review binding operation unavailable';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.action_kind IN('payroll.reopen','payroll.reset') OR NEW.action_kind IN('payroll.reopen','payroll.reset')) THEN
  IF ROW(NEW.id,NEW.tenant_id,NEW.user_id,NEW.company_id,NEW.action_kind,
   NEW.payroll_reopen_batch_id,NEW.payroll_reopen_period_id,NEW.payroll_reset_batch_id,NEW.payroll_reset_period_id)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.user_id,OLD.company_id,OLD.action_kind,
   OLD.payroll_reopen_batch_id,OLD.payroll_reopen_period_id,OLD.payroll_reset_batch_id,OLD.payroll_reset_period_id)
  THEN RAISE EXCEPTION 'Payroll review historical binding is immutable' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='INSERT' AND NEW.action_kind IN('payroll.reopen','payroll.reset') THEN
  batch_id:=CASE WHEN NEW.action_kind='payroll.reopen' THEN NEW.payroll_reopen_batch_id ELSE NEW.payroll_reset_batch_id END;
  period_id:=CASE WHEN NEW.action_kind='payroll.reopen' THEN NEW.payroll_reopen_period_id ELSE NEW.payroll_reset_period_id END;
  -- Replace FK deletion concurrency protection, not just a snapshot EXISTS. Match native
  -- physical delete order: batch BEFORE optional parent. Both locks live until whole Tx end.
  PERFORM b.id FROM public.payroll_batch b
   WHERE b.id=batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id
    AND b.pay_period_id=period_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll review target binding unavailable' USING ERRCODE='23503';END IF;
  PERFORM p.id FROM public.pay_period p JOIN public.payroll_batch b ON b.pay_period_id=p.id
   WHERE b.id=batch_id AND p.id=period_id AND b.tenant_id=NEW.tenant_id AND p.tenant_id=NEW.tenant_id
    AND b.company_id=NEW.company_id AND p.company_id=NEW.company_id AND p.period=b.pay_period
   FOR KEY SHARE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll review target binding unavailable' USING ERRCODE='23503';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_review_historical_binding() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_review_historical_binding AFTER INSERT OR UPDATE ON app.assistant_own_leave_review
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_historical_binding();
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_review_target_deleted() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_is_batch boolean;review_row record;
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID NOT IN('public.payroll_batch'::regclass,'public.pay_period'::regclass) THEN
  RAISE EXCEPTION 'Payroll review retirement operation unavailable';
 END IF;
 target_is_batch:=TG_RELID='public.payroll_batch'::regclass;
 -- No new scope/status restriction on unrelated native/SYSTEM/owner/tenant cleanup paths.
 IF NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END)))
 THEN RETURN NULL;END IF;
 -- Actual OLD row already deleted through native/RLS owner; never a caller-nominated target UUID.
 -- Same financial scope used by canonical teardown's Attendance release. Keep native SYSTEM semantics.
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.can_admin_payroll_for(OLD.company_id)
  OR (target_is_batch AND OLD.status::text<>'draft') OR (NOT target_is_batch AND OLD.status::text<>'open')
 THEN RAISE EXCEPTION 'Payroll review target deletion unavailable' USING ERRCODE='42501';END IF;
 FOR review_row IN SELECT r.id FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END))
  ORDER BY r.user_id,r.id FOR UPDATE NOWAIT
 LOOP
  PERFORM action_id FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id FOR UPDATE NOWAIT;
  -- Cross-user pending rows target the actually deleted run; no sibling/foreign-company selection.
  UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL,
   payroll_reopen_person_ids=NULL,payroll_reset_person_ids=NULL,payroll_reset_proof=NULL
   WHERE id=review_row.id AND state='awaiting_confirmation';
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id;
 END LOOP;
 -- Completed minimal ledger/event/protected historical commitment remains; no change to canonical
 -- native_outcome_source_capture/targets/association retention or its PDPA discovery ownership.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_review_target_deleted() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_review_batch_deleted AFTER DELETE ON public.payroll_batch
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_target_deleted();
CREATE TRIGGER assistant_payroll_review_period_deleted AFTER DELETE ON public.pay_period
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_target_deleted();
