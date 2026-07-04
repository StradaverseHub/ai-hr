-- System Labels relocation (feedback: Relocate Organization Master Data to Admin Settings).
-- Additive, no data loss: a nullable free-text `description` on the four org catalogs so admins can
-- leave a short note on each department / position / cost center / business unit. No backfill needed;
-- existing rows keep NULL. No new GRANT needed — the tables are already granted to ai_hr_app
-- (migrations 0002 / 0136), and adding a column to an already-granted table requires no new grant.
ALTER TABLE department ADD COLUMN description text;
ALTER TABLE "position" ADD COLUMN description text;
ALTER TABLE cost_center ADD COLUMN description text;
ALTER TABLE business_unit ADD COLUMN description text;
