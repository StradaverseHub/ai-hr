-- New imported calculations retain their requested type without pretending to be a fixed rule.
-- Existing rows receive NULL for both fields; no existing financial configuration is rewritten.
ALTER TABLE pay_component ADD COLUMN description text;
ALTER TABLE pay_component ADD COLUMN pending_input_kind text;
ALTER TABLE pay_component ADD CONSTRAINT pay_component_description_length
  CHECK (description IS NULL OR char_length(description) <= 200);
ALTER TABLE pay_component ADD CONSTRAINT pay_component_pending_input_kind
  CHECK (pending_input_kind IS NULL OR (
    pending_input_kind IN ('qty_rate', 'percent_of', 'per_day', 'per_hour', 'flat_capped', 'formula')
    AND rule IS NULL
  ));
