-- Assistant clarification context link. Owner decision, 28 October 2026: an answer to a clarifying
-- question carries the earlier human turns of the same conversation. A continuation stores only its own
-- new human reply (each raw text still retires 30 days from ITS OWN question); this column links it to
-- the exchange it answered so the next continuation can walk back through rows that are still current.
-- The link carries no content. Deleting the earlier row (own-clear, PDPA) nulls it; retirement keeps it,
-- and the reader stops at any retired, foreign or expired row.
-- LOCKING: ADD COLUMN (nullable, no default) is catalog-only. The plain CREATE INDEX scans the table under
-- the same ACCESS EXCLUSIVE lock (drizzle runs this file in one transaction, so CONCURRENTLY is
-- unavailable); assistant_exchange is bounded by the per-user daily cap, as in 0656.
ALTER TABLE public.assistant_exchange ADD COLUMN continues_exchange_id uuid
 REFERENCES public.assistant_exchange(id) ON DELETE SET NULL;
CREATE INDEX assistant_exchange_continues_idx ON public.assistant_exchange(continues_exchange_id)
 WHERE continues_exchange_id IS NOT NULL;
--> statement-breakpoint
-- Same tenant and same login only, set once at INSERT. An UPDATE may only clear it (the FK's SET NULL
-- action, or the owner's own erasure); the legacy 0451 self-row UPDATE grant cannot re-point it.
CREATE FUNCTION app.assistant_exchange_continuation_guard() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.continues_exchange_id IS NULL THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.continues_exchange_id IS DISTINCT FROM OLD.continues_exchange_id THEN RAISE EXCEPTION 'Assistant continuation link is immutable' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 IF NEW.continues_exchange_id=NEW.id OR NOT EXISTS(SELECT 1 FROM public.assistant_exchange e
  WHERE e.id=NEW.continues_exchange_id AND e.tenant_id=NEW.tenant_id AND e.app_user_id=NEW.app_user_id) THEN
  RAISE EXCEPTION 'Assistant continuation must answer the same login''s exchange' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assistant_exchange_continuation_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_exchange_continuation_guard BEFORE INSERT OR UPDATE OF continues_exchange_id ON public.assistant_exchange
 FOR EACH ROW EXECUTE FUNCTION app.assistant_exchange_continuation_guard();
