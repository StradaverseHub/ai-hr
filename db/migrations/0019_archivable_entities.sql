ALTER TABLE "company" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_center" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "position" ADD COLUMN "archived_at" timestamp with time zone;