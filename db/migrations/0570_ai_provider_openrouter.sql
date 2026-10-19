-- OpenRouter as a fourth AI provider (BYOK only; lib/ai/providers/openrouter.ts). Adds the enum value
-- and nothing else. The value is not used by any statement here: Postgres refuses to USE an enum value
-- added in the same transaction until it commits, so a row, default or check naming 'openrouter' must
-- never be added to this file. Nothing else needs changing: app.ai_active_provider_config() (0059)
-- returns provider::text and ai_provider_config's RLS policies and column grants do not name a provider;
-- ai_model_run.provider is text (0541). Off per tenant until a group admin allows it
-- (setting `ai.openrouter_enabled`, seeded from packs/catalog.ts by scripts/seed-catalogs.ts).
ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'openrouter';
