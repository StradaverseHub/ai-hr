-- Recruitment slice 19 (docs/recruitment-reconstruction/specification.md "Slice 19"; decision record
-- docs/adr/2026-11-14-recruitment-candidate-email.md; D-063, D-064): candidate e-mail — a company's sender name and reply-to, editable
-- templates in the six app languages, receipts for candidates HR adds (when ticked) and rejection letters, delivered through the
-- installation's embedded mail relay by a leased sweep modelled on lifecycle v9 delivery (0714/0717). Careers-page receipts are NOT in
-- this slice (D-064): a careers address is unverified and the name visitor-supplied, so the company's relay (which also carries sign-in
-- and recovery mail) would mail anyone a visitor names; they come with slice 21, after the applicant's address is verified by code.
--
-- Who:
--   settings and templates — recruitment administrators (app.can_admin_recruitment_for) write; the company's job teams read them (a job's
--                            reviewers render the rejection preview from them). No personal data.
--   candidate e-mails      — queued only by a signed-in person who reviews the application's job (administrators, the job's recruiter,
--                            assistants and hiring managers: the people who may reject or add it), recorded as the actor, in the same
--                            transaction as the reject, archive or add. Read by the job's reviewers (metadata and the frozen content:
--                            the e-mail states only what a reviewer already sees — the candidate's name and the job title — plus the
--                            company's wording). Interviewers and everyone else read nothing. Only administrators retry a failed or
--                            uncertain e-mail. Nobody in the app deletes one: candidate removal and the company delete do.
--   the sweep              — owner-only SECURITY DEFINER functions (claim, target, start, finish, purge) that take a delivery id and a
--                            lease token and never a recipient or content: the address and the words are frozen at queue time.
--
-- What this installs:
--   1. public.recruitment_candidate_email_setting (one per company): "E-mail candidates" (off by default), sender display name (≤80;
--      NULL = the company name), reply-to (required when on), the language of candidate e-mails (en, ms, zh, vi, ta, th; the candidate
--      has no recorded preferred language, so this company setting decides; default English).
--   2. public.recruitment_candidate_email_template: a company override per kind and language — subject ≤200 and body ≤5,000 plain text,
--      placeholders from the kind's allowlist only (app.recruitment_candidate_email_placeholders_ok), nothing link- or domain-like
--      (app.recruitment_candidate_email_linkish). Kinds in this slice: application_received and rejection (slice 20 adds its kinds to the
--      CHECKs and the allowlist).
--   3. public.recruitment_candidate_email: one delivery per e-mail with the frozen recipient, subject, text, HTML, sender name and
--      reply-to; state (queued, leased, sending, sent, retry, failed, uncertain), attempts, lease, start and completion times, the actor,
--      an administrator's retry, and the purge time. CHECKs hold the frozen content to the renderer's output: no link- or domain-like
--      subject or text (values included) and HTML of the renderer's grammar only. At most one receipt and one rejection per application.
--      Row guard (app.recruitment_guard_candidate_email, in-memory only): queued now (rejections up to three days later) by the current
--      user. Statement check (app.recruitment_check_candidate_email_queue, once per INSERT over the transition table): the application,
--      job and candidate agree; a rejection only in the transaction that archived the application, a receipt only in the one that
--      created it; the recipient is the candidate's recorded e-mail and the candidate not removed; the company's switch is on with the
--      current sender name, reply-to and language; at most 500 per company per hour, counted under a per-company advisory lock. A
--      person may change a row only as an administrator's retry of a failed or uncertain e-mail whose content is still kept. Frozen
--      columns never change; content only goes (purge).
--   4. The sweep functions (owner only): app.recruitment_candidate_email_claim leases due rows FOR UPDATE SKIP LOCKED (concurrent sweeps
--      never claim one row twice) and first turns an expired STARTED lease into 'uncertain' (never replayed) and an expired unstarted
--      lease back into a due row; _target returns the frozen content of a live, unstarted lease (nothing while the company's switch is
--      off or once the address is no longer the candidate's recorded one); _start commits 'sending' before any SMTP byte and extends the
--      lease over the send; _finish records sent, retry (4xx: back off min(3600, 60·2^attempts) seconds, at most 5 attempts, then failed),
--      failed (5xx, authentication, TLS, or before any connection an invalid message or a relay that could not be prepared) or uncertain;
--      and, before a start, held (relay unavailable: due again in 5 minutes, the attempt not counted; failed after 7 days) or skipped
--      (not eligible: failed). _purge clears the address and content of e-mails 90 days after their final state, keeping the metadata
--      (bounded batch). Every outcome writes a domain event without address or content. The sweep reads a candidate's current address
--      through a new owner-only policy on public.recruitment_candidate. Every owner-bound policy here is keyed by the owner-only
--      context table app.recruitment_candidate_email_context, which the functions write for their own transaction and delete before
--      they return — never by a session setting, which any session could set.
--   5. app.recruitment_destroy_candidate restated (5217 body byte for byte) plus one step: the candidate's e-mails go.
--   6. app.recruitment_delete_company_setup restated (5219 body byte for byte) plus one block: the e-mails, templates and settings.
--
-- No index, constraint or trigger is added to an existing table; the one change to one is the owner-only read policy above.
--
-- Nothing here calls a model, scores a candidate or decides anything about an application: people reject; this only carries the
-- e-mail they chose to send.

-- ── 1. Company e-mail settings ─────────────────────────────────────────────────────────────────────────────
-- The effective sender display name: the company's own (≤80) or the company name — control characters made spaces, leading space
-- removed, cut to 80 characters, then trailing space removed. "Space" includes the Unicode spaces JavaScript's trim() removes
-- (no-break, ideographic …), so the name is what the transport accepts (packs/recruitment/candidate-email-model.ts defaultSenderName
-- is the same rule). One expression for the service, the queue check and the sweep.
CREATE FUNCTION app.recruitment_candidate_email_sender(p_sender_name text, p_company_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(p_sender_name, regexp_replace(left(regexp_replace(regexp_replace(coalesce(p_company_name, ''), '[\x01-\x1f\x7f-\x9f]', ' ', 'g'),
  '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ''), 80), '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', ''));
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_sender(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_sender(text, text) TO ai_hr_app;
--> statement-breakpoint
-- Link-like text (one pattern, also LINK_PATTERN in candidate-email-model.ts, compared by a test): a known scheme followed by ":" and
-- more (http, https, ftp, mailto, tel, sms, data, javascript, vbscript, file), any "://", a "//" at the start or after a space or
-- punctuation, "www" with any dot (Unicode dots too), punycode ("xn--"), or a bare domain followed by "/" ("evil.example/login").
-- Ordinary names and titles stay allowed ("S.Kumar", "Node.js Developer", "ASP.NET Engineer", "Ref:HR-12"). Templates, and the frozen
-- subject and text with every value filled in, must not contain one: no links in this slice.
CREATE FUNCTION app.recruitment_candidate_email_linkish(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_text ~* '(^|[^a-z0-9])(https?|ftp|mailto|tel|sms|data|javascript|vbscript|file):\S|://|(^|[^a-z0-9])//|www[.。．｡]|xn--|[a-z0-9-][.。．｡][a-z]{2,}/';
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_linkish(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_linkish(text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.recruitment_candidate_email_setting (
 company_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 enabled boolean NOT NULL DEFAULT false,
 sender_name text CHECK (sender_name IS NULL OR (char_length(sender_name) BETWEEN 1 AND 80
  AND sender_name !~ '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' AND sender_name !~ '[\x01-\x1f\x7f-\x9f]')),
 -- The service validates the address with the transport's own canonical-address rule (lib/email-address.ts); this is its outline.
 reply_to text CHECK (reply_to IS NULL OR (char_length(reply_to) <= 254 AND reply_to ~ '^[!-~]+@[!-~]+$')),
 locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_email_setting_reply_to_ck CHECK (NOT enabled OR reply_to IS NOT NULL),
 CONSTRAINT recruitment_candidate_email_setting_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_setting_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_setting_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_candidate_email_setting_tenant_idx ON public.recruitment_candidate_email_setting (tenant_id);
CREATE INDEX recruitment_candidate_email_setting_created_by_idx ON public.recruitment_candidate_email_setting (created_by_user_id);
CREATE INDEX recruitment_candidate_email_setting_updated_by_idx ON public.recruitment_candidate_email_setting (updated_by_user_id);
--> statement-breakpoint

-- ── 2. Template overrides ──────────────────────────────────────────────────────────────────────────────────
-- Every {…} in a template names a placeholder of the kind's allowlist, and no brace is left outside one. Slice 20 restates this with
-- its kinds' placeholders.
CREATE FUNCTION app.recruitment_candidate_email_placeholders_ok(p_kind text, p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_text IS NOT NULL AND p_kind IN ('application_received','rejection')
  AND NOT EXISTS (SELECT 1 FROM regexp_matches(p_text, '\{([^{}]*)\}', 'g') AS m(x)
   WHERE NOT (m.x[1] = ANY (ARRAY['candidateName','jobTitle','companyName','senderName'])))
  AND regexp_replace(p_text, '\{[^{}]*\}', '', 'g') !~ '[{}]';
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE public.recruitment_candidate_email_template (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('application_received','rejection')),
 locale text NOT NULL CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[\x01-\x1f\x7f-\x9f]'),
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000 AND body !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f]'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 -- No links, images or tracking in this slice (D-063): plain words only.
 CONSTRAINT recruitment_candidate_email_template_no_links_ck CHECK (NOT app.recruitment_candidate_email_linkish(subject)
  AND NOT app.recruitment_candidate_email_linkish(body)),
 CONSTRAINT recruitment_candidate_email_template_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_template_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_template_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_template_uq UNIQUE (company_id, kind, locale)
);
CREATE INDEX recruitment_candidate_email_template_tenant_idx ON public.recruitment_candidate_email_template (tenant_id, company_id);
CREATE INDEX recruitment_candidate_email_template_created_by_idx ON public.recruitment_candidate_email_template (created_by_user_id);
CREATE INDEX recruitment_candidate_email_template_updated_by_idx ON public.recruitment_candidate_email_template (updated_by_user_id);
--> statement-breakpoint

-- ── 3. Candidate e-mails ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_candidate_email (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('application_received','rejection')),
 locale text NOT NULL CHECK (locale IN ('en','ms','zh','vi','ta','th')),
 -- Frozen at queue time; NULL only once purged (content_purged_at).
 recipient text CHECK (recipient IS NULL OR (char_length(recipient) <= 254 AND recipient ~ '^[!-~]+@[!-~]+$')),
 -- The frozen content is held to what the renderer emits: no link- or domain-like text in the subject or text (with every value
 -- filled in), and HTML of exactly the renderer's grammar — its own wrapper, paragraphs, line breaks and five entities, nothing else.
 subject text CHECK (subject IS NULL OR (char_length(subject) BETWEEN 1 AND 1000 AND subject !~ '[\x01-\x1f\x7f-\x9f]'
  AND NOT app.recruitment_candidate_email_linkish(subject))),
 body_text text CHECK (body_text IS NULL OR (char_length(body_text) BETWEEN 1 AND 20000 AND NOT app.recruitment_candidate_email_linkish(body_text))),
 body_html text CHECK (body_html IS NULL OR (char_length(body_html) BETWEEN 1 AND 200000
  AND body_html ~ '^<!doctype html><html lang="(en|ms|zh|vi|ta|th)"><head><meta charset="utf-8"></head><body>(<p>([^<>&]|<br>|&(amp|lt|gt|quot|#39);)*</p>)*</body></html>$')),
 sender_name text NOT NULL CHECK (char_length(sender_name) BETWEEN 1 AND 80 AND sender_name !~ '[\x01-\x1f\x7f-\x9f]'
  AND sender_name !~ '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'),
 reply_to text NOT NULL CHECK (char_length(reply_to) <= 254 AND reply_to ~ '^[!-~]+@[!-~]+$'),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','sending','sent','retry','failed','uncertain')),
 error_code text CHECK (error_code IS NULL OR error_code IN ('relayUnavailable','notEligible','invalidMessage','relayPreparation','smtpTemporary','smtpRejected',
  'smtpAuthentication','smtpTls','uncertain')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 queued_at timestamptz NOT NULL DEFAULT now(),
 -- The person who queued it (careers-page receipts, which would have none, are not in this slice: D-064).
 queued_by_user_id uuid NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 started_at timestamptz,
 completed_at timestamptz,
 relay_revision text CHECK (relay_revision IS NULL OR char_length(relay_revision) <= 120),
 retried_at timestamptz,
 retried_by_user_id uuid,
 retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 50),
 content_purged_at timestamptz,
 CONSTRAINT recruitment_candidate_email_content_ck CHECK (
  (content_purged_at IS NULL AND recipient IS NOT NULL AND subject IS NOT NULL AND body_text IS NOT NULL AND body_html IS NOT NULL)
  OR (content_purged_at IS NOT NULL AND recipient IS NULL AND subject IS NULL AND body_text IS NULL AND body_html IS NULL
   AND status IN ('sent','failed','uncertain'))),
 CONSTRAINT recruitment_candidate_email_lease_ck CHECK (status NOT IN ('leased','sending') OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CONSTRAINT recruitment_candidate_email_started_ck CHECK (status <> 'sending' OR started_at IS NOT NULL),
 CONSTRAINT recruitment_candidate_email_final_ck CHECK (status NOT IN ('sent','failed','uncertain') OR completed_at IS NOT NULL),
 CONSTRAINT recruitment_candidate_email_retry_ck CHECK ((retried_at IS NULL) = (retried_by_user_id IS NULL)),
 CONSTRAINT recruitment_candidate_email_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_email_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_email_queued_by_fk FOREIGN KEY (queued_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_email_retried_by_fk FOREIGN KEY (retried_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
-- At most one application receipt per application, whoever queues it.
CREATE UNIQUE INDEX recruitment_candidate_email_receipt_uq ON public.recruitment_candidate_email (application_id) WHERE kind = 'application_received';
-- At most one rejection e-mail per application (an application is rejected once; no reopen exists).
CREATE UNIQUE INDEX recruitment_candidate_email_rejection_uq ON public.recruitment_candidate_email (application_id) WHERE kind = 'rejection';
-- The sweep: due rows of a tenant, and leases to expire.
CREATE INDEX recruitment_candidate_email_due_idx ON public.recruitment_candidate_email (tenant_id, next_attempt_at, id) WHERE status IN ('queued','retry');
CREATE INDEX recruitment_candidate_email_lease_idx ON public.recruitment_candidate_email (tenant_id, lease_until) WHERE status IN ('leased','sending');
-- The application page's list; candidate removal; the hourly cap and the per-company counts; the 90-day purge.
CREATE INDEX recruitment_candidate_email_application_idx ON public.recruitment_candidate_email (application_id, queued_at DESC);
CREATE INDEX recruitment_candidate_email_candidate_idx ON public.recruitment_candidate_email (candidate_id);
CREATE INDEX recruitment_candidate_email_company_idx ON public.recruitment_candidate_email (tenant_id, company_id, queued_at) INCLUDE (status);
CREATE INDEX recruitment_candidate_email_purge_idx ON public.recruitment_candidate_email (tenant_id, completed_at)
 WHERE content_purged_at IS NULL AND status IN ('sent','failed','uncertain');
CREATE INDEX recruitment_candidate_email_job_idx ON public.recruitment_candidate_email (job_id, company_id, tenant_id);
CREATE INDEX recruitment_candidate_email_queued_by_idx ON public.recruitment_candidate_email (queued_by_user_id);
CREATE INDEX recruitment_candidate_email_retried_by_idx ON public.recruitment_candidate_email (retried_by_user_id);
--> statement-breakpoint

-- ── 4. Row security and grants ─────────────────────────────────────────────────────────────────────────────
-- The owner-only maintenance context: a row per (transaction, purpose, scope) that the sweep functions ('worker', the tenant) and the
-- hourly count ('count', the company) write when they start and delete before they return. Nobody else can write or read it (no grant,
-- forced row security with an owner-only policy), and it is keyed by the transaction id, so no session setting can stand in for it:
-- the owner-bound policies below admit only rows of THIS transaction's open context.
CREATE TABLE app.recruitment_candidate_email_context (
 txid bigint NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('worker','count')),
 scope_id uuid NOT NULL,
 PRIMARY KEY (txid, purpose, scope_id)
);
ALTER TABLE app.recruitment_candidate_email_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_candidate_email_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_candidate_email_context FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_candidate_email_context_owner ON app.recruitment_candidate_email_context FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_candidate_email_context'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_candidate_email_context'::regclass)));
-- True only while a sweep function (purpose 'worker', scope the tenant) or the hourly count ('count', the company) is running in THIS
-- transaction. txid_current_if_assigned never assigns a transaction id, so evaluating it has no side effect. The app role evaluates it
-- inside the policies below and can never make it true.
CREATE FUNCTION app.recruitment_email_context_open(p_purpose text, p_scope uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_scope IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_candidate_email_context x
  WHERE x.txid = txid_current_if_assigned() AND x.purpose = p_purpose AND x.scope_id = p_scope);
$$;
REVOKE ALL ON FUNCTION app.recruitment_email_context_open(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_email_context_open(text, uuid) TO ai_hr_app;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_email_setting','recruitment_candidate_email_template','recruitment_candidate_email'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Settings and templates: administrators read and write. The policies name no role, so they bind the owner too: inside
-- app.recruitment_delete_company_setup they admit the caller, who administers the company being deleted, and nobody else.
CREATE POLICY recruitment_candidate_email_setting_admin ON public.recruitment_candidate_email_setting FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_candidate_email_template_admin ON public.recruitment_candidate_email_template FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
-- The company's job teams read both (a reviewer who rejects sees the rendered e-mail before sending). Never a write.
CREATE POLICY recruitment_candidate_email_setting_team ON public.recruitment_candidate_email_setting FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_candidate_email_template_team ON public.recruitment_candidate_email_template FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
-- The sweep (owner, inside its functions for the tenant they set): whether the company's switch is still on.
CREATE POLICY recruitment_candidate_email_setting_worker_read ON public.recruitment_candidate_email_setting FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email_setting'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
GRANT SELECT, INSERT, UPDATE ON public.recruitment_candidate_email_setting TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_candidate_email_template TO ai_hr_app;
--> statement-breakpoint
-- E-mails: the job's reviewers read them (and queue them as themselves; the guard checks the rest); administrators retry.
CREATE POLICY recruitment_candidate_email_read ON public.recruitment_candidate_email FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_candidate_email_queue ON public.recruitment_candidate_email FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND queued_by_user_id = app.current_user_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_candidate_email_retry ON public.recruitment_candidate_email FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
GRANT SELECT, INSERT, UPDATE ON public.recruitment_candidate_email TO ai_hr_app;
--> statement-breakpoint
-- Owner-bound maintenance. The app role never satisfies these (current_user is ai_hr_app, never the owner). The owner does only:
-- inside the sweep functions for the tenant their open context names; inside the hourly count for the company its open context names
-- (app.recruitment_candidate_email_context, above); inside app.recruitment_destroy_candidate for the candidate whose 4405 marker THIS transaction holds; and inside
-- app.recruitment_delete_company_setup for the company it is deleting.
CREATE POLICY recruitment_candidate_email_worker ON public.recruitment_candidate_email FOR ALL USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id))
 WITH CHECK (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
CREATE POLICY recruitment_candidate_email_count ON public.recruitment_candidate_email FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND app.recruitment_email_context_open('count', company_id));
CREATE POLICY recruitment_candidate_email_destroy_read ON public.recruitment_candidate_email FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id));
CREATE POLICY recruitment_candidate_email_destroy ON public.recruitment_candidate_email FOR DELETE USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id));
CREATE POLICY recruitment_candidate_email_company_delete_read ON public.recruitment_candidate_email FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND tenant_id = app.current_tenant_id() AND current_setting('app.recruitment_company_delete', true) = company_id::text);
CREATE POLICY recruitment_candidate_email_company_delete ON public.recruitment_candidate_email FOR DELETE USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email'::regclass))
 AND tenant_id = app.current_tenant_id() AND current_setting('app.recruitment_company_delete', true) = company_id::text);
-- The sweep (owner, inside its functions for the tenant they set) compares an e-mail's frozen address with the candidate's CURRENT
-- recorded address before sending. A new owner-only policy on an existing table; no index or constraint is added to it.
CREATE POLICY recruitment_candidate_email_worker_read ON public.recruitment_candidate FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
--> statement-breakpoint

-- ── 5. Guards ──────────────────────────────────────────────────────────────────────────────────────────────
-- Settings (run as the caller): written by the current user; a row keeps its company and creation record.
CREATE FUNCTION app.recruitment_guard_candidate_email_setting() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Candidate e-mail settings are recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'Candidate e-mail settings keep their company and creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_email_setting() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_email_setting_guard BEFORE INSERT OR UPDATE ON public.recruitment_candidate_email_setting
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate_email_setting();
--> statement-breakpoint
-- Templates (run as the caller): written by the current user; placeholders from the kind's allowlist only; a row keeps its company,
-- kind, language and creation record.
CREATE FUNCTION app.recruitment_guard_candidate_email_template() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A candidate e-mail template is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.locale IS DISTINCT FROM OLD.locale
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A candidate e-mail template keeps its company, kind, language and creation record' USING ERRCODE = '23514';
 END IF;
 IF NOT app.recruitment_candidate_email_placeholders_ok(NEW.kind, NEW.subject) OR NOT app.recruitment_candidate_email_placeholders_ok(NEW.kind, NEW.body) THEN
  RAISE EXCEPTION 'A template may use only its kind''s placeholders' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_template_placeholders';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_email_template() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_email_template_guard BEFORE INSERT OR UPDATE ON public.recruitment_candidate_email_template
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate_email_template();
--> statement-breakpoint
-- The per-company hourly cap: e-mails queued in the last hour, counted under the company's cap lock (held to the end of the
-- transaction, so two transactions queueing for one company count one after the other). The counting itself is owner-only; the
-- granted wrapper answers the company's administrators and job teams (the guard runs as the person queueing) and nobody else.
CREATE FUNCTION app.recruitment_candidate_email_hour_count_owner(p_tenant uuid, p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE n integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-candidate-email-cap:' || p_tenant::text || ':' || p_company::text, 0));
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'count', p_company) ON CONFLICT DO NOTHING;
 SELECT count(*)::integer INTO n FROM public.recruitment_candidate_email e
  WHERE e.tenant_id = p_tenant AND e.company_id = p_company AND e.queued_at > now() - interval '1 hour';
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'count' AND scope_id = p_company;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_hour_count_owner(uuid, uuid) FROM PUBLIC, ai_hr_app;
CREATE FUNCTION app.recruitment_candidate_email_hour_count(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL
  OR NOT (app.can_admin_recruitment_for(p_company) OR app.recruitment_team_in_company(p_company))
  OR NOT EXISTS (SELECT 1 FROM public.company co WHERE co.id = p_company AND co.tenant_id = app.current_tenant_id()) THEN
  RAISE EXCEPTION 'Not available' USING ERRCODE = '42501';
 END IF;
 RETURN app.recruitment_candidate_email_hour_count_owner(app.current_tenant_id(), p_company);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_hour_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_hour_count(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Candidate e-mails (run as the caller; the owner reaches this table only through the definers above and below).
CREATE FUNCTION app.recruitment_guard_candidate_email() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE
 owner_call boolean := current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID));
BEGIN
 IF TG_OP = 'INSERT' THEN
  -- Row work is in-memory only; the set is checked once per statement (app.recruitment_check_candidate_email_queue, below).
  NEW.status := 'queued'; NEW.error_code := NULL; NEW.attempts := 0; NEW.queued_at := now(); NEW.lease_token := NULL; NEW.lease_until := NULL;
  NEW.started_at := NULL; NEW.completed_at := NULL; NEW.relay_revision := NULL; NEW.retried_at := NULL; NEW.retried_by_user_id := NULL;
  NEW.retry_count := 0; NEW.content_purged_at := NULL;
  IF NEW.kind <> 'rejection' OR NEW.next_attempt_at IS NULL OR NEW.next_attempt_at < now() THEN
   NEW.next_attempt_at := now();
  ELSIF NEW.next_attempt_at > now() + interval '3 days 1 minute' THEN
   RAISE EXCEPTION 'A rejection e-mail is sent at most three days later' USING ERRCODE = '23514';
  END IF;
  IF NOT owner_call AND (NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.queued_by_user_id IS NULL
   OR NEW.queued_by_user_id IS DISTINCT FROM app.current_user_id()) THEN
   RAISE EXCEPTION 'A candidate e-mail is queued by the current user' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 -- UPDATE: frozen columns never change; content only goes, all at once (the purge).
 IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.job_id, NEW.application_id, NEW.candidate_id, NEW.kind, NEW.locale, NEW.sender_name,
     NEW.reply_to, NEW.queued_at, NEW.queued_by_user_id)
  IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.company_id, OLD.job_id, OLD.application_id, OLD.candidate_id, OLD.kind, OLD.locale,
     OLD.sender_name, OLD.reply_to, OLD.queued_at, OLD.queued_by_user_id) THEN
  RAISE EXCEPTION 'A queued candidate e-mail is immutable' USING ERRCODE = '23514';
 END IF;
 IF (NEW.recipient, NEW.subject, NEW.body_text, NEW.body_html) IS DISTINCT FROM (OLD.recipient, OLD.subject, OLD.body_text, OLD.body_html)
  AND NOT (NEW.recipient IS NULL AND NEW.subject IS NULL AND NEW.body_text IS NULL AND NEW.body_html IS NULL AND NEW.content_purged_at IS NOT NULL) THEN
  RAISE EXCEPTION 'A queued candidate e-mail keeps its frozen content' USING ERRCODE = '23514';
 END IF;
 IF OLD.content_purged_at IS NOT NULL AND NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at THEN
  RAISE EXCEPTION 'A purged candidate e-mail stays purged' USING ERRCODE = '23514';
 END IF;
 IF owner_call THEN
  RETURN NEW;
 END IF;
 -- A person (an administrator, by policy) changes a row only to retry a failed or uncertain e-mail whose content is kept.
 IF OLD.status NOT IN ('failed','uncertain') OR NEW.status <> 'queued' OR OLD.content_purged_at IS NOT NULL OR NEW.content_purged_at IS NOT NULL
  OR NEW.retried_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only a failed or uncertain e-mail can be retried, by an administrator' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_retry';
 END IF;
 NEW.retried_at := now(); NEW.retry_count := OLD.retry_count + 1; NEW.attempts := 0; NEW.error_code := NULL; NEW.next_attempt_at := now();
 NEW.lease_token := NULL; NEW.lease_until := NULL; NEW.started_at := NULL; NEW.completed_at := NULL; NEW.relay_revision := NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_email() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_email_guard BEFORE INSERT OR UPDATE ON public.recruitment_candidate_email
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate_email();
--> statement-breakpoint
-- What a person queues, checked once per statement over the inserted set (a bulk archive inserts its e-mails in one statement): each
-- names its application, job, company and candidate; a rejection is for an application archived in THIS transaction
-- (state_changed_at = now(): 5201's guard stamps it on every state change) and a receipt for one created in it (applied_at = now());
-- the recipient is the candidate's recorded e-mail and the candidate is not removed; the company's switch is on and the sender name,
-- reply-to and language are its current settings; and the company has queued at most 500 e-mails in the last hour, these included
-- (counted under the company's cap lock, so concurrent queues count one after the other). Runs as the caller; the owner (tests and
-- maintenance only) is not checked.
CREATE FUNCTION app.recruitment_check_candidate_email_queue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)) THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM inserted n LEFT JOIN public.recruitment_application a ON a.id = n.application_id AND a.tenant_id = n.tenant_id
   WHERE a.id IS NULL OR a.job_id IS DISTINCT FROM n.job_id OR a.company_id IS DISTINCT FROM n.company_id OR a.candidate_id IS DISTINCT FROM n.candidate_id) THEN
  RAISE EXCEPTION 'A candidate e-mail names its application, job and candidate' USING ERRCODE = '23514';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n JOIN public.recruitment_application a ON a.id = n.application_id AND a.tenant_id = n.tenant_id
   WHERE (n.kind = 'rejection' AND (a.state <> 'archived' OR a.state_changed_at <> now()))
    OR (n.kind = 'application_received' AND (a.state <> 'active' OR a.applied_at <> now()))) THEN
  RAISE EXCEPTION 'A rejection e-mail is queued when the application is rejected, a receipt when it is created' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_state';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n LEFT JOIN public.recruitment_candidate c ON c.id = n.candidate_id AND c.tenant_id = n.tenant_id
   WHERE c.id IS NULL OR c.destroyed_at IS NOT NULL OR c.email IS NULL OR c.email IS DISTINCT FROM n.recipient) THEN
  RAISE EXCEPTION 'A candidate e-mail goes only to the candidate''s recorded e-mail' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_email_recipient';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n
   LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = n.company_id AND st.tenant_id = n.tenant_id
   LEFT JOIN public.company co ON co.id = n.company_id AND co.tenant_id = n.tenant_id
   WHERE st.enabled IS NOT TRUE OR n.reply_to IS DISTINCT FROM st.reply_to OR n.locale IS DISTINCT FROM st.locale
    OR n.sender_name IS DISTINCT FROM app.recruitment_candidate_email_sender(st.sender_name, co.legal_name)) THEN
  RAISE EXCEPTION 'Candidate e-mail is off for this company, or its sender settings changed' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_settings';
 END IF;
 IF EXISTS (SELECT 1 FROM (SELECT DISTINCT n.company_id FROM inserted n) x WHERE app.recruitment_candidate_email_hour_count(x.company_id) > 500) THEN
  RAISE EXCEPTION 'This company has queued 500 candidate e-mails in the last hour' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_hourly_limit';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_check_candidate_email_queue() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_email_queue_check AFTER INSERT ON public.recruitment_candidate_email
 REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION app.recruitment_check_candidate_email_queue();
--> statement-breakpoint

-- ── 6. The sweep (owner only: no EXECUTE for the app role) ─────────────────────────────────────────────────
-- Each takes a delivery id and its lease token, never an address or content. Called on the sweep's own connection with the tenant set
-- and no user (scripts/notification-email-sweep.ts → packs/recruitment/candidate-email-delivery.ts).
CREATE FUNCTION app.recruitment_candidate_email_worker_ok() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NULL;
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_worker_ok() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Lease up to p_limit due e-mails of the current tenant. Before that: a STARTED send whose lease ran out may or may not have reached
-- the relay, so it becomes 'uncertain' and is never sent again automatically; an UNSTARTED lease that ran out sent nothing and is
-- due again (its attempt is not counted).
CREATE FUNCTION app.recruitment_candidate_email_claim(p_limit integer) RETURNS TABLE (email_id uuid, token uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_tenant uuid := app.current_tenant_id();
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v_tenant) ON CONFLICT DO NOTHING;
 WITH expired AS (
  UPDATE public.recruitment_candidate_email e SET status = 'uncertain', error_code = 'uncertain', completed_at = now(),
   lease_token = NULL, lease_until = NULL
  WHERE e.tenant_id = v_tenant AND e.status = 'sending' AND e.lease_until <= now()
  RETURNING e.id, e.tenant_id, e.company_id, e.application_id, e.kind, e.attempts)
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  SELECT x.tenant_id, 'recruitment-application', x.application_id, 'recruitment-candidate-email.uncertain', 'system', NULL,
   jsonb_build_object('companyId', x.company_id, 'emailId', x.id, 'kind', x.kind, 'error', 'uncertain', 'attempts', x.attempts, 'reason', 'lease_expired')
  FROM expired x;
 UPDATE public.recruitment_candidate_email e SET status = CASE WHEN e.attempts > 1 THEN 'retry' ELSE 'queued' END,
  attempts = greatest(e.attempts - 1, 0), lease_token = NULL, lease_until = NULL
  WHERE e.tenant_id = v_tenant AND e.status = 'leased' AND e.started_at IS NULL AND e.lease_until <= now();
 RETURN QUERY
  UPDATE public.recruitment_candidate_email e SET status = 'leased', lease_token = gen_random_uuid(), lease_until = now() + interval '3 minutes',
   attempts = e.attempts + 1
  FROM (SELECT d.id FROM public.recruitment_candidate_email d
    WHERE d.tenant_id = v_tenant AND d.status IN ('queued','retry') AND d.next_attempt_at <= now()
    ORDER BY d.next_attempt_at, d.id LIMIT p_limit FOR UPDATE SKIP LOCKED) due
  WHERE e.id = due.id
  RETURNING e.id, e.lease_token;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_claim(integer) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The frozen content of a live, unstarted lease: {eligible: true, recipient, subject, text, html, senderName, replyTo}, or
-- {eligible: false} while the company's switch is off or when the frozen address is no longer the candidate's recorded e-mail (or the
-- candidate was removed), or NULL when the lease is no longer live.
CREATE FUNCTION app.recruitment_candidate_email_target(p_id uuid, p_token uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE e public.recruitment_candidate_email%ROWTYPE; v_enabled boolean; v_current boolean;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 SELECT * INTO e FROM public.recruitment_candidate_email x
  WHERE x.id = p_id AND x.lease_token = p_token AND x.status = 'leased' AND x.started_at IS NULL AND x.lease_until > clock_timestamp();
 IF e.id IS NOT NULL THEN
  SELECT s.enabled INTO v_enabled FROM public.recruitment_candidate_email_setting s WHERE s.company_id = e.company_id AND s.tenant_id = e.tenant_id;
  -- Still the candidate's recorded address, and the candidate not removed (a changed address is not sent to: not eligible).
  SELECT c.destroyed_at IS NULL AND c.email IS NOT DISTINCT FROM e.recipient INTO v_current FROM public.recruitment_candidate c
   WHERE c.id = e.candidate_id AND c.tenant_id = e.tenant_id;
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF e.id IS NULL THEN RETURN NULL; END IF;
 IF v_enabled IS NOT TRUE OR v_current IS NOT TRUE THEN RETURN jsonb_build_object('eligible', false); END IF;
 RETURN jsonb_build_object('eligible', true, 'recipient', e.recipient, 'subject', e.subject, 'text', e.body_text, 'html', e.body_html,
  'senderName', e.sender_name, 'replyTo', e.reply_to);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_target(uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- This statement commits before any SMTP byte is sent. It extends the lease to cover the send (5 minutes; the transport gives up after
-- 10 s to connect, 8 s for the greeting and 15 s of silence), so an overlapping sweep never turns an in-flight send into 'uncertain'. A
-- crash after it leaves 'sending' with a lease that runs out: 'uncertain'.
CREATE FUNCTION app.recruitment_candidate_email_start(p_id uuid, p_token uuid, p_relay_revision text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE n integer;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 IF p_relay_revision IS NULL OR p_relay_revision = '' OR char_length(p_relay_revision) > 120 THEN RETURN false; END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 UPDATE public.recruitment_candidate_email e SET status = 'sending', started_at = clock_timestamp(), relay_revision = p_relay_revision,
  lease_until = clock_timestamp() + interval '5 minutes'
  WHERE e.id = p_id AND e.lease_token = p_token AND e.status = 'leased' AND e.started_at IS NULL AND e.lease_until > clock_timestamp();
 GET DIAGNOSTICS n = ROW_COUNT;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_start(uuid, uuid, text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The receipt of one attempt. After a start: sent; retry (a temporary 4xx refusal: nothing was accepted, so it is sent again after
-- min(3600, 60·2^attempts) seconds, and after the fifth attempt it is failed); failed (5xx, authentication, TLS — or, before any SMTP
-- connection, an invalid message or a relay that could not be prepared: nothing was sent); uncertain (anything else: never sent again
-- automatically). Before a start: held (the relay is unavailable: due again in 5 minutes, the attempt not counted; after 7 days failed
-- as relay unavailable) or skipped (not eligible: failed). One domain event per outcome except held, without address or content.
CREATE FUNCTION app.recruitment_candidate_email_finish(p_id uuid, p_token uuid, p_outcome text, p_error text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE e public.recruitment_candidate_email%ROWTYPE; v_status text; v_error text := p_error;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('sent','retry','failed','uncertain','held','skipped')
  OR (p_outcome = 'sent' AND p_error IS NOT NULL)
  OR (p_outcome = 'retry' AND p_error IS DISTINCT FROM 'smtpTemporary')
  OR (p_outcome = 'failed' AND p_error NOT IN ('smtpRejected','smtpAuthentication','smtpTls','invalidMessage','relayPreparation'))
  OR (p_outcome = 'uncertain' AND p_error IS DISTINCT FROM 'uncertain')
  OR (p_outcome = 'held' AND p_error IS DISTINCT FROM 'relayUnavailable')
  OR (p_outcome = 'skipped' AND p_error IS DISTINCT FROM 'notEligible') THEN
  RETURN false;
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 SELECT * INTO e FROM public.recruitment_candidate_email x WHERE x.id = p_id AND x.lease_token = p_token FOR UPDATE;
 IF e.id IS NULL OR (p_outcome IN ('held','skipped') AND (e.status <> 'leased' OR e.started_at IS NOT NULL))
  OR (p_outcome NOT IN ('held','skipped') AND (e.status <> 'sending' OR e.started_at IS NULL)) THEN
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
  RETURN false;
 END IF;
 -- Held for at most 7 days since it was queued (or retried): then it fails as relay unavailable, final, so the purge applies.
 IF p_outcome = 'held' AND greatest(e.queued_at, coalesce(e.retried_at, e.queued_at)) < now() - interval '7 days' THEN
  p_outcome := 'failed';
 END IF;
 IF p_outcome = 'held' THEN
  UPDATE public.recruitment_candidate_email x SET status = CASE WHEN x.attempts > 1 THEN 'retry' ELSE 'queued' END,
   attempts = greatest(x.attempts - 1, 0), error_code = 'relayUnavailable', next_attempt_at = now() + interval '5 minutes',
   lease_token = NULL, lease_until = NULL
   WHERE x.id = e.id;
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
  RETURN true;
 END IF;
 v_status := CASE p_outcome WHEN 'skipped' THEN 'failed' WHEN 'retry' THEN CASE WHEN e.attempts >= 5 THEN 'failed' ELSE 'retry' END ELSE p_outcome END;
 UPDATE public.recruitment_candidate_email x SET status = v_status, error_code = v_error, lease_token = NULL, lease_until = NULL,
  started_at = CASE WHEN v_status = 'retry' THEN NULL ELSE x.started_at END,
  completed_at = CASE WHEN v_status = 'retry' THEN NULL ELSE clock_timestamp() END,
  next_attempt_at = CASE WHEN v_status = 'retry' THEN now() + make_interval(secs => least(3600, 60 * power(2, x.attempts))) ELSE x.next_attempt_at END
  WHERE x.id = e.id;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (e.tenant_id, 'recruitment-application', e.application_id, 'recruitment-candidate-email.' || v_status, 'system', NULL,
   jsonb_build_object('companyId', e.company_id, 'emailId', e.id, 'kind', e.kind, 'error', v_error, 'attempts', e.attempts));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_finish(uuid, uuid, text, text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The 90-day purge: the address and content of up to p_limit e-mails of the current tenant whose final state is more than 90 days
-- old go; kind, state, times, actor and attempts stay. A bounded, set-based step of the sweep.
CREATE FUNCTION app.recruitment_candidate_email_purge(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); n integer;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v_tenant) ON CONFLICT DO NOTHING;
 UPDATE public.recruitment_candidate_email e SET recipient = NULL, subject = NULL, body_text = NULL, body_html = NULL, content_purged_at = now()
  FROM (SELECT d.id FROM public.recruitment_candidate_email d
    WHERE d.tenant_id = v_tenant AND d.content_purged_at IS NULL AND d.status IN ('sent','failed','uncertain')
     AND d.completed_at < now() - interval '90 days'
    ORDER BY d.completed_at LIMIT p_limit FOR UPDATE SKIP LOCKED) old
  WHERE e.id = old.id;
 GET DIAGNOSTICS n = ROW_COUNT;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_purge(integer) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- ── 7. Removal: 5217's app.recruitment_destroy_candidate, byte for byte, plus the candidate's e-mails ───────────────────────
-- (The new step follows the slice 16 steps, before the candidate row is cleared.)
CREATE OR REPLACE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE c public.recruitment_candidate%ROWTYPE; v_apps uuid[]; v_offers uuid[]; n integer; result jsonb := '{}'::jsonb;
BEGIN
 IF p_candidate IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 -- Before anything else: no concurrent write to this candidate's record may interleave with the removal.
 PERFORM pg_advisory_xact_lock(app.recruitment_candidate_lock_key(app.current_tenant_id(), p_candidate));
 SELECT * INTO c FROM public.recruitment_candidate WHERE id = p_candidate AND tenant_id = app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(c.company_id) THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 IF c.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has already been removed' USING ERRCODE = '23514';
 END IF;
 SELECT coalesce(array_agg(a.id), '{}') INTO v_apps FROM public.recruitment_application a WHERE a.candidate_id = c.id AND a.tenant_id = c.tenant_id;
 IF EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = ANY (v_apps) AND a.state IN ('active','hired')) THEN
  RAISE EXCEPTION 'A candidate with an active or hired application keeps their record' USING ERRCODE = '23514';
 END IF;
 -- Slice 13: for a person with a blocked-list entry only (stable here: this removal holds the candidate's lock exclusively and
 -- adding an entry needs it), the company's blocked-list lock (after the candidate's: candidate, then company — the order
 -- every writer here takes), so matching never marks against an entry this removal is deleting, and this removal sees every
 -- mark committed before it. A listed person whose entry still holds an open mark on ANOTHER candidate's active application
 -- keeps their record until an administrator resolves that mark (no hold is lifted without a decision).
 IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
  PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(c.tenant_id, c.company_id));
  IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
    JOIN public.recruitment_application_review_mark m ON m.entry_id = e.id AND m.cleared_at IS NULL AND m.candidate_id <> c.id
    JOIN public.recruitment_application a ON a.id = m.application_id AND a.state = 'active'
    WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
   RAISE EXCEPTION 'Resolve the reviews this person''s blocked-list entry holds on other candidates first' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_blocked_entry_has_open_marks';
  END IF;
 END IF;
 SELECT coalesce(array_agg(o.id), '{}') INTO v_offers FROM public.recruitment_offer o WHERE o.application_id = ANY (v_apps) AND o.tenant_id = c.tenant_id;
 INSERT INTO app.recruitment_destroy_marker (txid, candidate_id, tenant_id) VALUES (txid_current(), c.id, c.tenant_id);

 -- Slice 10: agency submissions about this person lose their personal data — the one accepted onto this candidate, and those
 -- no candidate links (refused, rejected or still waiting) whose ONLY recorded match is this candidate as a Duplicate (the
 -- same ID number, or the same name with the same e-mail or mobile); one still waiting is closed as rejected. A submission
 -- that matched this candidate only as Suspected, or matched others too, is about someone else: it only loses its link.
 -- Indexed lookups only (by candidate, and the link table by candidate). Each row keeps job, contract, consultant, dates.
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL, personal_data_removed_at = now()
  WHERE s.candidate_id = c.id AND s.tenant_id = c.tenant_id AND s.personal_data_removed_at IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencySubmissions', n);
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL,
  outcome = CASE WHEN s.outcome = 'waiting' THEN 'rejected' ELSE s.outcome END, personal_data_removed_at = now()
  WHERE s.id IN (SELECT m.submission_id FROM app.recruitment_agency_submission_match m
    WHERE m.candidate_id = c.id AND m.tenant_id = c.tenant_id AND m.duplicate
     AND NOT EXISTS (SELECT 1 FROM app.recruitment_agency_submission_match o WHERE o.submission_id = m.submission_id AND o.candidate_id <> c.id))
   AND s.candidate_id IS NULL AND s.personal_data_removed_at IS NULL
   -- Two ID numbers that differ are two people, however alike name and contacts are: only the link goes.
   AND NOT EXISTS (SELECT 1 FROM public.recruitment_candidate_restricted r WHERE r.candidate_id = c.id AND r.tenant_id = c.tenant_id
    AND r.id_number IS NOT NULL AND s.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) <> app.recruitment_norm_id(s.id_number));
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencyMatchedSubmissions', n);
 DELETE FROM app.recruitment_agency_submission_match WHERE candidate_id = c.id;
 DELETE FROM public.recruitment_candidate_file WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('files', n);
 DELETE FROM public.recruitment_candidate_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('restricted', n);
 DELETE FROM public.recruitment_candidate_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('entries', n);
 DELETE FROM public.recruitment_candidate_tag WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('tags', n);
 DELETE FROM public.recruitment_candidate_consent WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('consents', n);
 -- Feedback: the 1–5 ratings stay (they carry no personal data); every note and the overview go.
 UPDATE public.recruitment_scorecard s SET overview = NULL,
  ratings = (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'notes' ELSE e.value END), '{}'::jsonb)
   FROM jsonb_each(s.ratings) e)
  WHERE s.application_id = ANY (v_apps) AND s.tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('scorecards', n);
 -- Offers: values and rejection comments go; the offer skeleton (status, rounds, decision) stays.
 DELETE FROM public.recruitment_offer_value WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('offerValues', n);
 UPDATE public.recruitment_offer SET last_rejection_comment = NULL
  WHERE id = ANY (v_offers) AND tenant_id = c.tenant_id AND last_rejection_comment IS NOT NULL;
 UPDATE public.recruitment_offer_approval SET comment = CASE WHEN decision = 'rejected' THEN '—' ELSE NULL END
  WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 -- The application keeps its skeleton; a free-text source (it may name a referrer) goes.
 UPDATE public.recruitment_application SET source = NULL WHERE id = ANY (v_apps) AND source IS NOT NULL;
 -- Slice 7: a referral keeps its job, date and referrer; the referrer's reason (it describes the candidate) goes.
 UPDATE public.recruitment_referral SET reason = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND reason IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('referrals', n);
 -- Slice 8: a careers application keeps its job and date; the applicant's message goes.
 UPDATE public.recruitment_careers_application SET message = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND message IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('careersMessages', n);
 -- Slice 11: screening notes and feedback comments go (they describe the candidate); each request keeps its reviewer, sender,
 -- times and closing, and each answer its result, reviewer and time. Indexed by application.
 UPDATE public.recruitment_screening_request SET note = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND note IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningNotes', n);
 UPDATE public.recruitment_screening_answer SET comment = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningComments', n);
 -- Slice 12: the person's OPEN background checks are cancelled by the system (a fixed code, so they no longer show as open
 -- or count as the recorder's to-dos); every check keeps its types, status, outcome and dates; the restricted details
 -- (provider, reference, authorisation, summary, cancellation reason) and every file (authorisation and report) go. Indexed
 -- by application.
 UPDATE public.recruitment_background_check SET status = 'cancelled', system_cancel_reason = 'candidate_removed',
  status_changed_by_user_id = app.current_user_id()
  WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND status IN ('awaiting_authorisation','in_progress');
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundChecksCancelled', n);
 DELETE FROM public.recruitment_background_check_file WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckFiles', n);
 DELETE FROM public.recruitment_background_check_detail WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckDetails', n);
 -- Slice 13: the person's pool memberships go (the remover administers the company, so the ordinary membership policy admits
 -- the delete). Their blocked-list entries go with the restricted values (reason, removal reason, identity values), the
 -- history, and every mark those entries made on anyone's application (such a mark has no basis once its entry is gone;
 -- marker-bound owner policies). A mark that SOMEONE ELSE's entry made on this person's applications stays (ids only).
 -- Indexed by candidate and by entry.
 DELETE FROM public.recruitment_talent_pool_member WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('poolMemberships', n);
 DELETE FROM public.recruitment_application_review_mark WHERE entry_id IN (SELECT e.id FROM public.recruitment_blocked_entry e
  WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedMarks', n);
 DELETE FROM public.recruitment_blocked_history WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedEntries', n);
 -- Slice 14: every custom value of the person goes, open and restricted (typed values of company-defined fields; the
 -- definitions are company setup and stay). Indexed by candidate. Marker-bound owner policies (and the remover administers
 -- the company).
 DELETE FROM public.recruitment_candidate_custom_value WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customValues', n);
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customRestrictedValues', n);
 -- Slice 16: the person's To assign marker (it holds the job title as written in their import file) and their import note go.
 -- Their import rows stay with ids, outcomes and codes only (no personal data). Indexed by candidate. Marker-bound owner policies.
 DELETE FROM public.recruitment_to_assign WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('toAssign', n);
 DELETE FROM public.recruitment_candidate_import_note WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('importNotes', n);
 -- Slice 19: the person's candidate e-mails go — queued, sent or failed, with their frozen address and content and the metadata (a
 -- queued, unsent rejection is withdrawn by this). Indexed by candidate. Marker-bound owner policies.
 DELETE FROM public.recruitment_candidate_email WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('candidateEmails', n);
 UPDATE public.recruitment_candidate SET
  full_name = 'Removed candidate ' || upper(substr(replace(c.id::text, '-', ''), 1, 8)), email = NULL, phone = NULL, location = NULL,
  current_company = NULL, current_title = NULL, highest_education = NULL, notice_period = NULL, source = NULL,
  destroyed_at = now(), destroyed_by_user_id = app.current_user_id(), updated_at = now(), updated_by_user_id = app.current_user_id()
  WHERE id = c.id;
 DELETE FROM app.recruitment_destroy_marker WHERE txid = txid_current() AND candidate_id = c.id;
 RETURN result || jsonb_build_object('applications', cardinality(v_apps), 'offers', cardinality(v_offers));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_destroy_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroy_candidate(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. Deleting a company (core/company-refs.ts): 5219's body plus the candidate e-mail tables ─────────────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_requisition WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
 DELETE FROM public.recruitment_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_tag_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_approval_step WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_offer_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_company_setting WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 8: the careers page and its privacy notice versions (a consent that names a version needs a candidate, which
 -- refuses the delete as retained history above).
 DELETE FROM public.recruitment_careers_site WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_careers_notice WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 18: interview set-up (company setup; no candidate data). Question links before the questions and the evaluation forms
 -- they name; group members (they also go with their group, ON DELETE CASCADE; listed so the count covers them) before the groups;
 -- rooms before their addresses (an interview naming either needs an application, whose job opening refuses the delete above).
 -- The administrator policies admit the owner here, as for the waiting rules.
 DELETE FROM public.recruitment_interview_question_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_question WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interviewer_group_member WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interviewer_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_room WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_interview_address WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 17: the waiting rules (company setup; no candidate data), before the stages they name. The administrator policy admits
 -- the owner here, as for the position templates.
 DELETE FROM public.recruitment_stage_waiting_rule WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 9: the users' read markers for the company's recruitment tasks (no candidate data).
 DELETE FROM public.recruitment_task_read_marker WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 10: the agency setup, children first. Assignments and submissions need a job opening, which refuses above. A
 -- contract's terms and listed users go with it (ON DELETE CASCADE). The administrator policies admit the owner here
 -- because the caller administers the company (app.is_admin_for implies app.can_admin_recruitment_for).
 DELETE FROM public.recruitment_agency_tag_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_consultant WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_contract WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 11: screening feedback, then the requests it answers. Both need an application, whose job opening refuses the delete
 -- above; they are listed so the remover covers every company table (owner-bound policies on the company being deleted).
 DELETE FROM public.recruitment_screening_answer WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_screening_request WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 12: background checks, children first (files, details, types of a check, checks), then the company's check types.
 -- Checks need an application, whose job opening refuses the delete above (owner-bound policies on the company being
 -- deleted); the types are company setup (the administrator policy admits the owner here, as for the agency tables).
 DELETE FROM public.recruitment_background_check_file WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_detail WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 13: the blocked list (history, marks, restricted values, entries — each needs a candidate, which refuses the delete
 -- above; listed so the remover covers every company table), then the pools: memberships (need a candidate too), shares,
 -- sub-pools, pools (real company setup). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_blocked_history WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_application_review_mark WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_blocked_entry WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_member WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool_share WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company AND parent_id IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_talent_pool WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 14: custom values (each needs a candidate or a job, which refuses the delete above; listed so the remover covers
 -- every company table; owner-bound policies on the company being deleted), then the options and the fields (company setup;
 -- the administrator policy admits the owner here, as for the check types). Options before their fields.
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_job_custom_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field_option WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_custom_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 15: position templates (company setup; a job opening made from one needs a job, which refuses the delete above).
 -- Their custom values first (they also go with the template, ON DELETE CASCADE; listed so the count covers them), then the
 -- templates. The administrator policy admits the owner here, as for the custom fields.
 DELETE FROM public.recruitment_position_template_value WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_position_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 16: the import notes and To assign markers (each needs a candidate, which refuses the delete above), the import rows and
 -- the imports (an import whose every row was refused names no candidate, so it can exist without one), then the export templates
 -- (company setup; the administrator policy admits the owner here). Owner-bound policies on the company being deleted.
 DELETE FROM public.recruitment_candidate_import_note WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_to_assign WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import_row WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_import WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_export_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 19: candidate e-mails (each needs an application, whose job opening refuses the delete above; listed so the remover covers
 -- every company table; owner-bound policies on the company being deleted), then the company's e-mail templates and sender settings
 -- (company setup; the administrator policies admit the owner here, as for the interview set-up).
 DELETE FROM public.recruitment_candidate_email WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_email_template WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_candidate_email_setting WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
