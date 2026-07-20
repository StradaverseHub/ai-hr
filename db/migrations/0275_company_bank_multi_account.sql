-- R46 orgbank (84719377) — Bank Account tab: shared MY bank master + MULTIPLE accounts per company.
--
-- Two structural changes, both on company_bank_profile (ADR-0031, created in 0072):
--
-- 1. `bank` stops being the 4-value `disbursement_bank` pgEnum and becomes plain text carrying a key from
--    the shared Malaysian bank master (lib/my-banks.ts) — the same list the EMPLOYEE bank picker reads,
--    which carries each bank's BNM 2-digit routing code. The four historical enum values
--    ('maybank','cimb','public_bank','rhb') are byte-identical to the first four master keys, so this is a
--    pure type change: NO row values move, and every historical domain_event payload still reads the same.
--    Whether a bulk salary-disbursement FILE can be built for a bank is `MyBank.disbursementFormat` in the
--    master (code-side), not a property of the storage value — so widening the picker cannot, by itself,
--    make a stored row unbuildable without the UI having said so first.
--
-- 2. The (company_id, bank) unique index is DROPPED. Holding several accounts — including more than one at
--    the same bank — is the point of this item. Rows are identified by `id` from here on, so the service's
--    ON CONFLICT upsert becomes update-by-id / insert-new (core/bank-profile.ts). A partial unique index
--    keeps at most ONE primary account per company.
--
-- Plus the fuller account master data the reporter asked for (label / account name / type / branch / SWIFT
-- / currency / primary flag). All nullable-or-defaulted, so existing rows stay valid.
--
-- txn_type is DELIBERATELY untouched: the R46 UI hides its picker but the column and its 'IBG' default
-- stay, because RENTAS is required for large single payments (>= RM10k). Do not drop it.
--
-- Journal entry: idx 275 (see meta/_journal.json).

ALTER TABLE "company_bank_profile" ALTER COLUMN "bank" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ALTER COLUMN "bank" SET DATA TYPE text USING "bank"::text;--> statement-breakpoint
DROP TYPE IF EXISTS "disbursement_bank";--> statement-breakpoint

DROP INDEX IF EXISTS "company_bank_profile_company_bank_uq";--> statement-breakpoint
CREATE INDEX "company_bank_profile_company_idx" ON "company_bank_profile" USING btree ("company_id","bank");--> statement-breakpoint

ALTER TABLE "company_bank_profile" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "account_name" text;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "account_type" text;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "swift_code" text;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "currency" text DEFAULT 'MYR' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- At most one primary account per company. PARTIAL: non-primary rows never collide.
CREATE UNIQUE INDEX "company_bank_profile_primary_uq" ON "company_bank_profile" USING btree ("company_id") WHERE "is_primary";
