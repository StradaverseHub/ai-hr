-- Production and CI can grant table-wide CRUD to the application role by
-- default. Receipts may only be created by the event trigger and completed by
-- the projection path. Keep event, tenant, consumer and sequence immutable.
REVOKE ALL PRIVILEGES ON TABLE public.notification_event_processing FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON TABLE public.notification_event_processing TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(disposition,processed_at) ON TABLE public.notification_event_processing TO ai_hr_app;
