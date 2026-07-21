-- Pay Items redesign (feedback 4994a48f) — ONE nullable column: pay_component.label.
--
-- "Label" is an optional short display name (e.g. "Transport") for payslips and reports later,
-- alongside the full descriptive `name` (relabelled "Description" in the UI — i18n only, the column
-- is untouched). Mirrors the System Labels shape on department / cost_center / position /
-- business_unit (migration 0181): name + nullable label, and — house precedent — NO unique index on
-- label (core/admin.ts: "Enforced in the service — not a DB index"; nothing looks a pay code up by
-- its label, and a partial-unique index would let a deactivated code block its label forever).
--
-- No backfill (label starts NULL everywhere), no RLS change (0065 pay_component_rls is FOR ALL with
-- no column predicates; table-level GRANTs from 0071 cover new columns), ea_form_line is NOT dropped
-- (the field leaves the maintenance SCREEN only — existing EA mappings and the EA report survive).
--
-- Journal entry: idx 289 (see meta/_journal.json).

ALTER TABLE "pay_component" ADD COLUMN "label" text;
