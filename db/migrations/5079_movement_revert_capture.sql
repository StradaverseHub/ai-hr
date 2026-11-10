-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5079_movement_revert_capture, idx 4479, when 1793330004779.
-- Draft name on its branch: 9914_movement_revert_capture. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import Revert: capture of the rehearsed
-- compensation): not a reservation, not an installation allocation. The journal position (idx 9914, when 1793330099914)
-- exists only so this branch's schema is executable and reviewable; the integration owner assigns the final
-- tag/idx/when after the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- The background movement revert (core/movement-import-revert-job.ts) rehearses each employee's compensation in a
-- savepoint that always rolls back and replays what it wrote in one verified release. A row's final image does not
-- show how many times it was written, and the database's own triggers count every write (the replacement-holiday
-- generation, tenant epochs), so the rehearsal records each row write of the four movement-record tables, in order:
-- the row's identity, its image before and after that write. Only while the rehearsal sets the transaction-local
-- app.movement_revert_capture to 'on' (a WHEN condition, so other writers do not call the function); the rows are
-- written inside the rehearsal's savepoint and roll back with it, so none is ever committed or seen by another session.
CREATE TABLE app.movement_revert_capture(
 seq bigserial PRIMARY KEY,
 table_name text NOT NULL,
 op text NOT NULL CHECK(op IN ('INSERT','UPDATE','DELETE')),
 row_id uuid NOT NULL,
 old_row jsonb,
 new_row jsonb
);
--> statement-breakpoint
REVOKE ALL ON app.movement_revert_capture FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON app.movement_revert_capture TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.movement_revert_capture_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO app.movement_revert_capture(table_name,op,row_id,old_row,new_row)
 VALUES(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END,
  CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.movement_revert_capture_row() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER zz_movement_revert_capture AFTER INSERT OR UPDATE OR DELETE ON public.employment FOR EACH ROW
 WHEN (current_setting('app.movement_revert_capture',true)='on') EXECUTE FUNCTION app.movement_revert_capture_row();
--> statement-breakpoint
CREATE TRIGGER zz_movement_revert_capture AFTER INSERT OR UPDATE OR DELETE ON public.assignment FOR EACH ROW
 WHEN (current_setting('app.movement_revert_capture',true)='on') EXECUTE FUNCTION app.movement_revert_capture_row();
--> statement-breakpoint
CREATE TRIGGER zz_movement_revert_capture AFTER INSERT OR UPDATE OR DELETE ON public.compensation FOR EACH ROW
 WHEN (current_setting('app.movement_revert_capture',true)='on') EXECUTE FUNCTION app.movement_revert_capture_row();
--> statement-breakpoint
CREATE TRIGGER zz_movement_revert_capture AFTER INSERT OR UPDATE OR DELETE ON public.reporting_line FOR EACH ROW
 WHEN (current_setting('app.movement_revert_capture',true)='on') EXECUTE FUNCTION app.movement_revert_capture_row();
