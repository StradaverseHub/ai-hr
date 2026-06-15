CREATE TABLE "statutory_ruleset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"country" text DEFAULT 'MY' NOT NULL,
	"version" text NOT NULL,
	"effective_from" date NOT NULL,
	"data" jsonb NOT NULL,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "statutory_ruleset" ADD CONSTRAINT "statutory_ruleset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statutory_ruleset" ADD CONSTRAINT "statutory_ruleset_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statutory_ruleset_lookup_idx" ON "statutory_ruleset" USING btree ("tenant_id","country","effective_from");