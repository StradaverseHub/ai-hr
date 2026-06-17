ALTER TABLE "peer_feedback_request" ADD COLUMN "subject_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD COLUMN "peer_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "peer_feedback_request" ADD COLUMN "cycle_name" text;