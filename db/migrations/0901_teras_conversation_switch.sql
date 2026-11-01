-- ADR-0169 §5.1 and ADR-0170 §11.3 change 4 (wiring): the per-tenant "Noveri conversation" switch. When it is on
-- for a tenant, the live chat runs through the Teras turn harness; off (the default, and no row) keeps the closed
-- request grammar. Provisional DEVELOPMENT source allocation 0901 / when1793330000301 (docs/MIGRATION-ALLOCATION.md);
-- it grants no installation, and the journal position is re-frozen at integration.
--
-- 1. The closed worker list of teras_worker_control (0895) gains 'conversation'. Same table, same RLS: only a group
--    administrator of the tenant, under their own login, writes a row.
-- 2. attested_provider: for a direct upstream route (Anthropic, OpenAI, Google), the provider whose account terms
--    (zero data retention, no training) the administrator confirmed when switching on. The turn refuses a direct
--    route unless it is the attested provider; an OpenRouter route needs no attestation because every request
--    carries data_collection=deny and zdr=true. Only the conversation row may carry it.
-- 3. changed_by_operator: the staging operator path (scripts/operator/teras-conversation-switch.ts) writes as the
--    table owner with an operator label instead of a login. Exactly one of the two attributions is present, and the
--    operator attribution exists only on the conversation row. The application role still cannot write it: the
--    0895 insert and update policies require changed_by_user_id to be the current login.
ALTER TABLE public.teras_worker_control DROP CONSTRAINT teras_worker_control_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD CONSTRAINT teras_worker_control_worker_id_check
 CHECK (worker_id IN ('approver_recommendation','explainers','conversation'));
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD COLUMN attested_provider text
 CHECK (attested_provider IS NULL OR (worker_id='conversation' AND attested_provider IN ('anthropic','openai','google')));
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ALTER COLUMN changed_by_user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD COLUMN changed_by_operator text
 CHECK (changed_by_operator IS NULL OR (worker_id='conversation' AND changed_by_operator ~ '^operator:[a-z0-9][a-z0-9._-]{1,62}$'));
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD CONSTRAINT teras_worker_control_one_attribution
 CHECK ((changed_by_user_id IS NULL)<>(changed_by_operator IS NULL));
