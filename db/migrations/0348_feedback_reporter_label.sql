-- 0348 — feedback_request.reporter_label: who the board SHOWS as the reporter.
--
-- The improvement loop raises items on the reporter's behalf (scripts/improve/remote.ts raiseFeedback).
-- reporter_employment_id is NOT NULL and drives RLS can_see_employment(), so an operator-raised item has
-- to borrow a real employment — and the board renders person.full_name through that join, which means
-- every item CLAUDE wrote has been displaying the human consultant's name.
--
-- A LABEL fixes it without a synthetic employee. The alternative — creating a "CLAUDE AI" person +
-- employment — would put a fake headcount row into openLeaveYear, payroll and every employee list, which
-- is a far worse trade than one nullable column.
--
-- NULL ⇒ fall through to the joined person name (every in-app submission). listFeedback coalesces.
ALTER TABLE feedback_request ADD COLUMN IF NOT EXISTS reporter_label text;

-- Backfill the items the loop has already raised. The marker is the domain_event written by raiseFeedback
-- itself: feedback.submitted carrying payload->>'via' = 'operator-raised'. That event is appended in the
-- SAME transaction as the row, so it is an exact record of provenance rather than a guess from the text.
--
-- Display only. No status, plan or authority is touched, and reporter_employment_id is left exactly as it
-- was, so RLS visibility and the reporter's own approve/contest rights are unchanged.
UPDATE feedback_request f
   SET reporter_label = 'CLAUDE AI'
  FROM domain_event e
 WHERE e.aggregate_type = 'feedback'
   AND e.aggregate_id = f.id
   AND e.event_type = 'feedback.submitted'
   AND e.payload->>'via' = 'operator-raised'
   AND f.reporter_label IS NULL;
