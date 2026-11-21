-- New removals use a saved versioned maintenance preview through the existing confirm operation.
-- Existing physically admitted legacy revert jobs remain executable with their private sealed step.
CREATE FUNCTION app.payroll_history_reviewed_job_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.kind='payroll_history' AND NEW.input->>'operation' IS DISTINCT FROM 'confirm' THEN
  RAISE EXCEPTION 'Preview the current payroll history removal and confirm its reviewed maintenance receipt.' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_reviewed_job_admission() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER payroll_history_reviewed_job_admission BEFORE INSERT ON public.bulk_job FOR EACH ROW EXECUTE FUNCTION app.payroll_history_reviewed_job_admission();
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_legacy_revert_step_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE stage_ uuid; proof_ jsonb; target_ jsonb;
BEGIN
 IF NEW.maintenance IS NOT NULL OR NEW.kind<>'revert' THEN RETURN NEW;END IF;
 stage_:=nullif(current_setting('app.payroll_history_stage',true),'')::uuid;
 IF stage_ IS NULL THEN RAISE EXCEPTION 'A legacy payroll history restoration requires its existing sealed worker step.' USING ERRCODE='42501';END IF;
 -- The selector alone is never authority: this private reader verifies the live kernel capability,
 -- exact creator/current permission, input/plan, and current pending step's immutable seal.
 proof_:=app.payroll_history_stage_payload(stage_);target_:=proof_->'payload'->'target';
 IF proof_->>'kind' IS DISTINCT FROM 'revert' OR proof_->'plan'->>'operation' IS DISTINCT FROM 'revert'
  OR proof_->>'attemptId' IS DISTINCT FROM NEW.attempt_id::text
  OR target_->>'recordId' IS DISTINCT FROM NEW.record_id::text
  OR target_->>'currentRevisionId' IS DISTINCT FROM NEW.previous_revision_id::text
  OR (target_->>'currentOrdinal')::integer+1 IS DISTINCT FROM NEW.ordinal
  OR target_->>'restoreSnapshotId' IS DISTINCT FROM NEW.snapshot_id::text
 THEN RAISE EXCEPTION 'The legacy restoration does not match its existing sealed worker target.' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_legacy_revert_step_bind() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER payroll_history_legacy_revert_step_binding BEFORE INSERT ON public.payroll_history_import_revision FOR EACH ROW EXECUTE FUNCTION app.payroll_history_legacy_revert_step_bind();
