-- 6e122302 — the Notice Board: HR publishes an announcement to a RESOLVED SET of employees.
--
-- Release ONE of two. This migration carries publishing and targeting; acknowledgement tracking (one row
-- per (notice, employment) written on first acknowledgement, with the typed name and the agreement text it
-- was given against) is deliberately NOT here — the approved plan splits the item that way because
-- publishing is useful on day one and acknowledgement is evidence, which is worth getting right rather
-- than fast.
--
-- ── THE ONE DESIGN DECISION THAT DRIVES EVERYTHING BELOW ──────────────────────────────────────────────
-- THE AUDIENCE IS SNAPSHOT AT PUBLISH TIME. `notice_recipient` holds the resolved employment ids; the
-- criteria that produced them are kept on `notice.criteria` for disclosure only.
--
-- Re-resolving the criteria on every read is less schema and it is wrong. An employee who transfers
-- department the week after a notice goes out would silently STOP being a recipient of a notice they had
-- already been sent and (in release two) already acknowledged — and an acknowledgement report that changes
-- retrospectively is not a record of anything. `leave_adjustment_batch` (0353) stores its batch and its
-- resolved targets for the same reason, and this follows it.
--
-- ── AND THE ONE COLUMN THAT IS DELIBERATELY ABSENT ────────────────────────────────────────────────────
-- There is NO status column. Draft / Scheduled / Active / Expired are functions of (published_at, start_on,
-- end_on) and Archived is archived_at. A stored status needs a nightly job to flip it and acquires a way to
-- be wrong; `deriveNoticeStatus` in core/notice.ts is the single definition instead.

CREATE TABLE IF NOT EXISTS notice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  title text NOT NULL,
  -- Markdown. Rendered by components/markdown.tsx — the SAME react-markdown renderer the Knowledge Base
  -- uses, which passes NO raw HTML through (no rehype-raw). That is a security property, not a styling
  -- one: a WYSIWYG that stores raw HTML would make every notice a stored-XSS vector aimed at every
  -- employee in the company, which is the worst possible audience for one.
  body text NOT NULL,
  -- The visibility window. Both required: an announcement with no end date is a permanent fixture nobody
  -- ever removes. show_end_date decides whether the employee is TOLD the end date, not whether one exists
  -- (the reporter's "Display End Date on Notice" option).
  start_on date NOT NULL,
  end_on date NOT NULL,
  show_end_date boolean NOT NULL DEFAULT false,
  -- 'criteria' | 'individual' — the leave_adjustment_batch vocabulary (0353). Recorded because the same
  -- resolved set means different things, and re-publishing a criteria notice later can legitimately reach
  -- a different set of people.
  target_mode text NOT NULL DEFAULT 'criteria',
  -- The criteria AS POSTED (core/org-criteria.ts OrgCriteria). Disclosure only. NOTE that the reporter's
  -- "Posting Company: All Companies / Selected Companies" is exactly criteria.companyIds — empty means all
  -- — rather than a second company-scope column that could disagree with it.
  criteria jsonb,
  -- NULL ⇒ draft. Set ONCE, at publish. There is no un-publish: it would strand every recipient who has
  -- already read the notice, and (release two) every acknowledgement given against it. Archive withdraws.
  published_at timestamptz,
  published_by_user_id uuid REFERENCES app_user(id),
  archived_at timestamptz,
  archived_by_user_id uuid REFERENCES app_user(id),
  -- Should publishing raise a notification? There is deliberately NO second mail path: publishing appends
  -- a notice.published domain event, and core/notifications.ts turns it into ordinary notifications for
  -- the snapshot audience, delivered by the engine that already handles preferences and channels.
  notify_on_publish boolean NOT NULL DEFAULT false,
  popup_enabled boolean NOT NULL DEFAULT false,
  -- 'once' (default) | 'until_acknowledged'. Decided in the plan rather than asked of the reporter, because
  -- the board's approve carries no reply — and because a notice that reappears at every login is both the
  -- most effective way to be seen and the fastest way to make people resent the system.
  popup_frequency text NOT NULL DEFAULT 'once',
  created_by_user_id uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- A blank title is a notice nobody can identify in the listing. Refused here, not only in the form,
-- because the form is not the only possible writer.
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_title_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_title_check CHECK (btrim(title) <> '');
--> statement-breakpoint

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_body_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_body_check CHECK (btrim(body) <> '');
--> statement-breakpoint

-- An inverted window has no derivable status: it is simultaneously never-started and already-expired.
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_window_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_window_check CHECK (end_on >= start_on);
--> statement-breakpoint

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_target_mode_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_target_mode_check CHECK (target_mode IN ('criteria', 'individual'));
--> statement-breakpoint

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_popup_frequency_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_popup_frequency_check
  CHECK (popup_frequency IN ('once', 'until_acknowledged'));
--> statement-breakpoint

-- Both halves of a publish move together, or neither does. A published_at with no publisher loses WHO
-- broadcast to the whole company; a publisher with no timestamp leaves the notice looking like a draft
-- while its recipients can already see it. Same pairing 0353 enforces for a reversal.
ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_publish_pair_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_publish_pair_check
  CHECK ((published_at IS NULL) = (published_by_user_id IS NULL));
--> statement-breakpoint

ALTER TABLE notice DROP CONSTRAINT IF EXISTS notice_archive_pair_check;
--> statement-breakpoint
ALTER TABLE notice ADD CONSTRAINT notice_archive_pair_check
  CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS notice_tenant_window_idx ON notice (tenant_id, start_on, end_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notice_tenant_created_idx ON notice (tenant_id, created_at);
--> statement-breakpoint

-- ── The audience snapshot ─────────────────────────────────────────────────────────────────────────────
--
-- ON DELETE CASCADE is correct HERE and would not be on the ledger: a draft or an unwanted notice can be
-- deleted outright (nothing derives from it), and leaving orphan recipient rows behind would keep counting
-- toward an employee's unread badge for a notice that no longer exists. A PUBLISHED notice is archived
-- rather than deleted — the service refuses the delete — so cascade never erases a broadcast that happened.
CREATE TABLE IF NOT EXISTS notice_recipient (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  notice_id uuid NOT NULL REFERENCES notice(id) ON DELETE CASCADE,
  employment_id uuid NOT NULL REFERENCES employment(id),
  -- A VIEW marker, NOT an acknowledgement. It exists so the dashboard card can say "3 new", which the
  -- reporter asked for explicitly. Acknowledgement (release two) is its own record with its own evidence:
  -- the agreement text shown, the name typed, the moment it was given. Conflating the two would let a
  -- passive page load stand as consent, which is the whole thing acknowledgement exists to avoid.
  first_viewed_at timestamptz,
  -- Popup-frequency state and nothing else: 'once' notices stop popping up after this is set.
  popup_dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- One row per (notice, employment). Also the idempotency key for re-running a publish snapshot.
CREATE UNIQUE INDEX IF NOT EXISTS notice_recipient_uq ON notice_recipient (notice_id, employment_id);
--> statement-breakpoint
-- The employee-side read: "my notices", which is the dashboard card and the popup on every page load.
CREATE INDEX IF NOT EXISTS notice_recipient_employment_idx ON notice_recipient (tenant_id, employment_id);
--> statement-breakpoint

-- ── GRANTS ────────────────────────────────────────────────────────────────────────────────────────────
--
-- STATED EXPLICITLY, not inherited. deploy/bootstrap-db.sql sets ALTER DEFAULT PRIVILEGES FOR ROLE
-- ai_hr_owner, so on production a table this role creates comes out already granted — which is exactly why
-- migration 0353 shipped a table with no grant and nobody noticed until a developer cluster, where a fresh
-- table can land owned by `postgres`, answered the first real render with `permission denied`. No test sees
-- it: the suite connects as the OWNER. So it is written out, the way 0345 / 0354 / 0357 / 0381 write theirs.
-- Idempotent — a GRANT on an already-granted table is a no-op.
GRANT SELECT, INSERT, UPDATE, DELETE ON "notice" TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notice_recipient" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ───────────────────────────────────────────────────────────────────────────────────────────────
--
-- Two audiences, so two policies per table — the `notification` shape from 0078, which has the same split
-- (an admin dispatcher that writes for everyone, and recipients who read only their own).
--
-- ADMIN: full control of the tenant's notices. Creating, editing, publishing, archiving and deleting are
-- all administrative acts, and an admin must be able to read every notice including drafts.
ALTER TABLE notice ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS notice_admin_rls ON notice;
--> statement-breakpoint
CREATE POLICY notice_admin_rls ON notice FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- RECIPIENT: SELECT only, and only a PUBLISHED, non-archived notice they are actually in the snapshot for.
-- A separate FOR SELECT policy rather than widening the admin one, so an employee can never write.
--
-- ⚠️ WHY THE DATE WINDOW HERE IS DELIBERATELY ONE DAY WIDER THAN THE PRODUCT'S.
-- The authoritative window test is in core/notice.ts and runs against `todayInKualaLumpur()` — the tenant
-- timezone, per the standing rule that a date derived from an instant must go through it. Postgres
-- `current_date` here is UTC, which between 00:00 and 08:00 MYT is YESTERDAY. A policy using bare
-- `current_date` would therefore HIDE a notice on the morning of its own start date — the product would be
-- right and the database would refuse it. Rather than teach RLS the tenant timezone (a security predicate
-- that depends on tenant config is a worse trade), the fence is widened by a day on each side: strictly
-- wider than any timezone offset can shift, so it never contradicts the service, while still keeping a
-- notice scheduled for next month unreadable by the people it will eventually reach.
DROP POLICY IF EXISTS notice_recipient_read_rls ON notice;
--> statement-breakpoint
CREATE POLICY notice_recipient_read_rls ON notice FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND published_at IS NOT NULL
    AND archived_at IS NULL
    AND start_on - 1 <= current_date
    AND current_date <= end_on + 1
    AND EXISTS (
      SELECT 1 FROM notice_recipient nr
        JOIN employment e ON e.id = nr.employment_id
      WHERE nr.notice_id = notice.id
        AND nr.tenant_id = app.current_tenant_id()
        AND app.is_self_person(e.person_id)
    )
  );
--> statement-breakpoint

ALTER TABLE notice_recipient ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- ADMIN: writes the snapshot at publish, and (release two) reads it for the acknowledgement report.
DROP POLICY IF EXISTS notice_recipient_admin_rls ON notice_recipient;
--> statement-breakpoint
CREATE POLICY notice_recipient_admin_rls ON notice_recipient FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- RECIPIENT: their OWN rows, read and update. UPDATE is needed and is narrow — the only two columns an
-- employee changes are first_viewed_at (opening the notice) and popup_dismissed_at (closing the popup),
-- and both are facts about them. `app.is_self_person` is the same predicate `notification` uses for the
-- equivalent "mark my own as read" write (0078). The WITH CHECK repeats the USING clause so a row can
-- never be updated OUT of the caller's own set.
DROP POLICY IF EXISTS notice_recipient_self_rls ON notice_recipient;
--> statement-breakpoint
CREATE POLICY notice_recipient_self_rls ON notice_recipient FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM employment e WHERE e.id = employment_id AND app.is_self_person(e.person_id))
  );
--> statement-breakpoint
DROP POLICY IF EXISTS notice_recipient_self_update_rls ON notice_recipient;
--> statement-breakpoint
CREATE POLICY notice_recipient_self_update_rls ON notice_recipient FOR UPDATE
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM employment e WHERE e.id = employment_id AND app.is_self_person(e.person_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM employment e WHERE e.id = employment_id AND app.is_self_person(e.person_id))
  );
