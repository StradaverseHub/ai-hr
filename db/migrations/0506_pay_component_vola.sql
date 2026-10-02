-- Explicit living-accommodation category. No existing pay item is reclassified.
ALTER TABLE pay_component DROP CONSTRAINT IF EXISTS pay_component_display_category_check;
--> statement-breakpoint
ALTER TABLE pay_component ADD CONSTRAINT pay_component_display_category_check
  CHECK (display_category IS NULL OR display_category IN
    ('basic','overtime','bonus','allowance','claim','deduction','bik','vola'));
