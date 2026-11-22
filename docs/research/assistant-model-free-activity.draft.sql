-- Unallocated. Apply under the restricted migration owner in a disposable database.
-- The coordinator allocates the journal slot after checking both installed ledgers.
CREATE TABLE app.assistant_model_free_answer_day (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  question_day date NOT NULL,
  answer_count bigint NOT NULL CHECK (answer_count > 0),
  PRIMARY KEY (tenant_id, question_day)
);
ALTER TABLE app.assistant_model_free_answer_day ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.assistant_model_free_answer_day FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._record_assistant_model_free_answer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- The native completion already checked that this exchange and usage were both
  -- written in this transaction. Inspect only the completed caller's new row.
  INSERT INTO app.assistant_model_free_answer_day AS counter (tenant_id, question_day, answer_count)
  SELECT NEW.tenant_id, NEW.question_day, 1
    FROM public.assistant_exchange AS e
   WHERE e.id = NEW.exchange_id AND e.tenant_id = NEW.tenant_id AND e.app_user_id = NEW.user_id
     AND e.content_retired_at IS NULL AND e.disclosure_receipt IS NOT NULL AND e.error IS NULL
     AND e.stop = 'end' AND e.turn_count = 0 AND e.provider IS NULL AND e.model IS NULL
     AND e.input_tokens = 0 AND e.output_tokens = 0 AND e.cached_input_tokens = 0
     AND CASE WHEN pg_input_is_valid(e.answer, 'jsonb') THEN
       e.answer::jsonb @> '{"version":1,"mode":"answer"}'::jsonb
       ELSE false END
  ON CONFLICT (tenant_id, question_day) DO UPDATE SET answer_count = counter.answer_count + 1;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._record_assistant_model_free_answer() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER assistant_record_model_free_answer
AFTER UPDATE OF completed_at ON app.assistant_question_budget
FOR EACH ROW
WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
  AND NEW.exchange_id IS NOT NULL AND NEW.accounted_tokens = 0)
EXECUTE FUNCTION app._record_assistant_model_free_answer();
--> statement-breakpoint
CREATE FUNCTION app.assistant_model_free_answer_activity() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  business_day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
  IF tenant IS NULL OR app.current_user_id() IS NULL OR app.is_group_admin() IS NOT TRUE
    OR app.principal_snapshot_current() IS NOT TRUE THEN
    RAISE EXCEPTION 'Assistant activity unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN (
    SELECT coalesce(sum(d.answer_count), 0)::bigint
      FROM app.assistant_model_free_answer_day AS d
     WHERE d.tenant_id = tenant AND d.question_day BETWEEN business_day - 29 AND business_day
  );
END $$;
REVOKE ALL ON FUNCTION app.assistant_model_free_answer_activity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_model_free_answer_activity() TO ai_hr_app;
