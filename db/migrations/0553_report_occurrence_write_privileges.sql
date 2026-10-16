-- The occurrence queue is written only by its canonical SECURITY DEFINER owners.
-- Bootstrap default privileges can otherwise leave ai_hr_app table-wide writes, even though
-- occurrence RLS currently has no write policy. Remove that ambient authority explicitly.
-- This is additive to the retained 0546/0549/0552 migrations; their bytes stay unchanged.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
 ON TABLE public.custom_report_occurrence FROM PUBLIC, ai_hr_app;

--> statement-breakpoint
-- Table-level revocation does not revoke separately granted column privileges.
-- Clear those too, preserving the existing column-only audit SELECT and private lease nonce.
DO $$ DECLARE column_list text; BEGIN
 SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) INTO column_list
 FROM pg_catalog.pg_attribute a
 WHERE a.attrelid='public.custom_report_occurrence'::regclass
  AND a.attnum>0 AND NOT a.attisdropped;
 IF column_list IS NULL THEN RAISE EXCEPTION 'Report occurrence columns unavailable'; END IF;
 EXECUTE format('REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) ON TABLE public.custom_report_occurrence FROM PUBLIC, ai_hr_app',column_list);
END $$;
