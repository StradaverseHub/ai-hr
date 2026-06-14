CREATE TYPE "public"."kb_audience" AS ENUM('all', 'employee', 'manager', 'hr_admin');--> statement-breakpoint
CREATE TYPE "public"."kb_kind" AS ENUM('article', 'file');--> statement-breakpoint
CREATE TABLE "kb_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "kb_kind" NOT NULL,
	"title" text NOT NULL,
	"slug" text,
	"category" text DEFAULT 'general' NOT NULL,
	"audience" "kb_audience" DEFAULT 'all' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"body" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" integer,
	"content" "bytea",
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_document_kind_shape" CHECK (("kb_document"."kind" = 'article' AND "kb_document"."body" IS NOT NULL AND "kb_document"."content" IS NULL)
          OR ("kb_document"."kind" = 'file' AND "kb_document"."content" IS NOT NULL AND "kb_document"."file_name" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document" ADD CONSTRAINT "kb_document_updated_by_user_id_app_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_document_tenant_idx" ON "kb_document" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kb_document_category_idx" ON "kb_document" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_document_tenant_slug_uq" ON "kb_document" USING btree ("tenant_id","slug");