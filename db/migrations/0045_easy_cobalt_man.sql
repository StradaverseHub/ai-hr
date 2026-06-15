CREATE TABLE "statutory_pack" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"country" text DEFAULT 'MY' NOT NULL,
	"schema_version" integer NOT NULL,
	"pack_version" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"effective_from" date NOT NULL,
	"data" jsonb NOT NULL,
	"checksum" text NOT NULL,
	"signed_key_id" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingested_source" text
);
--> statement-breakpoint
CREATE TABLE "statutory_pack_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"sequence_seen" integer,
	"ingested" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "statutory_signing_key" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"certified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"trust_sequence" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "statutory_pack_identity_uq" ON "statutory_pack" USING btree ("country","pack_version","ruleset_version","effective_from");--> statement-breakpoint
CREATE INDEX "statutory_pack_lookup_idx" ON "statutory_pack" USING btree ("country","effective_from");