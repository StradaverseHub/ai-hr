-- ADR-0038 2F-2 (R37): per-locale leave-type display names. { ms: { name }, zh: { name }, ... } —
-- mirrors kb_document.i18n. Reads resolve to the viewer's locale, falling back to leave_type.name.
-- Additive + nullable (existing rows keep English-only names).
ALTER TABLE leave_type ADD COLUMN i18n jsonb;
