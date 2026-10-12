-- Enforce persisted audit policy for every domain-event writer, including raw identity and job SQL.
-- withTenant still supplies its existing environment fallback. Explicit tenant opt-in and already
-- chained history must also protect connections that never pass through that TypeScript wrapper.
-- Existing unchained events are not rewritten; this is not a historical backfill.
CREATE OR REPLACE FUNCTION app.domain_event_chain_tg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_prev_hash text;
  v_prev_seq bigint;
BEGIN
  -- Take the same per-tenant lock before policy/history lookup as well as insertion. Otherwise an
  -- unarmed raw writer can race the first chained append and leave an invisible hole after it.
  PERFORM pg_advisory_xact_lock(hashtext('audit-chain:' || NEW.tenant_id::text));
  SELECT chain_seq, hash INTO v_prev_seq, v_prev_hash
    FROM public.domain_event
    WHERE tenant_id = NEW.tenant_id AND chain_seq IS NOT NULL
    ORDER BY chain_seq DESC LIMIT 1;

  IF current_setting('app.audit_hash_chain', true) IS DISTINCT FROM 'on'
     AND v_prev_seq IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_setting
       WHERE tenant_id = NEW.tenant_id AND key = 'audit.hash_chain_enabled'
         AND value = 'true'::jsonb
     ) THEN
    RETURN NEW; -- no opt-in, caller fallback or chained history: retain the legacy unarmed behavior
  END IF;

  NEW.chain_seq := coalesce(v_prev_seq, 0) + 1;
  NEW.prev_hash := coalesce(v_prev_hash, 'GENESIS');
  NEW.hash := app.domain_event_hash(NEW.prev_hash, NEW.tenant_id, NEW.chain_seq, NEW.aggregate_type,
    NEW.aggregate_id, NEW.event_type, NEW.actor_type::text, NEW.actor_id, NEW.subject_employment_id, NEW.payload);
  RETURN NEW;
END;
$$;
