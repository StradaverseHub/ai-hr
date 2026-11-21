-- Explicit entry methods store final amounts; NULL preserves every historical raw-input row.
ALTER TABLE payroll_individual_txn ADD COLUMN calculation_method text;
ALTER TABLE payroll_individual_txn ADD CONSTRAINT payroll_individual_txn_calculation_method_check
  CHECK (calculation_method IS NULL OR calculation_method IN ('amount', 'formula'));
