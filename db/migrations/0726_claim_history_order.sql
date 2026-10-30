-- Bounded newest-first history reads. Existing RLS and grants are unchanged.
CREATE INDEX claim_request_history_order_idx
  ON claim_request (employment_id, created_at DESC, id DESC);
