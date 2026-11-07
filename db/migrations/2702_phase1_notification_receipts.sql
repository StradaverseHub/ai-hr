-- Durable projection intent is created in the source event transaction. A serial allocation
-- is not commit order. Keep the old cursor only for overlap/operational compatibility.
-- Cutover must run in the migration transaction; bounded lock acquisition fails rather than
-- holding an installation indefinitely. Existing events <= historical cursors are not replayed.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE public.domain_event, public.notification_cursor IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE public.notification_event_processing (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 event_id uuid NOT NULL REFERENCES public.domain_event(id) ON DELETE CASCADE,
 consumer text NOT NULL CHECK (consumer IN ('notifications','assessment-reminders')),
 event_sequence bigint NOT NULL,
 disposition text CHECK (disposition IN ('processed','ignored','legacy-cursor')),
 processed_at timestamptz,
 PRIMARY KEY (event_id,consumer),
 CHECK ((disposition IS NULL) = (processed_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX notification_event_processing_pending_idx
 ON public.notification_event_processing(tenant_id,consumer,event_sequence)
 WHERE disposition IS NULL;
--> statement-breakpoint
ALTER TABLE public.notification_event_processing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_event_processing_read ON public.notification_event_processing FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
   (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id)));
--> statement-breakpoint
CREATE POLICY notification_event_processing_complete ON public.notification_event_processing FOR UPDATE
 USING (tenant_id=app.current_tenant_id() AND app.principal_snapshot_current() AND
   (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id)))
 WITH CHECK (tenant_id=app.current_tenant_id() AND disposition IN ('processed','ignored') AND processed_at IS NOT NULL AND
   app.principal_snapshot_current() AND (app.is_group_admin() OR consumer='assessment-reminders' AND app.is_admin() AND
    EXISTS (SELECT 1 FROM public.domain_event e WHERE e.id=event_id AND e.tenant_id=notification_event_processing.tenant_id)));
--> statement-breakpoint
-- Default application CRUD grants must not let recipients create, retarget or delete receipts.
REVOKE ALL PRIVILEGES ON TABLE public.notification_event_processing FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON public.notification_event_processing TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(disposition,processed_at) ON public.notification_event_processing TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.notification_event_processing_enqueue() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO public.notification_event_processing(tenant_id,event_id,consumer,event_sequence)
 VALUES(NEW.tenant_id,NEW.id,'notifications',NEW.sequence);
 IF NEW.event_type='assessment.reminder-queued' THEN
  INSERT INTO public.notification_event_processing(tenant_id,event_id,consumer,event_sequence)
  VALUES(NEW.tenant_id,NEW.id,'assessment-reminders',NEW.sequence);
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_event_processing_enqueue() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER notification_event_processing_enqueue AFTER INSERT ON public.domain_event
 FOR EACH ROW EXECUTE FUNCTION app.notification_event_processing_enqueue();
--> statement-breakpoint
-- Do not infer historical delivery completeness from these legacy markers. Suspected historical
-- omissions need a separately reviewed reconciliation; replay must not resend old external effects.
INSERT INTO public.notification_event_processing(tenant_id,event_id,consumer,event_sequence,disposition,processed_at)
 SELECT e.tenant_id,e.id,consumer.name,e.sequence,
 CASE WHEN e.sequence<=consumer.last_sequence THEN 'legacy-cursor' ELSE NULL END,
 CASE WHEN e.sequence<=consumer.last_sequence THEN now() ELSE NULL END
 FROM public.domain_event e LEFT JOIN public.notification_cursor c ON c.tenant_id=e.tenant_id
 CROSS JOIN LATERAL (SELECT 'notifications'::text AS name,c.last_sequence
   UNION ALL SELECT 'assessment-reminders',c.assessment_last_sequence WHERE e.event_type='assessment.reminder-queued') consumer;
--> statement-breakpoint
CREATE INDEX notification_source_recipient_kind_idx
 ON public.notification(tenant_id,source_event_id,recipient_employment_id,kind) WHERE source_event_id IS NOT NULL;
--> statement-breakpoint
-- Boolean-only overlap check: ordinary recipients retain their existing notification disclosure.
-- Both old/new dispatchers serialize on notification-cursor:<tenant>, so an old dispatcher that
-- finishes after cutover cannot cause the new consumer to create the same event/kind/recipient again.
CREATE FUNCTION app.notification_projection_exists(p_event uuid,p_recipient uuid,p_kind text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND
 (app.is_group_admin() OR app.is_admin() AND EXISTS(
   SELECT 1 FROM public.domain_event e WHERE e.id=p_event AND e.tenant_id=app.current_tenant_id()
   AND e.event_type='assessment.reminder-queued')) AND EXISTS(
  SELECT 1 FROM public.notification n WHERE n.tenant_id=app.current_tenant_id()
   AND n.source_event_id=p_event AND n.recipient_employment_id=p_recipient AND n.kind=p_kind)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.notification_projection_exists(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.notification_projection_exists(uuid,uuid,text) TO ai_hr_app;
