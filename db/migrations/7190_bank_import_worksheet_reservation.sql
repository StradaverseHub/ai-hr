-- Each explicitly chosen worksheet has its own reservation. NULL is the existing CSV
-- or pre-selection workbook behavior and still reserves the entire source.
CREATE UNIQUE INDEX bank_import_job_active_worksheet
 ON public.bank_import_job(tenant_id,source_hash,coalesce(source_worksheet,''))
 WHERE state IN ('uploading','queued','validating','ready','importing');
--> statement-breakpoint
CREATE FUNCTION app.bank_import_reserve_legacy_source() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 -- The existing context trigger has already verified this tenant and creator.
 -- Serialize reservations for these bytes so a legacy file cannot race a selected sheet.
 PERFORM pg_advisory_xact_lock(hashtextextended('bank-import-admit:'||NEW.tenant_id::text||':'||NEW.source_hash,0));
 IF EXISTS(SELECT 1 FROM public.bank_import_job j
   WHERE j.tenant_id=NEW.tenant_id AND j.source_hash=NEW.source_hash
     AND j.state IN ('uploading','queued','validating','ready','importing')
     AND (NEW.source_worksheet IS NULL OR j.source_worksheet IS NULL)) THEN
  RETURN NULL;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bank_import_reserve_legacy_source() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER bank_import_job_worksheet_reservation BEFORE INSERT ON public.bank_import_job
 FOR EACH ROW EXECUTE FUNCTION app.bank_import_reserve_legacy_source();
--> statement-breakpoint
DROP INDEX public.bank_import_job_active_source;
