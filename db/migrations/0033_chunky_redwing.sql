ALTER TABLE "employee_statutory_my" ADD COLUMN "is_resident" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_input" ADD COLUMN "tp1_deduction" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_input" ADD COLUMN "zakat" numeric(12, 2) DEFAULT '0' NOT NULL;