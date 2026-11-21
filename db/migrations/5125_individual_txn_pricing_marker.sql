-- 792053e5 (draft, unallocated) — which Pay Item pricing produced a one-off transaction's stored amount, so
-- processing or reprocessing an OPEN run re-prices the row from its saved Hours, Days or Quantity with the latest
-- saved formula. NULL (every existing row, every hand-typed Amount) is never re-priced. 'pay_item_rule' is a legacy
-- derived rule (per hour, per day, Calculated by Formula; calculation_method NULL) and pricing_ref is the sha256 of
-- that rule; 'saved_formula' is a Pay Formula Builder input (calculation_method 'formula') and pricing_ref is the
-- formula revision id. priced_at is when the stored amount was last priced. Nullable columns, no default, no backfill.
ALTER TABLE payroll_individual_txn
  ADD COLUMN pricing_source text,
  ADD COLUMN pricing_ref text,
  ADD COLUMN priced_at timestamptz,
  ADD CONSTRAINT payroll_individual_txn_pricing_marker_check CHECK (
    (pricing_source IS NULL AND pricing_ref IS NULL AND priced_at IS NULL)
    OR (pricing_source = 'pay_item_rule' AND calculation_method IS NULL AND pricing_ref IS NOT NULL AND priced_at IS NOT NULL)
    OR (pricing_source = 'saved_formula' AND calculation_method = 'formula' AND pricing_ref IS NOT NULL AND priced_at IS NOT NULL)
  );
