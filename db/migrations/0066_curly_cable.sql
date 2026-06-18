-- Wave 2C (ADR-0024) — pay_period parent + per-run columns on payroll_batch. GATED + backfill-safe:
-- every existing batch becomes run_seq=1, run_type='regular' under one pay_period per (company, month),
-- so behaviour is unchanged until MULTI_CYCLE_PAYROLL_ENABLED is switched on (after the §7 sign-off).
-- (Hand-edited from the drizzle-generated DDL to add the nullable→backfill→NOT NULL ordering and the
--  one-time link of existing batches; the generated 0066 snapshot already describes this end state.)

CREATE TYPE "public"."pay_period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payroll_run_type" AS ENUM('regular', 'off_cycle', 'bonus', 'adjustment');--> statement-breakpoint
CREATE TABLE "pay_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"status" "pay_period_status" DEFAULT 'open' NOT NULL,
	"statutory_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pay_period" ADD CONSTRAINT "pay_period_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_period" ADD CONSTRAINT "pay_period_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_period_company_period_uq" ON "pay_period" USING btree ("company_id","period");--> statement-breakpoint
-- run_seq / run_type get behaviour-preserving defaults on existing rows.
ALTER TABLE "payroll_batch" ADD COLUMN "run_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_batch" ADD COLUMN "run_type" "payroll_run_type" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
-- pay_period_id added NULLABLE first, backfilled, then made NOT NULL (backfill-safe).
ALTER TABLE "payroll_batch" ADD COLUMN "pay_period_id" uuid;--> statement-breakpoint
-- One parent per existing batch: the old (company_id, pay_period) unique index guarantees each batch
-- is already a distinct (company, month). Status = closed iff the batch is closed; ruleset version
-- snapshotted from a child payslip when present.
INSERT INTO "pay_period" ("tenant_id", "company_id", "period", "status", "statutory_version", "created_at")
SELECT b.tenant_id, b.company_id, b.pay_period,
       CASE WHEN b.status = 'closed' THEN 'closed'::pay_period_status ELSE 'open'::pay_period_status END,
       (SELECT p.statutory ->> 'version' FROM "payslip" p WHERE p.batch_id = b.id LIMIT 1),
       b.created_at
FROM "payroll_batch" b;--> statement-breakpoint
-- Link each batch to its parent. The closed-batch immutability guard (0011) would reject this UPDATE on
-- already-closed batches, so disable it for this one-time structural backfill only, then re-enable.
ALTER TABLE "payroll_batch" DISABLE TRIGGER "batch_immutable_when_closed";--> statement-breakpoint
UPDATE "payroll_batch" b SET "pay_period_id" = pp.id
FROM "pay_period" pp
WHERE pp.tenant_id = b.tenant_id AND pp.company_id = b.company_id AND pp.period = b.pay_period;--> statement-breakpoint
ALTER TABLE "payroll_batch" ENABLE TRIGGER "batch_immutable_when_closed";--> statement-breakpoint
ALTER TABLE "payroll_batch" ALTER COLUMN "pay_period_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_batch" ADD CONSTRAINT "payroll_batch_pay_period_id_pay_period_id_fk" FOREIGN KEY ("pay_period_id") REFERENCES "public"."pay_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Swap month-uniqueness from (company_id, pay_period) to the parent/run model.
DROP INDEX "payroll_batch_period_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_batch_period_run_uq" ON "payroll_batch" USING btree ("pay_period_id","run_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_batch_one_regular_uq" ON "payroll_batch" USING btree ("pay_period_id") WHERE run_type = 'regular';