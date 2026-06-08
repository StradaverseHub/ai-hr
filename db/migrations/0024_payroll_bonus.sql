ALTER TABLE "payroll_input" ADD COLUMN "bonus_amount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslip" ADD COLUMN "bonus" numeric(12, 2) DEFAULT '0' NOT NULL;