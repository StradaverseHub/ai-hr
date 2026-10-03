-- Preserve every existing category and selected scheme. No detailed choice can be inferred.
ALTER TABLE employee_statutory_my ADD COLUMN tax_circumstance text;
ALTER TABLE employee_statutory_my ADD COLUMN tax_applicability_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE employment_tax_selection_my ADD COLUMN tax_applicability_epoch integer NOT NULL DEFAULT 0;
