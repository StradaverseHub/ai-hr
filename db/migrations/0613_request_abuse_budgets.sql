-- Shared token buckets. No direct application table access or identity-bearing keys.
CREATE TABLE public.app_request_budget (
  budget_key text PRIMARY KEY CHECK (budget_key ~ '^[a-f0-9]{64}$'),
  tokens numeric NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX app_request_budget_expiry_idx ON public.app_request_budget(expires_at);
ALTER TABLE public.app_request_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_request_budget FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.consume_request_budget(p_key text, p_capacity integer, p_window_seconds integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  stamp timestamptz;
  previous public.app_request_budget%ROWTYPE;
  available numeric;
  retry_after integer;
BEGIN
  IF p_key !~ '^[a-f0-9]{64}$' OR p_capacity NOT BETWEEN 1 AND 10000
    OR p_window_seconds NOT BETWEEN 1 AND 3600 OR p_key IS NULL
    OR p_capacity IS NULL OR p_window_seconds IS NULL THEN
    RAISE EXCEPTION 'Invalid request budget';
  END IF;
  -- Advisory lock serializes first use as well as existing rows across app processes.
  PERFORM pg_advisory_xact_lock(hashtextextended('request-budget:' || p_key, 0));
  stamp := clock_timestamp();
  SELECT * INTO previous FROM public.app_request_budget WHERE budget_key = p_key FOR UPDATE;
  available := CASE WHEN NOT FOUND OR previous.expires_at <= stamp THEN p_capacity
    ELSE least(p_capacity, previous.tokens + greatest(0,extract(epoch FROM stamp-previous.updated_at))*p_capacity/p_window_seconds) END;
  retry_after := CASE WHEN available >= 1 THEN 0 ELSE greatest(1,ceil((1-available)*p_window_seconds/p_capacity)::integer) END;
  INSERT INTO public.app_request_budget(budget_key,tokens,updated_at,expires_at)
    VALUES(p_key,CASE WHEN retry_after=0 THEN available-1 ELSE available END,stamp,stamp+make_interval(secs=>p_window_seconds*2))
    ON CONFLICT(budget_key) DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at,expires_at=excluded.expires_at;
  -- Bounded reclamation; SKIP LOCKED avoids deadlocks with other active buckets.
  DELETE FROM public.app_request_budget WHERE budget_key IN
    (SELECT budget_key FROM public.app_request_budget WHERE expires_at < stamp ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  RETURN retry_after;
END;
$$;
REVOKE ALL ON FUNCTION app.consume_request_budget(text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_request_budget(text,integer,integer) TO ai_hr_app;
