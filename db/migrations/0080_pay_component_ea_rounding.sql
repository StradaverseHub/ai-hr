-- ADR-0035 1A: pay-component EA-form-line mapping (#14) + per-component rounding method (#15).
-- Additive + backfill-safe: existing components default rounding_method='none' (= legacy exact-2dp
-- behaviour, so the gated kernel stays byte-identical), ea_form_line stays NULL (unmapped) until set.
ALTER TABLE pay_component
  ADD COLUMN ea_form_line text,
  ADD COLUMN rounding_method text NOT NULL DEFAULT 'none';
