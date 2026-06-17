-- Performance Phase B — 360 peer feedback RLS (ADR-0022, slice 3). Anonymity is enforced here.
--
-- peer_feedback_request (carries the peer identity): visible to the PEER (to respond) and to the
--   subject's MANAGER / ADMIN (to invite + track) — but NOT the subject, who must never learn who was
--   asked. So: caller-is-the-peer OR (can_see_employment(subject) AND caller-is-not-the-subject).
-- peer_feedback (the content, no author column): readable by the subject + their manager + admin
--   (can_see_employment(subject)) and by the peer who wrote it. Because authorship lives only on the
--   request — which the subject's RLS above denies — the subject's view is anonymous by construction.
--   WRITE is restricted to the peer (a manager/admin/subject can read but never author feedback).

ALTER TABLE peer_feedback_request ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE peer_feedback ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON peer_feedback_request TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON peer_feedback TO ai_hr_app;--> statement-breakpoint

CREATE POLICY peer_feedback_request_rls ON peer_feedback_request FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      EXISTS (SELECT 1 FROM employment e WHERE e.id = peer_feedback_request.peer_employment_id AND app.is_self_person(e.person_id))
      OR (
        app.can_see_employment(peer_feedback_request.subject_employment_id)
        AND NOT EXISTS (SELECT 1 FROM employment e WHERE e.id = peer_feedback_request.subject_employment_id AND app.is_self_person(e.person_id))
      )
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      EXISTS (SELECT 1 FROM employment e WHERE e.id = peer_feedback_request.peer_employment_id AND app.is_self_person(e.person_id))
      OR (
        app.can_see_employment(peer_feedback_request.subject_employment_id)
        AND NOT EXISTS (SELECT 1 FROM employment e WHERE e.id = peer_feedback_request.subject_employment_id AND app.is_self_person(e.person_id))
      )
    )
  );--> statement-breakpoint

CREATE POLICY peer_feedback_rls ON peer_feedback FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.can_see_employment(peer_feedback.subject_employment_id)
      OR EXISTS (
        SELECT 1 FROM peer_feedback_request rq
        JOIN employment e ON e.id = rq.peer_employment_id
        WHERE rq.id = peer_feedback.request_id AND app.is_self_person(e.person_id)
      )
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM peer_feedback_request rq
      JOIN employment e ON e.id = rq.peer_employment_id
      WHERE rq.id = peer_feedback.request_id AND app.is_self_person(e.person_id)
    )
  );
