-- PROVISIONAL 0702 / when1793330000028 / idx692. Integration freeze owns final allocation.
-- Reviewed delegated Leave decisions reconcile their original actor's native event under caller RLS.
-- This adds only the same own-actor decision evidence seam already used by claims/attendance/TOIL.
-- No general audit, Personnel, ledger, request update or decision authority is granted.
CREATE POLICY delegated_own_leave_decision_event_read ON public.domain_event FOR SELECT TO ai_hr_app USING (
 tenant_id=app.current_tenant_id() AND actor_type='user' AND actor_id=app.current_user_id()
 AND aggregate_type='leave-request'
 AND event_type IN ('leave-request.approved','leave-request.rejected','leave-request.step.approved'));
