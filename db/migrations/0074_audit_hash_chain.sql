-- ADR-0030 Layer 2: per-tenant tamper-evidence hash chain over the append-only domain_event log.
-- Gated by the app.audit_hash_chain GUC (set by withTenant when AUDIT_HASH_CHAIN_ENABLED) — OFF by
-- default leaves chain_seq/prev_hash/hash NULL and behaviour byte-identical. A BEFORE INSERT trigger
-- (SECURITY DEFINER → reads the per-tenant chain head bypassing RLS, since appendEvent runs under any
-- user's context) assigns the chain; appendEvent itself is unchanged. Backfill of pre-existing events is
-- deferred to the historical-redaction migration (ADR-0030 §3) so the chain covers post-redaction payloads.
ALTER TABLE "domain_event" ADD COLUMN IF NOT EXISTS "chain_seq" bigint;--> statement-breakpoint
ALTER TABLE "domain_event" ADD COLUMN IF NOT EXISTS "prev_hash" text;--> statement-breakpoint
ALTER TABLE "domain_event" ADD COLUMN IF NOT EXISTS "hash" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_event_chain_idx" ON "domain_event" USING btree ("tenant_id","chain_seq");--> statement-breakpoint

-- Single source of truth for a row's hash — used by BOTH the trigger and the verifier, so they can never
-- diverge. jsonb::text is Postgres-canonical (sorted keys), so the digest is deterministic.
CREATE OR REPLACE FUNCTION app.domain_event_hash(
  p_prev_hash text, p_tenant uuid, p_chain_seq bigint, p_agg_type text, p_agg_id uuid,
  p_event_type text, p_actor_type text, p_actor_id uuid, p_subject uuid, p_payload jsonb
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    p_prev_hash || '|' || p_tenant::text || '|' || p_chain_seq::text || '|' || p_agg_type || '|'
    || p_agg_id::text || '|' || p_event_type || '|' || p_actor_type || '|' || coalesce(p_actor_id::text, '')
    || '|' || coalesce(p_subject::text, '') || '|' || coalesce(p_payload::text, 'null'), 'UTF8')), 'hex')
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.domain_event_chain_tg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog, app AS $$
DECLARE
  v_prev_hash text;
  v_prev_seq bigint;
BEGIN
  IF current_setting('app.audit_hash_chain', true) IS DISTINCT FROM 'on' THEN
    RETURN NEW; -- chain disabled: leave chain columns NULL (byte-identical behaviour)
  END IF;
  -- serialize appends per tenant so concurrent inserts can't fork the chain
  PERFORM pg_advisory_xact_lock(hashtext('audit-chain:' || NEW.tenant_id::text));
  SELECT chain_seq, hash INTO v_prev_seq, v_prev_hash
    FROM domain_event
    WHERE tenant_id = NEW.tenant_id AND chain_seq IS NOT NULL
    ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := coalesce(v_prev_seq, 0) + 1;
  NEW.prev_hash := coalesce(v_prev_hash, 'GENESIS');
  NEW.hash := app.domain_event_hash(NEW.prev_hash, NEW.tenant_id, NEW.chain_seq, NEW.aggregate_type,
    NEW.aggregate_id, NEW.event_type, NEW.actor_type::text, NEW.actor_id, NEW.subject_employment_id, NEW.payload);
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS domain_event_chain_tg ON "domain_event";--> statement-breakpoint
CREATE TRIGGER domain_event_chain_tg BEFORE INSERT ON "domain_event"
  FOR EACH ROW EXECUTE FUNCTION app.domain_event_chain_tg();
