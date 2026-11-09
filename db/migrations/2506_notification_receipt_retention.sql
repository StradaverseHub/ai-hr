-- Receipts are derived from their source event. If the event owner can delete
-- the source, discard its receipts without changing source or notification grants.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.notification_event_processing
 DROP CONSTRAINT notification_event_processing_event_id_fkey,
 ADD CONSTRAINT notification_event_processing_event_id_fkey
 FOREIGN KEY (event_id) REFERENCES public.domain_event(id) ON DELETE CASCADE;
