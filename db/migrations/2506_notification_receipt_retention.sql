-- Receipts are derived from their source event: ON DELETE CASCADE now ships on the
-- foreign key that 2504 creates, while the receipt table is still empty. Re-adding the
-- constraint here took ACCESS EXCLUSIVE on domain_event and re-checked every row until
-- the migration batch committed. This entry keeps its journal position only.
SELECT 1;
