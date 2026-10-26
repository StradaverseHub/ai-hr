-- UNALLOCATED DRAFT, UNAPPLIED/UNRUN. Coordinate migration allocation before journaling.
-- No configured key, activation, default route or network call. Older resolver is retained for
-- compatibility; new source must read v2 and validate options before decrypting/using the key.
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'openrouter';
--> statement-breakpoint
ALTER TABLE public.ai_provider_config ADD COLUMN provider_options jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
CREATE FUNCTION app.ai_openrouter_options_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; providers jsonb; n integer;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>8192 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR p->'version' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  r := p->'routing';
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(r))<>3
    OR jsonb_typeof(r->'allowFallbacks') IS DISTINCT FROM 'boolean'
    OR r->>'sort' IS NULL OR r->>'sort' NOT IN ('price','latency') THEN RETURN false; END IF;
  providers := r->'allowedProviders';
  IF jsonb_typeof(providers) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  n := jsonb_array_length(providers);
  IF n<1 OR n>32 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(providers) AS elements(item)
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
      OR length(item #>> '{}')>128 OR (item #>> '{}') !~ '^[a-z0-9]+([-/][a-z0-9]+)*$'
  ) THEN RETURN false; END IF;
  RETURN (SELECT count(DISTINCT item) FROM jsonb_array_elements(providers) AS elements(item))=n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_openrouter_options_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_openrouter_options_valid(jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.ai_provider_config ADD CONSTRAINT ai_provider_config_options_ck CHECK (
  CASE WHEN provider::text='openrouter' THEN app.ai_openrouter_options_valid(provider_options)
    ELSE provider_options='{}'::jsonb END
);
--> statement-breakpoint
GRANT SELECT (provider_options) ON public.ai_provider_config TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_active_provider_config_v2()
RETURNS TABLE(provider text, model text, api_key_ciphertext text, provider_options jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $$
  SELECT c.provider::text, c.model, c.api_key_ciphertext, c.provider_options
  FROM public.ai_provider_config c
  WHERE c.tenant_id=app.current_tenant_id() AND c.is_active
  LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_active_provider_config_v2() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_active_provider_config_v2() TO ai_hr_app;
