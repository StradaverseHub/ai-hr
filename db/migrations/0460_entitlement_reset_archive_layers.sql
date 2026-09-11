-- fe9c73bc — entitlement_reset_archive learns TWO MORE LAYERS: 'template' and 'rule'.
--
-- WHY. The approved plan for fe9c73bc clears a tenant's entitlement configuration — every
-- entitlement_template row and every entitlement_eligibility_rule row — and promises the reporter a
-- written record of what was there, "in your admin screens as a read-only listing you can open and
-- download. You have those screens already; a previous reset used the same approach." That screen is
-- /admin/leave-config/records/entitlement, and it reads entitlement_reset_archive. So the reset tool
-- (scripts/reset-entitlement-configuration.ts) writes into the SAME archive table, discriminated by
-- `layer` exactly as 0397 designed it — one row per template version under 'template', one per rule
-- under 'rule' — and the existing reader, capture picker and CSV show the record with no second
-- mechanism.
--
-- WHAT STOOD IN THE WAY. 0397's CHECK on `layer` admits only 'scheme' and 'policy' — the two layers
-- 0398's capture wrote for the tables 0405 then dropped. The reset tool REFUSES to write while that
-- CHECK stands (it preflights the constraint and says so in one sentence), so this migration is what
-- lets the config stage run at all. The tool's refusal stays: it is the fail-closed guard for any
-- environment where this migration has not yet been applied.
--
-- THE NEW SET IS A STRICT SUPERSET. Every row already in the table carries 'scheme' or 'policy' and
-- validates unchanged under the widened CHECK; nothing is rewritten, dropped or re-rendered here. This
-- migration captures nothing and deletes nothing — the reset itself is the explicitly-gated,
-- --apply-flagged operator script, precisely so that shipping this migration is not the same act as
-- clearing a customer's configuration.
--
-- The reader (core/entitlement-archive.ts EntitlementArchiveLayer, the records page, its CSV) already
-- carries the four-value union; this file is the database catching up with it.

ALTER TABLE entitlement_reset_archive DROP CONSTRAINT IF EXISTS entitlement_reset_archive_layer_check;
--> statement-breakpoint
ALTER TABLE entitlement_reset_archive ADD CONSTRAINT entitlement_reset_archive_layer_check
  CHECK (layer IN ('scheme', 'policy', 'template', 'rule'));
