-- Durable projection intent is created in the source event transaction. A serial allocation
-- is not commit order. Keep the old cursor only for overlap/operational compatibility.
-- Online cutover. The enqueue trigger captures every event written after this batch commits; receipts
-- for existing history are written by online_migration.notification_receipt_backfill_batch in small transactions
-- from scripts/post-migrate-online.ts, never here. Existing events <= historical cursors are not
-- replayed. The lock wait is bounded, so a busy table fails the batch rather than queueing writers.
SET LOCAL lock_timeout = '5s';
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
SET LOCAL lock_timeout TO DEFAULT;
--> statement-breakpoint
-- The cursor positions as of cutover, read while this batch holds the domain_event lock that
-- CREATE TRIGGER took, so no event writer is in flight. A dispatcher still mid-run may advance its
-- cursor past this snapshot; those events stay pending and the (event, recipient, kind) check keeps
-- the new consumer from repeating what the old one already projected. Frozen on purpose: a later
-- cursor can be advanced by the new dispatcher and must not classify a receipt as already handled.
CREATE TABLE online_migration.notification_cursor_cutover (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 last_sequence bigint,
 assessment_last_sequence bigint
);
--> statement-breakpoint
ALTER TABLE online_migration.notification_cursor_cutover ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE online_migration.notification_cursor_cutover FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
INSERT INTO online_migration.notification_cursor_cutover(tenant_id,last_sequence,assessment_last_sequence)
 SELECT tenant_id,last_sequence,assessment_last_sequence FROM public.notification_cursor;
--> statement-breakpoint
INSERT INTO online_migration.step(step) VALUES('notification-receipts');
--> statement-breakpoint
-- Do not infer historical delivery completeness from these legacy markers. Suspected historical
-- omissions need a separately reviewed reconciliation; replay must not resend old external effects.
-- One physical-range page per call, so history is read sequentially instead of in random UUID order.
-- ON CONFLICT leaves receipts the trigger already wrote untouched. Rows appended after a page was read
-- already have trigger-written receipts, so the walk only needs to reach the end of the table once.
CREATE FUNCTION online_migration.notification_receipt_backfill_batch(p_pages integer DEFAULT 150)
 RETURNS TABLE(scanned integer,inserted integer,done boolean)
 LANGUAGE plpgsql SET search_path=public,pg_temp AS $backfill$
DECLARE start_page bigint;last_page bigint;total_pages bigint;
BEGIN
 IF p_pages IS NULL OR p_pages<1 OR p_pages>5000 THEN RAISE EXCEPTION 'Backfill page range out of bounds'; END IF;
 SELECT coalesce(s.position::bigint,0) INTO start_page FROM online_migration.step s WHERE s.step='notification-receipts' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification receipt backfill step is missing'; END IF;
 total_pages:=pg_relation_size('public.domain_event')/current_setting('block_size')::bigint;
 last_page:=start_page+p_pages;
 WITH batch AS MATERIALIZED(
  SELECT e.id,e.tenant_id,e.sequence,e.event_type FROM public.domain_event e
  WHERE e.ctid>=format('(%s,0)',start_page)::tid AND e.ctid<format('(%s,0)',last_page)::tid
 ),written AS(
  INSERT INTO public.notification_event_processing(tenant_id,event_id,consumer,event_sequence,disposition,processed_at)
  SELECT b.tenant_id,b.id,consumer.name,b.sequence,
   CASE WHEN b.sequence<=consumer.last_sequence THEN 'legacy-cursor' ELSE NULL END,
   CASE WHEN b.sequence<=consumer.last_sequence THEN now() ELSE NULL END
  FROM batch b LEFT JOIN online_migration.notification_cursor_cutover c ON c.tenant_id=b.tenant_id
  CROSS JOIN LATERAL(SELECT 'notifications'::text AS name,c.last_sequence
   UNION ALL SELECT 'assessment-reminders',c.assessment_last_sequence WHERE b.event_type='assessment.reminder-queued') consumer
  ON CONFLICT(event_id,consumer) DO NOTHING RETURNING 1
 )
 SELECT (SELECT count(*) FROM batch)::integer,(SELECT count(*) FROM written)::integer INTO scanned,inserted;
 done:=last_page>=total_pages;
 UPDATE online_migration.step s SET position=last_page::text,completed_at=CASE WHEN done THEN now() END WHERE s.step='notification-receipts';
 RETURN NEXT;
END $backfill$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION online_migration.notification_receipt_backfill_batch(integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
SELECT online_migration.index_or_defer('public.notification','notification_source_recipient_kind_idx',
 'ON public.notification(tenant_id,source_event_id,recipient_employment_id,kind) WHERE source_event_id IS NOT NULL');
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
