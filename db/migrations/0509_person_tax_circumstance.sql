-- Preserve every existing category and selected scheme. No detailed choice can be inferred.
ALTER TABLE employee_statutory_my ADD COLUMN tax_circumstance text;
ALTER TABLE employee_statutory_my ADD COLUMN tax_applicability_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE employment_tax_selection_my ADD COLUMN tax_applicability_epoch integer NOT NULL DEFAULT 0;
-- Preserve the existing column-scoped writer grants; permit only the new acknowledgement field.
GRANT UPDATE(tax_applicability_epoch) ON employment_tax_selection_my TO ai_hr_app;
ALTER TABLE employee_statutory_my ADD CONSTRAINT employee_statutory_my_tax_circumstance_check CHECK (
  tax_circumstance IS NULL OR tax_circumstance = 'none' OR
  (tax_circumstance = 'single' AND tax_category = 1) OR
  (tax_circumstance = 'spouse_not_working' AND tax_category = 2) OR
  (tax_circumstance IN ('spouse_working', 'widow_divorced') AND tax_category = 3)
);
ALTER TABLE employee_statutory_my ADD CONSTRAINT employee_statutory_my_tax_applicability_epoch_check CHECK (tax_applicability_epoch >= 0);
ALTER TABLE employment_tax_selection_my ADD CONSTRAINT employment_tax_selection_my_tax_applicability_epoch_check CHECK (tax_applicability_epoch >= 0);
