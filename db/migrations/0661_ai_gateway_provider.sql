-- 0661 — general AI gateway provider (owner-approved 28 October 2026; reserved by the AI allocator: when
-- 1793150000000). A gateway that accepts OpenAI-style chat requests (for example router.flatkey.ai/v1) is
-- stored as provider 'ai_gateway' with provider_options {"version":1,"baseUrl":"https://…"}. Public https
-- host names only: no IP literal, no single-label or local/internal host, no credentials, query or fragment.
-- The application additionally resolves the host before every call and refuses private addresses.
-- The new enum value is compared only as TEXT below, so this file never uses it as an enum literal in the
-- transaction that adds it.
ALTER TYPE ai_provider ADD VALUE IF NOT EXISTS 'ai_gateway';
--> statement-breakpoint
CREATE FUNCTION app.ai_gateway_options_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT jsonb_typeof(p)='object' AND octet_length(p::text)<=1024
  AND (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k)=ARRAY['baseUrl','version']::text[]
  AND p->'version'='1'::jsonb AND jsonb_typeof(p->'baseUrl')='string'
  AND length(p->>'baseUrl') BETWEEN 12 AND 300
  AND p->>'baseUrl' ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(/[A-Za-z0-9._~-]+)*/?$'
  AND p->>'baseUrl' !~ '^https://[0-9.]+(/|$)'
  AND p->>'baseUrl' !~ '^https://[^/]*\.(local|localhost|internal|lan|home|corp|intranet)(/|$)'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_gateway_options_valid(jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_gateway_options_valid(jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.ai_provider_config DROP CONSTRAINT ai_provider_config_options_ck;
--> statement-breakpoint
ALTER TABLE public.ai_provider_config ADD CONSTRAINT ai_provider_config_options_ck CHECK (
  CASE WHEN provider::text='openrouter' THEN app.ai_openrouter_options_valid(provider_options)
    WHEN provider::text='ai_gateway' THEN app.ai_gateway_options_valid(provider_options)
    ELSE provider_options='{}'::jsonb END
);
