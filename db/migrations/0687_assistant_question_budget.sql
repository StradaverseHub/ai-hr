-- Owner-approved successor to the independently verified 562-entry staging ledger.
-- Daily question intent only; existing ai_model_run owns actual/held provider token exposure.
-- No prompts, answers, HR records or additional effect authority are stored here.
CREATE TABLE app.assistant_question_budget(
 root_id uuid PRIMARY KEY REFERENCES app.ai_spend_task(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),user_id uuid NOT NULL REFERENCES public.app_user(id),
 question_day date NOT NULL,period text NOT NULL CONSTRAINT assistant_question_budget_period_format CHECK(period~'^[0-9]{4}-[0-9]{2}$'),
 reserved_at timestamptz NOT NULL DEFAULT now(),
 exchange_id uuid UNIQUE REFERENCES public.assistant_exchange(id) ON DELETE SET NULL,
 accounted_tokens bigint NOT NULL DEFAULT 0 CONSTRAINT assistant_question_budget_nonnegative CHECK(accounted_tokens>=0),completed_at timestamptz,
 CONSTRAINT assistant_question_budget_question_period CHECK(period=to_char(question_day,'YYYY-MM')),
 CONSTRAINT assistant_question_budget_completion CHECK(completed_at IS NOT NULL OR(exchange_id IS NULL AND accounted_tokens=0))
);
ALTER TABLE app.assistant_question_budget ENABLE ROW LEVEL SECURITY;
-- Private custody: application access is exclusively through the bounded definer functions below.
-- The physical owner retains ordinary owner access; FORCE RLS without owner policies would deny it.
REVOKE ALL ON app.assistant_question_budget FROM PUBLIC,ai_hr_app;
CREATE INDEX assistant_question_budget_day ON app.assistant_question_budget(tenant_id,user_id,question_day);
CREATE INDEX assistant_question_budget_period ON app.assistant_question_budget(tenant_id,period);
CREATE INDEX ai_spend_question_root ON app.ai_spend_admission_scope(tenant_id,root_id) WHERE feature_id='hr_assistant';
--> statement-breakpoint
CREATE FUNCTION app._assistant_question_budget_exposure(wanted_period text)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT u.input_tokens::numeric+u.output_tokens+u.cached_input_tokens
  FROM public.assistant_usage u WHERE u.tenant_id=app.current_tenant_id() AND u.period=wanted_period),0)
 +coalesce((SELECT sum(greatest(coalesce((SELECT sum(coalesce(m.actual_tokens,m.reserved_tokens))
   FROM app.ai_spend_admission_scope a JOIN public.ai_model_run m ON m.id=a.run_id AND m.tenant_id=a.tenant_id
   WHERE a.tenant_id=q.tenant_id AND a.root_id=q.root_id AND a.feature_id='hr_assistant' AND m.state<>'blocked'),0)-q.accounted_tokens,0))
  FROM app.assistant_question_budget q WHERE q.tenant_id=app.current_tenant_id() AND q.period=wanted_period),0)
$$;
REVOKE ALL ON FUNCTION app._assistant_question_budget_exposure(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_question_budget_reserve(wanted_root uuid)
 RETURNS TABLE(period text,reserved_at timestamptz,blocked_reason text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();task app.ai_spend_task;
 business_day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;day_start timestamptz;
 budget public.assistant_budget;used_questions bigint;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_root IS NULL OR current_setting('transaction_isolation')<>'read committed'
 OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Assistant question quota unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT t.* INTO task FROM app.ai_spend_task t WHERE t.id=wanted_root AND t.tenant_id=tid AND t.created_by=uid
 AND t.feature_id='hr_assistant' AND t.source_kind='assistant_question' AND t.operation='question'
 AND t.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR app._ai_spend_task_source_allowed(task.feature_id,task.source_kind,task.source_id,task.operation) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM app.assistant_question_budget q WHERE q.root_id=wanted_root) THEN RAISE EXCEPTION 'Current native Assistant question required';END IF;
 period:=to_char(business_day,'YYYY-MM');reserved_at:=now();blocked_reason:=NULL;
 SELECT b.* INTO budget FROM public.assistant_budget b WHERE b.tenant_id=tid AND b.archived_at IS NULL
 AND b.effective_from<=business_day ORDER BY b.effective_from DESC LIMIT 1;
 IF FOUND THEN
  day_start:=business_day::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur';
  SELECT(SELECT count(*) FROM app.assistant_question_budget q WHERE q.tenant_id=tid AND q.user_id=uid AND q.question_day=business_day)
   +(SELECT count(*) FROM public.assistant_exchange e WHERE e.tenant_id=tid AND e.app_user_id=uid
    AND e.asked_at>=day_start AND e.asked_at<day_start+interval '1 day'
    AND NOT EXISTS(SELECT 1 FROM app.assistant_question_budget q WHERE q.exchange_id=e.id)) INTO used_questions;
  IF used_questions>=budget.per_user_daily_questions THEN blocked_reason:='budget_daily';
  ELSIF app._assistant_question_budget_exposure(period)>=budget.monthly_token_ceiling THEN blocked_reason:='budget_monthly';END IF;
 END IF;
 IF blocked_reason IS NULL THEN
  INSERT INTO app.assistant_question_budget(root_id,tenant_id,user_id,question_day,period,reserved_at)
   VALUES(wanted_root,tid,uid,business_day,period,reserved_at);
 END IF;
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.assistant_question_budget_reserve(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_question_budget_reserve(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_question_budget_admit(wanted_root uuid,wanted_tokens bigint)
 RETURNS TABLE(allowed boolean,blocked_reason text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();q app.assistant_question_budget;task app.ai_spend_task;
 budget public.assistant_budget;exposure numeric;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_root IS NULL OR wanted_tokens IS NULL OR wanted_tokens<0 OR wanted_tokens>1000000000
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Assistant question quota unavailable';END IF;
 -- Held until the caller's existing ai_admit + ai_spend_record_admission commit in this same transaction.
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT b.* INTO q FROM app.assistant_question_budget b WHERE b.root_id=wanted_root AND b.tenant_id=tid AND b.user_id=uid AND b.completed_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Current Assistant question reservation required';END IF;
 SELECT t.* INTO task FROM app.ai_spend_task t WHERE t.id=q.root_id AND t.tenant_id=tid AND t.created_by=uid
 AND t.feature_id='hr_assistant' AND t.source_kind='assistant_question' AND t.operation='question';
 IF NOT FOUND OR app._ai_spend_task_source_allowed(task.feature_id,task.source_kind,task.source_id,task.operation) IS NOT TRUE THEN RAISE EXCEPTION 'Current native Assistant question required';END IF;
 SELECT b.* INTO budget FROM public.assistant_budget b WHERE b.tenant_id=tid AND b.archived_at IS NULL
 AND b.effective_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date ORDER BY b.effective_from DESC LIMIT 1;
 allowed:=true;blocked_reason:=NULL;
 IF FOUND THEN
  exposure:=app._assistant_question_budget_exposure(q.period);
  IF exposure>=budget.monthly_token_ceiling OR exposure+wanted_tokens>budget.monthly_token_ceiling THEN allowed:=false;blocked_reason:='budget_monthly';END IF;
 END IF;
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
 RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.assistant_question_budget_admit(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_question_budget_admit(uuid,bigint) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_question_budget_complete(wanted_root uuid,wanted_exchange uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();q app.assistant_question_budget;e public.assistant_exchange;
 accounted bigint;
 saved_statement text:=current_setting('statement_timeout');saved_lock text:=current_setting('lock_timeout');
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_root IS NULL OR wanted_exchange IS NULL
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Assistant question accounting unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT b.* INTO q FROM app.assistant_question_budget b WHERE b.root_id=wanted_root AND b.tenant_id=tid AND b.user_id=uid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own Assistant question required';END IF;
 IF q.completed_at IS NOT NULL THEN
  IF q.exchange_id=wanted_exchange THEN
   PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);RETURN;
  END IF;
  RAISE EXCEPTION 'Assistant question already accounted';
 END IF;
 -- Accounting remains possible after access withdrawal: no HR source is read and no content is restored.
 SELECT x.* INTO e FROM public.assistant_exchange x WHERE x.id=wanted_exchange AND x.tenant_id=tid AND x.app_user_id=uid
 AND x.xmin=pg_current_xact_id()::xid;
 IF NOT FOUND THEN RAISE EXCEPTION 'New own Assistant exchange required';END IF;
 accounted:=e.input_tokens::bigint+e.output_tokens+e.cached_input_tokens;
 IF NOT EXISTS(SELECT 1 FROM public.assistant_usage u WHERE u.tenant_id=tid AND u.period=q.period
  AND u.xmin=pg_current_xact_id()::xid AND u.input_tokens::numeric+u.output_tokens+u.cached_input_tokens>=accounted) THEN RAISE EXCEPTION 'Same-transaction Assistant usage required';END IF;
 UPDATE app.assistant_question_budget b SET exchange_id=e.id,accounted_tokens=accounted,completed_at=now() WHERE b.root_id=q.root_id;
 PERFORM set_config('statement_timeout',saved_statement,true),set_config('lock_timeout',saved_lock,true);
END $$;
REVOKE ALL ON FUNCTION app.assistant_question_budget_complete(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_question_budget_complete(uuid,uuid) TO ai_hr_app;
