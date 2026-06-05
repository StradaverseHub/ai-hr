CREATE TABLE "holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"country" text NOT NULL,
	"holiday_date" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_type" ADD COLUMN "counting" text DEFAULT 'calendar_days' NOT NULL;--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_uq" ON "holiday" USING btree ("tenant_id","country","holiday_date");