-- Whole-stack review B1 (docs/reviews/teras-whole-stack-20261102/REPORT.md): a turn that the pre-read gate routed
-- (harassment, crisis, grievance, medical, a threat of dismissal) or refused as a workplace-harms request must not be
-- attributable to the person through the outcome record. The trace no longer names the topic (core/harness/
-- trace-persistence.ts stores reason 'routed'), and this migration keeps such records out of the group-administrator
-- read path altogether: only the person who asked reads them. Provisional DEVELOPMENT source allocation 0905 /
-- when1793330000305 (docs/MIGRATION-ALLOCATION.md; 0902-0904 are claimed on other refs); it grants no installation,
-- and the journal position is re-frozen at integration.
--
-- 1. private_to_asker: set by the writer for a routed or refused turn. Only a person-authority turn may carry it.
--    Existing rows keep false (no harness turn has been written outside tests: persistTurnTrace had no production
--    caller before the live-chat wiring, which is switched off everywhere).
-- 2. teras_outcome_record_read is replaced: a group administrator reads only records that are not private to the
--    asker, and only while their principal snapshot is current (review low item). The asker and the grantor read as
--    before; an agent still reads mandate runs only.
ALTER TABLE public.teras_outcome_record ADD COLUMN private_to_asker boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE public.teras_outcome_record ADD CONSTRAINT teras_outcome_record_private_person_only
 CHECK (NOT private_to_asker OR (authority_kind='person' AND run_kind='turn'));
--> statement-breakpoint
DROP POLICY teras_outcome_record_read ON public.teras_outcome_record;
--> statement-breakpoint
CREATE POLICY teras_outcome_record_read ON public.teras_outcome_record FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND (
  (app.current_agent_principal() IS NOT NULL AND authority_kind='mandate')
  OR (app.current_user_id() IS NOT NULL AND (asked_by_user_id=app.current_user_id() OR grantor_user_id=app.current_user_id()
   OR (NOT private_to_asker AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)))));
