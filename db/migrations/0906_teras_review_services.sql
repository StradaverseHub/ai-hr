-- PR 198 whole-stack review (docs/reviews/teras-whole-stack-20261102/REPORT.md), services findings: M4, M17 and the
-- low items on mandates, the grantor-manager function, task-memory retention and group-administrator read policies.
-- Provisional DEVELOPMENT source allocation 0906 / when1793330000306 (docs/MIGRATION-ALLOCATION.md); journal idx 760,
-- with idx 759 left for 0905 (another review session). It grants no installation; the journal position is re-frozen at
-- integration. Applied SQL (0890, 0895, 0901) is unchanged: policies are replaced here, functions recreated here.
--
-- Writers reviewed before each constraint:
--  - teras_outcome_followup kind='decision': core/recommenders/leave-decision.ts recordRecommendationDecision is the only
--    application writer (core/outcome-record/record.ts recordOutcomeFollowup); it now appends once, for the asker only.
--  - teras_mandate daily_digest: core/mandates/mandates.ts grantMandate is the only writer of new rows; it refuses a
--    second unrevoked digest mandate and revokes the grantor's own expired one before a fresh grant.
--  - teras_task_memory: core/harness/task-memory-store.ts PostgresTaskMemoryStore (as the login) and the 0890 erasure
--    trigger. The expiry trigger below only deletes.
-- A unique index fails to build if duplicates already exist. These tables are development-only source (nothing reads
-- them in production); if an installation holds duplicates, resolve them explicitly before applying, never by editing
-- this file.
--
-- 1. M4: one decision follow-up per outcome record.
CREATE UNIQUE INDEX teras_outcome_followup_one_decision_idx ON public.teras_outcome_followup(tenant_id,record_id) WHERE kind='decision';
--> statement-breakpoint
-- 2. M4: a decision follow-up is appended only by the person the record answered (its asker), never by a group
--    administrator or the grantor. On an approver recommendation it must also match the native decision: an approval
--    step of the recommended request, decided by one of the caller's own employments after the recommendation was
--    computed, approving for 'accepted' and rejecting for 'rejected'. Undo and notice keep the 0890 readers' rule.
--    The step and employment are read under the caller's own RLS.
DROP POLICY teras_outcome_followup_insert ON public.teras_outcome_followup;
--> statement-breakpoint
CREATE POLICY teras_outcome_followup_insert ON public.teras_outcome_followup FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND by_user_id=app.current_user_id()
  AND kind<>'mandate_completion'
  AND EXISTS (SELECT 1 FROM public.teras_outcome_record r WHERE r.tenant_id=app.current_tenant_id() AND r.id=teras_outcome_followup.record_id
   AND (r.asked_by_user_id=app.current_user_id() OR r.grantor_user_id=app.current_user_id() OR app.is_group_admin()))
  AND (kind<>'decision' OR EXISTS (SELECT 1 FROM public.teras_outcome_record r
   WHERE r.tenant_id=app.current_tenant_id() AND r.id=teras_outcome_followup.record_id AND r.asked_by_user_id=app.current_user_id()
    AND (r.agent_identity<>'worker.approver_recommendation' OR EXISTS (
     SELECT 1 FROM public.leave_approval_step s JOIN public.employment e ON e.id=s.decided_by_employment_id
     WHERE s.tenant_id=r.tenant_id AND s.leave_request_id::text=(r.outcome->>'leaveRequestId')
      AND s.status IN ('approved','rejected') AND s.decided_at>=r.started_at AND app.is_self_person(e.person_id)
      AND ((teras_outcome_followup.decision='accepted')=(s.status='approved')))))));
--> statement-breakpoint
-- 3. M17: the inbox digest reads a grantor's latest prepared run; the registry reads each agent identity's last run.
CREATE INDEX teras_outcome_record_grantor_idx ON public.teras_outcome_record(tenant_id,grantor_user_id,started_at) WHERE grantor_user_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX teras_outcome_record_agent_idx ON public.teras_outcome_record(tenant_id,agent_identity,started_at);
--> statement-breakpoint
-- 4. Low: the stored trace stays small (core/outcome-record/record.ts bounds its shape; this is the hard ceiling).
--    NOT VALID: existing append-only rows are not rewritten; every later write is checked.
ALTER TABLE public.teras_outcome_record ADD CONSTRAINT teras_outcome_record_trace_size
 CHECK (trace IS NULL OR octet_length(trace::text)<=65536) NOT VALID;
--> statement-breakpoint
-- 5. Low: at most one unrevoked daily digest mandate per grantor, so a person gets one digest a day.
CREATE UNIQUE INDEX teras_mandate_one_daily_digest_idx ON public.teras_mandate(tenant_id,grantor_user_id) WHERE job_type='daily_digest' AND revoked_at IS NULL;
--> statement-breakpoint
-- 6. Low: the grantor's manager is judged on the HR day (Asia/Kuala_Lumpur), and an employment counts while it is
--    current on that day: hired on or before it and not yet terminated (terminated_on after it), as My Team does
--    (core/my-team-scope.ts). A manager serving notice can still revoke; one whose employment ended cannot.
CREATE OR REPLACE FUNCTION app.teras_is_grantor_manager(grantor_person uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH hr AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today)
 SELECT app.current_user_id() IS NOT NULL AND EXISTS (
  SELECT 1 FROM hr, public.reporting_line rl
  JOIN public.employment sub ON sub.id=rl.subordinate_employment_id
  JOIN public.employment mgr ON mgr.id=rl.manager_employment_id
  WHERE sub.person_id=grantor_person AND sub.tenant_id=app.current_tenant_id() AND mgr.tenant_id=app.current_tenant_id()
   AND rl.line_type='administrative' AND rl.superseded_at IS NULL
   AND rl.valid_from<=hr.today AND (rl.valid_to IS NULL OR rl.valid_to>hr.today)
   AND sub.hired_on<=hr.today AND (sub.terminated_on IS NULL OR sub.terminated_on>hr.today)
   AND mgr.hired_on<=hr.today AND (mgr.terminated_on IS NULL OR mgr.terminated_on>hr.today)
   AND mgr.person_id<>grantor_person AND app.is_self_person(mgr.person_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_is_grantor_manager(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_is_grantor_manager(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 7. Low: task memory has a retention of its own, tied to the conversation. A conversation continues for at most two
--    hours after its last turn (core/teras-wiring/history.ts TTL_MS), so memory not updated for a day can never be
--    read again: the store ignores it (core/harness/task-memory-store.ts) and every memory write in the tenant
--    erases up to 100 such rows (never the row being written). The 0890 erasure with the transcript is unchanged. Definer rights, because the
--    expired rows belong to other logins; it only deletes, and only expired rows of the writer's own tenant.
CREATE FUNCTION app.teras_task_memory_expire() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 DELETE FROM public.teras_task_memory m WHERE m.ctid IN (
  SELECT x.ctid FROM public.teras_task_memory x WHERE x.tenant_id=NEW.tenant_id AND x.updated_at<now()-interval '1 day'
   AND NOT (x.app_user_id=NEW.app_user_id AND x.conversation_id=NEW.conversation_id) LIMIT 100);
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_task_memory_expire() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_task_memory_expire AFTER INSERT OR UPDATE ON public.teras_task_memory
 FOR EACH ROW EXECUTE FUNCTION app.teras_task_memory_expire();
--> statement-breakpoint
CREATE INDEX teras_task_memory_updated_idx ON public.teras_task_memory(tenant_id,updated_at);
--> statement-breakpoint
-- 8. Low: the group-administrator branch of the mandate read policy also requires a current principal snapshot, as
--    the write policies already do. (teras_outcome_record_read is replaced by migration 0905, which adds the same.)
DROP POLICY teras_mandate_read ON public.teras_mandate;
--> statement-breakpoint
CREATE POLICY teras_mandate_read ON public.teras_mandate FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND (app.current_agent_principal() IS NOT NULL
  OR (app.current_user_id() IS NOT NULL AND (grantor_user_id=app.current_user_id()
   OR (app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)))));
