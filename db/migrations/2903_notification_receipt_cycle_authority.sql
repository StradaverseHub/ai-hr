-- Complete a scoped reminder only with native cycle authority, not broad audit-event visibility.
-- Earlier receipt, retention and least-privilege SQL bytes remain immutable.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER POLICY notification_event_processing_read ON public.notification_event_processing
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
   (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e
     JOIN public.performance_assessment_reminder_recipient r ON r.id=e.aggregate_id AND r.tenant_id=e.tenant_id AND r.source_event_id=e.id
     JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
     WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id
      AND e.event_type='assessment.reminder-queued' AND app.onehr_cycle_admin(run.cycle_id))));
--> statement-breakpoint
ALTER POLICY notification_event_processing_complete ON public.notification_event_processing
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
   (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e
     JOIN public.performance_assessment_reminder_recipient r ON r.id=e.aggregate_id AND r.tenant_id=e.tenant_id AND r.source_event_id=e.id
     JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
     WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id
      AND e.event_type='assessment.reminder-queued' AND app.onehr_cycle_admin(run.cycle_id))))
 WITH CHECK (tenant_id=app.current_tenant_id() AND disposition IN ('processed','ignored') AND processed_at IS NOT NULL AND
   app.principal_snapshot_current() AND (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e
     JOIN public.performance_assessment_reminder_recipient r ON r.id=e.aggregate_id AND r.tenant_id=e.tenant_id AND r.source_event_id=e.id
     JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
     WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id
      AND e.event_type='assessment.reminder-queued' AND app.onehr_cycle_admin(run.cycle_id))));

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.notification_projection_exists(p_event uuid,p_recipient uuid,p_kind text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND
 (app.is_group_admin() OR app.is_admin() AND EXISTS(
   SELECT 1 FROM public.domain_event e
   JOIN public.performance_assessment_reminder_recipient r ON r.id=e.aggregate_id AND r.tenant_id=e.tenant_id AND r.source_event_id=e.id
   JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
   WHERE e.id=p_event AND e.tenant_id=app.current_tenant_id()
    AND e.event_type='assessment.reminder-queued' AND app.onehr_cycle_admin(run.cycle_id))) AND EXISTS(
  SELECT 1 FROM public.notification n WHERE n.tenant_id=app.current_tenant_id()
   AND n.source_event_id=p_event AND n.recipient_employment_id=p_recipient AND n.kind=p_kind)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_projection_exists(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_projection_exists(uuid,uuid,text) TO ai_hr_app;
