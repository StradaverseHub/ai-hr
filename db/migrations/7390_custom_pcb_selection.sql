-- Board d8dc0a8c (ADR 0183): two HR-chosen custom PCB methods on the employer-scoped Income Tax Resident selection.
--
-- custom_fixed: payroll deducts custom_pcb_amount (RM) as the month's PCB, without any PCB formula.
-- custom_rate:  payroll applies custom_pcb_rate (%) the way it applies the Non-Resident 30% today.
--
-- Additive: both columns are nullable and every existing row keeps both NULL, so no saved selection changes meaning.
-- The value checks make a custom scheme without its number (or a number on any other scheme) unrepresentable. The
-- only writers of employment_tax_selection_my are the tax-selection module (legacy initialize, save, hire, transfer)
-- and the 0505 conversion; none writes a custom scheme except the save path, which writes the value with it.
ALTER TABLE employment_tax_selection_my ADD COLUMN custom_pcb_amount numeric(12,2);
--> statement-breakpoint
ALTER TABLE employment_tax_selection_my ADD COLUMN custom_pcb_rate numeric(5,2);
--> statement-breakpoint
ALTER TABLE employment_tax_selection_my DROP CONSTRAINT employment_tax_selection_my_scheme_check;
--> statement-breakpoint
ALTER TABLE employment_tax_selection_my ADD CONSTRAINT employment_tax_selection_my_scheme_check
 CHECK (scheme IN ('resident','non_resident','rep','knowledge_worker','c_suite','custom_fixed','custom_rate'));
--> statement-breakpoint
ALTER TABLE employment_tax_selection_my ADD CONSTRAINT employment_tax_selection_my_custom_pcb_check CHECK (
 CASE scheme
  WHEN 'custom_fixed' THEN custom_pcb_amount IS NOT NULL AND custom_pcb_amount > 0 AND custom_pcb_rate IS NULL
  WHEN 'custom_rate' THEN custom_pcb_rate IS NOT NULL AND custom_pcb_rate > 0 AND custom_pcb_rate <= 100 AND custom_pcb_amount IS NULL
  ELSE custom_pcb_amount IS NULL AND custom_pcb_rate IS NULL
 END
);
--> statement-breakpoint
GRANT UPDATE(custom_pcb_amount,custom_pcb_rate) ON employment_tax_selection_my TO ai_hr_app;
