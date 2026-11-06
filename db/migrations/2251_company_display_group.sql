-- Display grouping is independent of the legal parent and the dated assignment model.
ALTER TABLE public.company
  ADD COLUMN display_group_field text,
  ADD COLUMN display_group_option_id uuid,
  ADD CONSTRAINT company_display_group_shape CHECK (
    (display_group_field IS NULL AND display_group_option_id IS NULL)
    OR (display_group_field IS NOT NULL AND display_group_option_id IS NOT NULL AND
        display_group_field IN ('business_unit','department','division','branch','region','line','section','team','base','category'))
  );
