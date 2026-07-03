-- Un-withdraw feedback (ADR-0043 follow-up). Additive ALTER TABLE feedback_request, modelled on 0140:
--   • status_before_cancel — snapshot of `status` at the moment cancelFeedback ran (open / planned /
--     contested / approved), so restoreFeedback can put the item back exactly where it was instead of
--     always resetting to `open`. NULLABLE: null for every row except while status = 'cancelled'.
--
-- RLS/policies on feedback_request already exist and are unchanged; grants are table-level (0106-era),
-- so the added column needs no new grants.

ALTER TABLE "feedback_request" ADD COLUMN "status_before_cancel" "feedback_status";
