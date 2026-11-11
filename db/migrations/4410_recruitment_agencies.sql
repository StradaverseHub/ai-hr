-- Recruitment slice 10 (docs/recruitment-reconstruction/specification.md "Slice 10"): agencies and headhunters.
--
-- HR keeps agency companies, their contracts and consultants, releases jobs to contracts, and records agency submissions
-- ON THE AGENCY'S BEHALF. There is no agency login, platform, e-mail or invitation (D-036). A fee rate is stored and shown,
-- never calculated into an amount (D-037). A New submission is accepted at once; a Duplicate outside protection and a
-- Suspected one wait for an administrator; a Duplicate inside another channel's protection is refused and kept (D-038).
--
-- What this installs:
--   1. Seven tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none
--      to PUBLIC:
--        recruitment_agency_tag              the company's agency tags (administrators; a tag in use can be disabled, the
--                                            foreign key refuses deleting it);
--        recruitment_agency                  agency companies, name unique in the company;
--        recruitment_agency_tag_link         tags on agencies;
--        recruitment_agency_contract         contracts: name, type, status, period, HR contact, access, protection override;
--        recruitment_agency_contract_terms   the fee rate and the contract file — a SEPARATE table whose only policy admits
--                                            the company's recruitment administrators, so a recruiter's, hiring manager's or
--                                            interviewer's direct SELECT returns nothing (ON DELETE CASCADE part of a
--                                            contract);
--        recruitment_agency_contract_user    the users a Restricted contract is released to (ON DELETE CASCADE part);
--        recruitment_agency_consultant       consultants: contact records, not users; nothing is ever sent to them;
--      and two job-side tables:
--        recruitment_job_agency_contract     a contract assigned to a job, with requirements text for the agency;
--        recruitment_agency_submission       a submission HR recorded for an agency: what was typed (name, contacts, ID
--                                            number, salaries, comments, an optional resume while it waits), the outcome
--                                            and, once accepted, the candidate and application.
--   2. Row security: administrators of the company write the agency setup. The company's job operators (recruiter,
--      assistant: app.recruitment_operates_in_company) read the agencies, contracts and consultants released to them
--      (Public, or Restricted with them listed) — names and contacts only, never terms. A contract's HR contact reads it.
--      Assignments: read by the job's operators, written by administrators and the job's recruiter. Submissions: read and
--      recorded by the job's operators (administrators included); only administrators review them.
--   3. Guards (run as the caller): writers are the current user; companies, agencies, contracts and jobs never move; an
--      assignment and a submission need a contract USABLE TODAY (Enabled and today, the Kuala Lumpur date, within its
--      period) that is Public or lists the actor; a submission's consultant is Active and of that contract, its date is
--      not in the future nor before the contract start, and its outcome is the one the database computes again (below).
--      The HR contact is a user holding a recruitment administration role for the company.
--   4. app.recruitment_agency_submission_check (SECURITY DEFINER): the ONE cross-candidate read. For a job operator only,
--      it takes the job, the contract and the typed identity and returns the outcome — repeat, protected, duplicate,
--      suspected or new — and, for an administrator of the company only, the matched candidate ids. Nothing else leaves
--      it: no name, contact, job or application of any match. It locks on company + each normalised identity (the same
--      keys as 4407 and 4408, plus the ID number) so two submissions of the same person serialise, and it opens the
--      company's candidate rows to itself only through 4407's per-transaction context marker, which it writes and deletes.
--      Protection, counted on Kuala Lumpur dates from the protecting application's date: an application accepted from an
--      agency submission 365 days unless its contract overrides it; an employee referral the company's slice 7 period;
--      any other source 0. Archived and hired applications protect too until the period ends. The submitting agency's
--      own earlier applications never protect against it. Only for a contract assigned to the job and usable today by the
--      caller. Every call through the granted entry point counts as an attempt: at most 50 per recorder per Kuala Lumpur
--      date (app.recruitment_agency_attempt, private, kept two days). The submission guard (owner-run) re-runs the internal
--      variant and accepts a submission at once only with its own candidate and application, both created by the current
--      user in the same transaction (created_at / applied_at = now()), with the typed identity.
--      Private tables: app.recruitment_agency_submission_match (the candidates a refused or waiting submission matched, and
--      whether as a Duplicate), app.recruitment_agency_attempt and app.recruitment_agency_clear_marker; no grant to anybody.
--   5. app.recruitment_application_agency: the agency behind an application for its readers — the agency name; the
--      contract, consultant, submission date and comments for the job's operators and administrators only.
--   6. app.recruitment_destroy_candidate restated (4408 body byte for byte) plus one step: the submission accepted onto the
--      person, and those whose only recorded match is the person as a Duplicate (and whose ID number, when both have one, is
--      the person's), lose their personal data (indexed lookups); other submissions only lose the link. app.recruitment_clear_agency_submission: an administrator clears a refused or
--      rejected submission (the Privacy due list). app.recruitment_delete_company_setup restated (4409 body byte for byte)
--      plus the agency setup tables.
--
-- Nothing here calls a model, scores a candidate, sends a message or calculates a fee.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_agency_tag (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_tag_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_tag_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_tag_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_tag_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_agency_tag_name_uq ON public.recruitment_agency_tag (tenant_id, company_id, lower(btrim(name)));
--> statement-breakpoint
CREATE TABLE public.recruitment_agency (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_agency_name_uq ON public.recruitment_agency (tenant_id, company_id, lower(btrim(name)));
--> statement-breakpoint
CREATE TABLE public.recruitment_agency_tag_link (
 agency_id uuid NOT NULL,
 tag_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_tag_link_pk PRIMARY KEY (agency_id, tag_id),
 CONSTRAINT recruitment_agency_tag_link_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_tag_link_agency_fk FOREIGN KEY (agency_id, company_id, tenant_id) REFERENCES public.recruitment_agency(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_tag_link_tag_fk FOREIGN KEY (tag_id, company_id, tenant_id) REFERENCES public.recruitment_agency_tag(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_tag_link_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_agency_tag_link_tag_idx ON public.recruitment_agency_tag_link (tag_id);
CREATE INDEX recruitment_agency_tag_link_company_idx ON public.recruitment_agency_tag_link (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_agency_contract (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 agency_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
 contract_type text NOT NULL CHECK (contract_type IN ('headhunter','rpo')),
 status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
 starts_on date NOT NULL,
 ends_on date NOT NULL,
 hr_contact_user_id uuid NOT NULL,
 access text NOT NULL DEFAULT 'public' CHECK (access IN ('public','restricted')),
 -- Days an application accepted from this contract protects the agency's credit; NULL = the default 365.
 protection_days integer CHECK (protection_days IS NULL OR protection_days BETWEEN 0 AND 730),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_contract_period_ck CHECK (ends_on >= starts_on),
 CONSTRAINT recruitment_agency_contract_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_contract_agency_fk FOREIGN KEY (agency_id, company_id, tenant_id) REFERENCES public.recruitment_agency(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_contract_contact_fk FOREIGN KEY (hr_contact_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_contract_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_contract_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_contract_scope_uq UNIQUE (id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_contract_agency_scope_uq UNIQUE (id, agency_id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_agency_contract_name_uq ON public.recruitment_agency_contract (agency_id, lower(btrim(name)));
CREATE INDEX recruitment_agency_contract_company_idx ON public.recruitment_agency_contract (tenant_id, company_id);
-- The expiry to-do starts from the viewer: their Enabled contracts as HR contact, by end date.
CREATE INDEX recruitment_agency_contract_contact_idx ON public.recruitment_agency_contract (tenant_id, hr_contact_user_id, ends_on) WHERE status = 'enabled';
--> statement-breakpoint
-- Fee rate (percent, two decimals; shown, never calculated into an amount, D-037) and the contract file (optional PDF,
-- slice 5 size rule). Administrators only, by row security: no other policy exists on this table.
CREATE TABLE public.recruitment_agency_contract_terms (
 contract_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 fee_rate numeric(5,2) NOT NULL CHECK (fee_rate BETWEEN 0 AND 100),
 file_name text CHECK (file_name IS NULL OR char_length(btrim(file_name)) BETWEEN 1 AND 200),
 file_mime text CHECK (file_mime IS NULL OR file_mime = 'application/pdf'),
 file_size integer CHECK (file_size IS NULL OR file_size BETWEEN 1 AND 10485760),
 file_content bytea,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_contract_terms_file_ck CHECK (num_nulls(file_name, file_mime, file_size, file_content) IN (0, 4)
  AND (file_content IS NULL OR octet_length(file_content) = file_size)),
 CONSTRAINT recruitment_agency_contract_terms_contract_fk FOREIGN KEY (contract_id, company_id, tenant_id)
  REFERENCES public.recruitment_agency_contract(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_agency_contract_terms_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
--> statement-breakpoint
CREATE TABLE public.recruitment_agency_contract_user (
 contract_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_contract_user_pk PRIMARY KEY (contract_id, app_user_id),
 CONSTRAINT recruitment_agency_contract_user_contract_fk FOREIGN KEY (contract_id, company_id, tenant_id)
  REFERENCES public.recruitment_agency_contract(id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_agency_contract_user_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_contract_user_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_agency_contract_user_user_idx ON public.recruitment_agency_contract_user (app_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_agency_consultant (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 contract_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
 email text CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$')),
 mobile text CHECK (mobile IS NULL OR char_length(btrim(mobile)) BETWEEN 1 AND 40),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_agency_consultant_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_consultant_contract_fk FOREIGN KEY (contract_id, company_id, tenant_id) REFERENCES public.recruitment_agency_contract(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_consultant_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_consultant_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_consultant_scope_uq UNIQUE (id, contract_id, company_id, tenant_id)
);
CREATE INDEX recruitment_agency_consultant_contract_idx ON public.recruitment_agency_consultant (contract_id);
CREATE INDEX recruitment_agency_consultant_company_idx ON public.recruitment_agency_consultant (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_job_agency_contract (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 contract_id uuid NOT NULL,
 requirements text CHECK (requirements IS NULL OR char_length(btrim(requirements)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_job_agency_contract_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_job_agency_contract_contract_fk FOREIGN KEY (contract_id, company_id, tenant_id) REFERENCES public.recruitment_agency_contract(id, company_id, tenant_id),
 CONSTRAINT recruitment_job_agency_contract_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_agency_contract_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_job_agency_contract_uq UNIQUE (job_id, contract_id)
);
CREATE INDEX recruitment_job_agency_contract_contract_idx ON public.recruitment_job_agency_contract (contract_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_agency_submission (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 contract_id uuid NOT NULL,
 agency_id uuid NOT NULL,
 consultant_id uuid NOT NULL,
 submitted_on date NOT NULL,
 -- What HR typed for the agency. Cleared (NULL) only by the slice 5 removal (personal_data_removed_at).
 full_name text CHECK (full_name IS NULL OR char_length(btrim(full_name)) BETWEEN 1 AND 200),
 email text CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$')),
 mobile text CHECK (mobile IS NULL OR char_length(btrim(mobile)) BETWEEN 1 AND 40),
 id_type text CHECK (id_type IN ('nric','passport')),
 id_number text CHECK (id_number IS NULL OR char_length(btrim(id_number)) BETWEEN 1 AND 40),
 current_salary_amount numeric(18,2) CHECK (current_salary_amount IS NULL OR current_salary_amount >= 0),
 current_salary_currency text CHECK (current_salary_currency IS NULL OR current_salary_currency ~ '^[A-Z]{3}$'),
 expected_salary_amount numeric(18,2) CHECK (expected_salary_amount IS NULL OR expected_salary_amount >= 0),
 expected_salary_currency text CHECK (expected_salary_currency IS NULL OR expected_salary_currency ~ '^[A-Z]{3}$'),
 comments text CHECK (comments IS NULL OR char_length(btrim(comments)) BETWEEN 1 AND 2000),
 -- A resume kept only while the submission waits for review; moved to the candidate's files on acceptance.
 resume_name text CHECK (resume_name IS NULL OR char_length(btrim(resume_name)) BETWEEN 1 AND 200),
 resume_mime text CHECK (resume_mime IS NULL OR resume_mime IN ('application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png')),
 resume_size integer CHECK (resume_size IS NULL OR resume_size BETWEEN 1 AND 10485760),
 resume_content bytea,
 match_kind text NOT NULL CHECK (match_kind IN ('new','duplicate','suspected')),
 outcome text NOT NULL CHECK (outcome IN ('accepted','refused','waiting','rejected')),
 refusal_reason text CHECK (refusal_reason IS NULL OR refusal_reason = 'protected'),
 review_reason text CHECK (review_reason IS NULL OR char_length(btrim(review_reason)) BETWEEN 1 AND 1000),
 candidate_id uuid,
 application_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 decided_at timestamptz,
 decided_by_user_id uuid,
 personal_data_removed_at timestamptz,
 CONSTRAINT recruitment_agency_submission_person_ck CHECK (personal_data_removed_at IS NOT NULL
  OR (full_name IS NOT NULL AND (email IS NOT NULL OR mobile IS NOT NULL))),
 CONSTRAINT recruitment_agency_submission_id_ck CHECK ((id_number IS NULL) = (id_type IS NULL)),
 CONSTRAINT recruitment_agency_submission_current_ck CHECK ((current_salary_amount IS NULL) = (current_salary_currency IS NULL)),
 CONSTRAINT recruitment_agency_submission_expected_ck CHECK ((expected_salary_amount IS NULL) = (expected_salary_currency IS NULL)),
 CONSTRAINT recruitment_agency_submission_resume_ck CHECK (num_nulls(resume_name, resume_mime, resume_size, resume_content) IN (0, 4)
  AND (resume_content IS NULL OR octet_length(resume_content) = resume_size)),
 CONSTRAINT recruitment_agency_submission_outcome_ck CHECK (
  (outcome = 'accepted' AND candidate_id IS NOT NULL AND application_id IS NOT NULL AND refusal_reason IS NULL AND decided_at IS NOT NULL)
  OR (outcome = 'refused' AND candidate_id IS NULL AND application_id IS NULL AND refusal_reason IS NOT NULL AND match_kind = 'duplicate' AND decided_at IS NOT NULL)
  OR (outcome = 'waiting' AND candidate_id IS NULL AND application_id IS NULL AND refusal_reason IS NULL AND match_kind <> 'new' AND decided_at IS NULL)
  OR (outcome = 'rejected' AND candidate_id IS NULL AND application_id IS NULL AND refusal_reason IS NULL AND match_kind <> 'new' AND decided_at IS NOT NULL
   AND (review_reason IS NOT NULL OR personal_data_removed_at IS NOT NULL))),
 CONSTRAINT recruitment_agency_submission_decided_ck CHECK ((decided_at IS NULL) = (decided_by_user_id IS NULL)),
 CONSTRAINT recruitment_agency_submission_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_submission_contract_fk FOREIGN KEY (contract_id, agency_id, company_id, tenant_id)
  REFERENCES public.recruitment_agency_contract(id, agency_id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_submission_consultant_fk FOREIGN KEY (consultant_id, contract_id, company_id, tenant_id)
  REFERENCES public.recruitment_agency_consultant(id, contract_id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_submission_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_submission_application_fk FOREIGN KEY (application_id, company_id, tenant_id) REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_submission_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_submission_decided_by_fk FOREIGN KEY (decided_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_agency_submission_application_uq ON public.recruitment_agency_submission (application_id) WHERE application_id IS NOT NULL;
-- The repeat rule reads the agency's earlier submissions to the job.
CREATE INDEX recruitment_agency_submission_job_agency_idx ON public.recruitment_agency_submission (job_id, agency_id);
CREATE INDEX recruitment_agency_submission_contract_idx ON public.recruitment_agency_submission (contract_id, job_id);
CREATE INDEX recruitment_agency_submission_consultant_idx ON public.recruitment_agency_submission (consultant_id);
CREATE INDEX recruitment_agency_submission_candidate_idx ON public.recruitment_agency_submission (candidate_id) WHERE candidate_id IS NOT NULL;
-- The administrators' review list and their personal to-dos: waiting submissions of a company, oldest first.
CREATE INDEX recruitment_agency_submission_waiting_idx ON public.recruitment_agency_submission (tenant_id, company_id, created_at) WHERE outcome = 'waiting';
-- The Applications updates: accepted submissions per job, newest first.
CREATE INDEX recruitment_agency_submission_accepted_idx ON public.recruitment_agency_submission (job_id, decided_at) WHERE outcome = 'accepted';
-- The slice 5 removal finds the unlinked submissions about a person by each normalised identity.
CREATE INDEX recruitment_agency_submission_email_norm_idx ON public.recruitment_agency_submission (tenant_id, company_id, app.recruitment_norm_email(email))
 WHERE email IS NOT NULL;
CREATE INDEX recruitment_agency_submission_mobile_norm_idx ON public.recruitment_agency_submission (tenant_id, company_id, app.recruitment_norm_mobile(mobile))
 WHERE mobile IS NOT NULL;
CREATE INDEX recruitment_agency_submission_id_norm_idx ON public.recruitment_agency_submission (tenant_id, company_id, app.recruitment_norm_id(id_number))
 WHERE id_number IS NOT NULL;
-- The Privacy due list: decided submissions (refused or rejected) whose personal data is still held, oldest decision first.
CREATE INDEX recruitment_agency_submission_decided_idx ON public.recruitment_agency_submission (tenant_id, company_id, decided_at)
 WHERE outcome IN ('refused','rejected') AND personal_data_removed_at IS NULL;
--> statement-breakpoint
-- The candidates a refused or waiting submission matched when it was recorded (the check's own answer; `duplicate` = the
-- same ID number, or the same name with the same e-mail or mobile; otherwise Suspected). The slice 5 removal of a candidate
-- clears a submission only when that candidate is its SOLE match and a Duplicate one; otherwise it only drops the link.
-- Private: written by the owner-run link trigger, read by the owner-run removal; no grant to the app role or PUBLIC.
CREATE TABLE app.recruitment_agency_submission_match (
 submission_id uuid NOT NULL REFERENCES public.recruitment_agency_submission(id),
 candidate_id uuid NOT NULL REFERENCES public.recruitment_candidate(id),
 tenant_id uuid NOT NULL,
 duplicate boolean NOT NULL,
 PRIMARY KEY (submission_id, candidate_id)
);
CREATE INDEX recruitment_agency_submission_match_candidate_idx ON app.recruitment_agency_submission_match (candidate_id);
ALTER TABLE app.recruitment_agency_submission_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_agency_submission_match FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_agency_submission_match FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_agency_submission_match_owner ON app.recruitment_agency_submission_match FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_submission_match'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_submission_match'::regclass)));
--> statement-breakpoint
-- Every agency submission ATTEMPT by a recorder (stored, refused, repeated or over the limit), for the daily cap of 50 per
-- Kuala Lumpur date: capping attempts bounds probing for whether someone is already a candidate. Kept two days; outcome
-- only, no candidate data; private like 4407's referral attempts.
CREATE TABLE app.recruitment_agency_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 attempted_at timestamptz NOT NULL DEFAULT now(),
 outcome text NOT NULL CHECK (outcome IN ('repeat','protected','duplicate','suspected','new','limit'))
);
CREATE INDEX recruitment_agency_attempt_user_idx ON app.recruitment_agency_attempt (tenant_id, app_user_id, attempted_at);
ALTER TABLE app.recruitment_agency_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_agency_attempt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_agency_attempt FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_agency_attempt_owner ON app.recruitment_agency_attempt FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_attempt'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_attempt'::regclass)));
--> statement-breakpoint
-- The clearing marker: one row per (transaction, submission) while app.recruitment_clear_agency_submission runs, deleted
-- before it returns. Like 4405's destroy marker: no grant to anybody, so only that function can open the guard's
-- clear-only branch for a decided submission.
CREATE TABLE app.recruitment_agency_clear_marker (
 txid bigint NOT NULL,
 submission_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (txid, submission_id)
);
ALTER TABLE app.recruitment_agency_clear_marker ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_agency_clear_marker FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_agency_clear_marker FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_agency_clear_marker_owner ON app.recruitment_agency_clear_marker FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_clear_marker'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_agency_clear_marker'::regclass)));
--> statement-breakpoint

-- ── 2. Row security and grants ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_agency_tag','recruitment_agency','recruitment_agency_tag_link','recruitment_agency_contract',
  'recruitment_agency_contract_terms','recruitment_agency_contract_user','recruitment_agency_consultant','recruitment_job_agency_contract',
  'recruitment_agency_submission'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
 -- The agency setup: the company's recruitment administrators, for everything. The policies name no role, so they bind
 -- the table owner too (FORCE): the company setup delete below answers to exactly the caller's administration.
 FOREACH t IN ARRAY ARRAY['recruitment_agency_tag','recruitment_agency','recruitment_agency_tag_link','recruitment_agency_contract',
  'recruitment_agency_contract_terms','recruitment_agency_contract_user','recruitment_agency_consultant'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL
   USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
   WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))', t || '_admin', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- A Restricted contract's own listing: each listed user reads their own row (so the contract predicate below can see it).
CREATE POLICY recruitment_agency_contract_user_self ON public.recruitment_agency_contract_user FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
-- Contracts released to the company's job operators: Public, or Restricted with them listed. (The HR contact reads a
-- contract only while administering the company — through the administrator policy, so a demoted contact loses it.)
-- Never the terms: those live in recruitment_agency_contract_terms, administrators only.
CREATE POLICY recruitment_agency_contract_released ON public.recruitment_agency_contract FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id)
  AND (access = 'public' OR EXISTS (SELECT 1 FROM public.recruitment_agency_contract_user u
   WHERE u.contract_id = recruitment_agency_contract.id AND u.tenant_id = recruitment_agency_contract.tenant_id AND u.app_user_id = app.current_user_id())));
-- An agency and a consultant are read with a contract the caller may read.
CREATE POLICY recruitment_agency_released ON public.recruitment_agency FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_agency_contract c
  WHERE c.agency_id = recruitment_agency.id AND c.tenant_id = recruitment_agency.tenant_id));
CREATE POLICY recruitment_agency_consultant_released ON public.recruitment_agency_consultant FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_agency_contract c
  WHERE c.id = recruitment_agency_consultant.contract_id AND c.tenant_id = recruitment_agency_consultant.tenant_id));
-- Assignments: the job's operators read them; administrators and the job's recruiter assign, edit and remove them.
CREATE POLICY recruitment_job_agency_contract_read ON public.recruitment_job_agency_contract FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_job_agency_contract_write ON public.recruitment_job_agency_contract FOR ALL
 USING (tenant_id = app.current_tenant_id() AND (app.can_admin_recruitment_for(company_id) OR app.recruitment_has_job_role(job_id, ARRAY['recruiter'])))
 WITH CHECK (tenant_id = app.current_tenant_id() AND (app.can_admin_recruitment_for(company_id) OR app.recruitment_has_job_role(job_id, ARRAY['recruiter'])));
-- Submissions: the job's operators (administrators included) read and record them; administrators review them.
CREATE POLICY recruitment_agency_submission_read ON public.recruitment_agency_submission FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_agency_submission_insert ON public.recruitment_agency_submission FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_agency_submission_review ON public.recruitment_agency_submission FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
--> statement-breakpoint
-- The owner-run functions below (the submission check and the application's agency) read across the company only for a
-- company whose 4407 context marker THIS transaction holds, which only owner-run definer functions write. The app role never
-- satisfies these (current_user is ai_hr_app, never the owner). No policy below reads a table whose policy reads it back.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_agency','recruitment_agency_contract','recruitment_agency_consultant','recruitment_agency_submission'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_referral_open(company_id))', t || '_context_read', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_agency_tag TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE ON public.recruitment_agency, public.recruitment_agency_contract, public.recruitment_agency_contract_terms,
 public.recruitment_agency_consultant TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_agency_tag_link, public.recruitment_agency_contract_user TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_job_agency_contract TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE ON public.recruitment_agency_submission TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Predicates ─────────────────────────────────────────────────────────────────────────────────────────
-- Does `p_user` hold a recruitment administration role covering `p_company` (HR administrator, super administrator or
-- Recruiting Partner, group-wide, on the company or on an ancestor)? Read from the user's role assignments with the same
-- grant rule the session uses. Answers a boolean only, and only to a caller who administers the company (anybody else gets
-- false); the HR contact must be such a user.
CREATE FUNCTION app.recruitment_user_administers(p_company uuid, p_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT p_company IS NOT NULL AND p_user IS NOT NULL AND app.current_tenant_id() IS NOT NULL AND app.can_admin_recruitment_for(p_company)
  AND EXISTS (SELECT 1 FROM public.app_user u WHERE u.id = p_user AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL)
  AND coalesce((SELECT app.grants_have_role_for(x.g, 'hr_admin', p_company) OR app.grants_have_role_for(x.g, 'super_admin', p_company)
    OR app.grants_have_role_for(x.g, 'recruiting_partner', p_company)
   FROM (SELECT jsonb_agg(jsonb_build_object('role', r.role::text, 'companyId', r.company_id)) AS g FROM public.role_assignment r
    WHERE r.tenant_id = app.current_tenant_id() AND r.app_user_id = p_user) x), false);
$$;
REVOKE ALL ON FUNCTION app.recruitment_user_administers(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_user_administers(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
-- The administration users of a company, as the HR contact picker offers them: id and name only, for an administrator.
CREATE FUNCTION app.recruitment_admin_contacts(p_company uuid) RETURNS TABLE(app_user_id uuid, full_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT u.id, p.full_name::text FROM public.app_user u JOIN public.person p ON p.id = u.person_id AND p.tenant_id = u.tenant_id
 WHERE u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL AND app.can_admin_recruitment_for(p_company)
  AND EXISTS (SELECT 1 FROM public.role_assignment r WHERE r.tenant_id = u.tenant_id AND r.app_user_id = u.id
   AND r.role::text IN ('hr_admin','super_admin','recruiting_partner'))
  AND app.recruitment_user_administers(p_company, u.id)
 ORDER BY p.full_name, u.id;
$$;
REVOKE ALL ON FUNCTION app.recruitment_admin_contacts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_admin_contacts(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Is the contract usable by the CALLER today (Kuala Lumpur date): Enabled, today within its period, and Public or listing
-- the caller? Run as the caller: an unreleased contract is invisible and answers false.
CREATE FUNCTION app.recruitment_contract_usable(p_contract uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_agency_contract c
  WHERE c.id = p_contract AND c.tenant_id = app.current_tenant_id() AND c.status = 'enabled'
   AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN c.starts_on AND c.ends_on
   AND (c.access = 'public' OR EXISTS (SELECT 1 FROM public.recruitment_agency_contract_user u
    WHERE u.contract_id = c.id AND u.tenant_id = c.tenant_id AND u.app_user_id = app.current_user_id())));
$$;
GRANT EXECUTE ON FUNCTION app.recruitment_contract_usable(uuid) TO ai_hr_app;
--> statement-breakpoint
-- True while app.recruitment_destroy_candidate runs in THIS transaction for this tenant (its marker, 4405). The removal
-- clears submissions about the person that no candidate row links (refused, rejected or waiting ones).
CREATE FUNCTION app.recruitment_destroying_in(p_tenant uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_tenant IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_destroy_marker m WHERE m.txid = txid_current_if_assigned() AND m.tenant_id = p_tenant);
$$;
REVOKE ALL ON FUNCTION app.recruitment_destroying_in(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroying_in(uuid) TO ai_hr_app;
--> statement-breakpoint
-- True only while app.recruitment_clear_agency_submission is clearing THIS submission in THIS transaction.
CREATE FUNCTION app.recruitment_agency_clearing(p_submission uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_submission IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_agency_clear_marker m
  WHERE m.txid = txid_current_if_assigned() AND m.submission_id = p_submission);
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_clearing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_clearing(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The live candidates of a company with an application that a typed identity matches: `duplicate` for the same ID number,
-- or the same name with the same e-mail or mobile; otherwise (two of name, e-mail and mobile) Suspected. Indexed equality
-- lookups only (slice 5's expression indexes). INTERNAL: not executable by the app role or PUBLIC; only the owner-run check
-- and link trigger call it, inside the company's context marker.
CREATE FUNCTION app.recruitment_agency_matches(p_tenant uuid, p_company uuid, p_full_name text, p_email text, p_mobile text, p_id_number text,
 p_exclude uuid) RETURNS TABLE(candidate_id uuid, duplicate boolean)
 LANGUAGE sql STABLE SET search_path = pg_catalog, public, app, pg_temp AS $$
 WITH v AS (SELECT app.recruitment_norm_name(p_full_name) AS name, app.recruitment_norm_email(p_email) AS email,
   app.recruitment_norm_mobile(p_mobile) AS mobile, app.recruitment_norm_id(p_id_number) AS id),
 hits AS (
  SELECT r.candidate_id, 'id'::text AS kind FROM public.recruitment_candidate_restricted r, v
   WHERE v.id IS NOT NULL AND r.tenant_id = p_tenant AND r.company_id = p_company AND r.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) = v.id
  UNION ALL
  SELECT c.id, 'email' FROM public.recruitment_candidate c, v
   WHERE v.email IS NOT NULL AND c.tenant_id = p_tenant AND c.company_id = p_company AND c.email IS NOT NULL AND app.recruitment_norm_email(c.email) = v.email
  UNION ALL
  SELECT c.id, 'name' FROM public.recruitment_candidate c, v
   WHERE v.name IS NOT NULL AND c.tenant_id = p_tenant AND c.company_id = p_company AND app.recruitment_norm_name(c.full_name) = v.name
  UNION ALL
  SELECT c.id, 'mobile' FROM public.recruitment_candidate c, v
   WHERE v.mobile IS NOT NULL AND c.tenant_id = p_tenant AND c.company_id = p_company AND c.phone IS NOT NULL AND app.recruitment_norm_mobile(c.phone) = v.mobile
 ), per AS (
  SELECT h.candidate_id, bool_or(h.kind = 'id') AS by_id, bool_or(h.kind = 'name') AS by_name,
   bool_or(h.kind IN ('email','mobile')) AS by_contact, count(DISTINCT h.kind) AS n
  FROM hits h JOIN public.recruitment_candidate x ON x.id = h.candidate_id AND x.destroyed_at IS NULL AND x.id IS DISTINCT FROM p_exclude
  WHERE EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.candidate_id = h.candidate_id AND a.tenant_id = p_tenant)
  GROUP BY h.candidate_id
 )
 SELECT p.candidate_id, (p.by_id OR (p.by_name AND p.by_contact)) FROM per p
 WHERE p.by_id OR (p.by_name AND p.by_contact) OR p.n >= 2;
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_matches(uuid, uuid, text, text, text, text, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- ── 4. The duplicate and protection check ──────────────────────────────────────────────────────────────────
-- Returns (outcome, match_ids). outcome:
--   limit     — (only with p_attempt) the caller has made 50 agency submission attempts on today's Kuala Lumpur date;
--   repeat    — the same agency already submitted this person (slice 5 rule: ID number, or two of name, e-mail and mobile)
--               to this job and that submission is waiting, or accepted with its application active or closed within the
--               company's repeated-application window (Kuala Lumpur calendar months);
--   protected — a Duplicate whose live candidate has an application inside another channel's protection period;
--   duplicate — the same ID number, or the same name plus the same e-mail, or the same name plus the same mobile, as a live
--               candidate of the company with an application; not protected;
--   suspected — any two of name, e-mail and mobile match a live candidate with an application, but not as above;
--   new       — neither.
-- match_ids: the matched candidates (duplicates first), ONLY for a recruitment administrator of the job's company; NULL for
-- everybody else, who learn only the outcome (as slice 5's count).
-- Only for an operator of the job, from a contract assigned to the job and usable today by the caller. p_exclude leaves one
-- candidate out: the submission guard passes it only after proving that candidate and its application were created by the
-- caller in THIS transaction (created_at and applied_at equal now(), which no later UPDATE can change) with this one
-- application and the typed identity. p_attempt counts the attempt against the caller's daily cap and logs it.
-- INTERNAL (app.recruitment_agency_check): not executable by the app role. The app role reaches it only through
-- app.recruitment_agency_submission_check below, which always counts the attempt, or through the submission guard's re-check.
CREATE FUNCTION app.recruitment_agency_check(p_job uuid, p_contract uuid, p_full_name text, p_email text, p_mobile text,
 p_id_number text, p_exclude uuid, p_attempt boolean)
RETURNS TABLE(outcome text, match_ids uuid[])
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '5s' AS $$
DECLARE
 v_tenant uuid := app.current_tenant_id(); v_user uuid := app.current_user_id();
 v_name text := app.recruitment_norm_name(p_full_name); v_email text := app.recruitment_norm_email(p_email);
 v_mobile text := app.recruitment_norm_mobile(p_mobile); v_id text := app.recruitment_norm_id(p_id_number);
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 v_company uuid; v_agency uuid; v_months integer; v_referral_days integer; v_key bigint; v_dup uuid[]; v_sus uuid[]; v_outcome text;
 v_attempts integer;
BEGIN
 IF v_tenant IS NULL OR v_user IS NULL OR p_job IS NULL OR p_contract IS NULL THEN
  RAISE EXCEPTION 'Checking an agency submission needs the job''s recruiter or assistant' USING ERRCODE = '42501';
 END IF;
 -- Read as the owner under FORCE row security with the caller's own context: found only when the caller may read the job.
 SELECT j.company_id INTO v_company FROM public.recruitment_job_opening j WHERE j.id = p_job AND j.tenant_id = v_tenant;
 IF v_company IS NULL OR NOT app.can_operate_recruitment_job(v_company, p_job) THEN
  RAISE EXCEPTION 'Checking an agency submission needs the job''s recruiter or assistant' USING ERRCODE = '42501';
 END IF;
 IF v_name IS NULL OR (v_email IS NULL AND v_mobile IS NULL) THEN
  RAISE EXCEPTION 'An agency submission needs a name and an e-mail or mobile' USING ERRCODE = '22023';
 END IF;
 -- The contract: of the job's company, assigned to the job and usable today by the caller (read with the caller's own
 -- access, before any context marker opens the company).
 SELECT c.agency_id INTO v_agency FROM public.recruitment_agency_contract c WHERE c.id = p_contract AND c.tenant_id = v_tenant AND c.company_id = v_company;
 IF v_agency IS NULL OR NOT app.recruitment_contract_usable(p_contract)
  OR NOT EXISTS (SELECT 1 FROM public.recruitment_job_agency_contract x WHERE x.job_id = p_job AND x.contract_id = p_contract AND x.tenant_id = v_tenant) THEN
  RAISE EXCEPTION 'The contract is not assigned to the job or not usable today' USING ERRCODE = '23514';
 END IF;
 IF p_attempt THEN
  -- One recorder at a time; attempts on today's Kuala Lumpur date, as an index range on the instant.
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-recorder:' || v_tenant::text || ':' || v_user::text, 0));
  DELETE FROM app.recruitment_agency_attempt WHERE tenant_id = v_tenant AND app_user_id = v_user AND attempted_at < now() - interval '2 days';
  SELECT count(*)::integer INTO v_attempts FROM app.recruitment_agency_attempt a
   WHERE a.tenant_id = v_tenant AND a.app_user_id = v_user
    AND a.attempted_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AND a.attempted_at < ((v_today + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur');
  IF v_attempts >= 50 THEN
   INSERT INTO app.recruitment_agency_attempt (tenant_id, app_user_id, outcome) VALUES (v_tenant, v_user, 'limit');
   RETURN QUERY SELECT 'limit'::text, NULL::uuid[];
   RETURN;
  END IF;
 END IF;
 -- Company + each normalised identity, in key order: the same keys 4407 referrals and 4408 careers applications take (plus
 -- the ID number), so any two submissions, referrals or applications of the same person serialise. Held to commit.
 FOR v_key IN SELECT k FROM unnest(ARRAY[
   CASE WHEN v_email IS NOT NULL THEN hashtextextended('recruitment-referral:' || v_tenant::text || ':' || v_company::text || ':email:' || v_email, 0) END,
   CASE WHEN v_mobile IS NOT NULL THEN hashtextextended('recruitment-referral:' || v_tenant::text || ':' || v_company::text || ':mobile:' || v_mobile, 0) END,
   CASE WHEN v_id IS NOT NULL THEN hashtextextended('recruitment-referral:' || v_tenant::text || ':' || v_company::text || ':id:' || v_id, 0) END
  ]) AS k WHERE k IS NOT NULL ORDER BY k LOOP
  PERFORM pg_advisory_xact_lock(v_key);
 END LOOP;
 -- Open the company's candidate, application, referral, setting and agency rows to THIS function for THIS transaction.
 INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id) VALUES (txid_current(), v_company, v_tenant) ON CONFLICT DO NOTHING;
 SELECT coalesce(max(s.repeat_window_months), 3), coalesce(max(s.referral_protection_days), 180) INTO v_months, v_referral_days
  FROM public.recruitment_company_setting s WHERE s.company_id = v_company AND s.tenant_id = v_tenant;

 IF EXISTS (SELECT 1 FROM public.recruitment_agency_submission s
   WHERE s.job_id = p_job AND s.agency_id = v_agency AND s.tenant_id = v_tenant AND s.personal_data_removed_at IS NULL
    AND ((v_id IS NOT NULL AND s.id_number IS NOT NULL AND app.recruitment_norm_id(s.id_number) = v_id)
     OR ((app.recruitment_norm_name(s.full_name) = v_name)::int
      + coalesce(v_email IS NOT NULL AND app.recruitment_norm_email(s.email) = v_email, false)::int
      + coalesce(v_mobile IS NOT NULL AND app.recruitment_norm_mobile(s.mobile) = v_mobile, false)::int) >= 2)
    AND (s.outcome = 'waiting' OR (s.outcome = 'accepted' AND EXISTS (SELECT 1 FROM public.recruitment_application a
     WHERE a.id = s.application_id AND (a.state = 'active' OR (v_months > 0
      AND ((a.state_changed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date + make_interval(months => v_months))::date > v_today)))))) THEN
  v_outcome := 'repeat';
 ELSE
  SELECT array_agg(m.candidate_id ORDER BY m.candidate_id) FILTER (WHERE m.duplicate), array_agg(m.candidate_id ORDER BY m.candidate_id) FILTER (WHERE NOT m.duplicate)
   INTO v_dup, v_sus FROM app.recruitment_agency_matches(v_tenant, v_company, p_full_name, p_email, p_mobile, p_id_number, p_exclude) m;
  IF v_dup IS NOT NULL THEN
   -- Protected: an application of a duplicate whose channel is not this agency, applied on or after the Kuala Lumpur day
   -- (today - days + 1). Days: the accepted agency submission's contract override, else 365; an employee referral the
   -- company's period; a typed agency source 365; anything else 0.
   IF EXISTS (SELECT 1 FROM public.recruitment_application a
     LEFT JOIN LATERAL (SELECT s.agency_id, c.protection_days FROM public.recruitment_agency_submission s
       JOIN public.recruitment_agency_contract c ON c.id = s.contract_id AND c.tenant_id = s.tenant_id
       WHERE s.application_id = a.id AND s.tenant_id = a.tenant_id AND s.outcome = 'accepted' LIMIT 1) sub ON true
     CROSS JOIN LATERAL (SELECT CASE
       WHEN sub.agency_id IS NOT NULL THEN coalesce(sub.protection_days, 365)
       WHEN a.source = 'referral' OR EXISTS (SELECT 1 FROM public.recruitment_referral r WHERE r.application_id = a.id AND r.tenant_id = a.tenant_id) THEN v_referral_days
       WHEN a.source = 'agency' THEN 365
       ELSE 0 END AS days) d
     WHERE a.candidate_id = ANY (v_dup) AND a.tenant_id = v_tenant AND sub.agency_id IS DISTINCT FROM v_agency
      AND d.days > 0 AND (a.applied_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= v_today - d.days + 1) THEN
    v_outcome := 'protected';
   ELSE
    v_outcome := 'duplicate';
   END IF;
  ELSIF v_sus IS NOT NULL THEN
   v_outcome := 'suspected';
  ELSE
   v_outcome := 'new';
  END IF;
 END IF;
 DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
 IF p_attempt THEN
  INSERT INTO app.recruitment_agency_attempt (tenant_id, app_user_id, outcome) VALUES (v_tenant, v_user, v_outcome);
 END IF;
 RETURN QUERY SELECT v_outcome, CASE WHEN app.can_admin_recruitment_for(v_company) AND v_outcome <> 'repeat'
  THEN coalesce(v_dup, '{}'::uuid[]) || coalesce(v_sus, '{}'::uuid[]) END;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_check(uuid, uuid, text, text, text, text, uuid, boolean) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The ONLY entry point granted to the app role: every call is an attempt and counts against the caller's daily cap (an
-- over-cap call answers 'limit' and logs it). The attempt row commits with the caller's transaction: if a later step of the
-- recording fails and the transaction rolls back, the row goes too — and so does every answer the service would have shown
-- (the service reports an outcome only after commit; a failure shows an error, never the outcome).
CREATE FUNCTION app.recruitment_agency_submission_check(p_job uuid, p_contract uuid, p_full_name text, p_email text, p_mobile text, p_id_number text)
RETURNS TABLE(outcome text, match_ids uuid[])
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT c.outcome, c.match_ids FROM app.recruitment_agency_check(p_job, p_contract, p_full_name, p_email, p_mobile, p_id_number, NULL, true) c;
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_submission_check(uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_submission_check(uuid, uuid, text, text, text, text) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. The agency behind an application ─────────────────────────────────────────────────────────────────────
-- For a caller who may read the application: the agency name (hiring managers, interviewers and approvers see the source
-- "Agency" and this name only); the contract, consultant, submission date and comments for the job's operators and
-- administrators only. Nothing for anybody else, and nothing for an application that did not come from an agency.
CREATE FUNCTION app.recruitment_application_agency(p_application uuid)
RETURNS TABLE(submission_id uuid, agency_name text, contract_name text, consultant_name text, submitted_on date, comments text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
#variable_conflict use_column
DECLARE v_tenant uuid := app.current_tenant_id(); v_company uuid; v_job uuid; v_operate boolean;
BEGIN
 IF v_tenant IS NULL OR app.current_user_id() IS NULL OR p_application IS NULL THEN RETURN; END IF;
 SELECT a.company_id, a.job_id INTO v_company, v_job FROM public.recruitment_application a WHERE a.id = p_application AND a.tenant_id = v_tenant;
 IF v_company IS NULL OR NOT app.can_read_recruitment_application(v_company, v_job, p_application) THEN RETURN; END IF;
 v_operate := app.can_operate_recruitment_job(v_company, v_job);
 INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id) VALUES (txid_current(), v_company, v_tenant) ON CONFLICT DO NOTHING;
 RETURN QUERY
  SELECT s.id, ag.name, CASE WHEN v_operate THEN c.name END, CASE WHEN v_operate THEN k.name END, CASE WHEN v_operate THEN s.submitted_on END,
   CASE WHEN v_operate THEN s.comments END
  FROM public.recruitment_agency_submission s
  JOIN public.recruitment_agency ag ON ag.id = s.agency_id AND ag.tenant_id = s.tenant_id
  JOIN public.recruitment_agency_contract c ON c.id = s.contract_id AND c.tenant_id = s.tenant_id
  JOIN public.recruitment_agency_consultant k ON k.id = s.consultant_id AND k.tenant_id = s.tenant_id
  WHERE s.application_id = p_application AND s.tenant_id = v_tenant AND s.outcome = 'accepted';
 DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
END $$;
REVOKE ALL ON FUNCTION app.recruitment_application_agency(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_application_agency(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
-- The agency setup: written by the current user; tenant, company, agency and contract never move; the HR contact holds a
-- recruitment administration role for the company; only the company setup delete removes an agency, contract or
-- consultant (the app role has no DELETE grant on them either). An unused tag may be deleted (a tag in use is kept by
-- its foreign key) and a tag link removed.
CREATE FUNCTION app.recruitment_guard_agency_setup() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_user uuid := app.current_user_id();
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF TG_TABLE_NAME IN ('recruitment_agency','recruitment_agency_contract','recruitment_agency_consultant')
   AND current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'Agencies, contracts and consultants are kept; disable them instead' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM v_user THEN
   RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 ELSE
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
   RAISE EXCEPTION 'Agency records keep their company and creation record' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'recruitment_agency_contract' THEN
   IF NEW.agency_id IS DISTINCT FROM OLD.agency_id THEN
    RAISE EXCEPTION 'A contract keeps its agency' USING ERRCODE = '23514';
   END IF;
  ELSIF TG_TABLE_NAME = 'recruitment_agency_consultant' THEN
   IF NEW.contract_id IS DISTINCT FROM OLD.contract_id THEN
    RAISE EXCEPTION 'A consultant keeps their contract' USING ERRCODE = '23514';
   END IF;
  END IF;
 END IF;
 IF TG_TABLE_NAME = 'recruitment_agency_contract' THEN
  -- (Nested: PL/pgSQL does not short-circuit, and only a contract has the column.)
  IF (TG_OP = 'INSERT' OR NEW.hr_contact_user_id IS DISTINCT FROM OLD.hr_contact_user_id)
   AND NOT app.recruitment_user_administers(NEW.company_id, NEW.hr_contact_user_id) THEN
   RAISE EXCEPTION 'The HR contact administers recruitment for the company' USING ERRCODE = '23514';
  END IF;
 END IF;
 NEW.updated_by_user_id := v_user;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_agency_setup() FROM PUBLIC, ai_hr_app;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_agency_tag','recruitment_agency','recruitment_agency_contract','recruitment_agency_consultant'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_setup()', t || '_guard', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Terms, tag links and contract users: the writer is the current user; a contract's terms keep their contract.
CREATE FUNCTION app.recruitment_guard_agency_detail() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME = 'recruitment_agency_contract_terms' THEN
  IF TG_OP = 'UPDATE' AND (NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
   OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
   RAISE EXCEPTION 'Contract terms keep their contract' USING ERRCODE = '23514';
  END IF;
  NEW.updated_by_user_id := app.current_user_id();
  NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501';
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_agency_detail() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_agency_contract_terms_guard BEFORE INSERT OR UPDATE ON public.recruitment_agency_contract_terms
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_detail();
CREATE TRIGGER recruitment_agency_tag_link_guard BEFORE INSERT ON public.recruitment_agency_tag_link
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_detail();
CREATE TRIGGER recruitment_agency_contract_user_guard BEFORE INSERT ON public.recruitment_agency_contract_user
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_detail();
--> statement-breakpoint
-- A job's assigned contract: assigned by the current user to a job that is not closed, from a contract usable today by them
-- (Enabled, within its period, Public or listing them). Afterwards only the requirements change.
CREATE FUNCTION app.recruitment_guard_job_agency_contract() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_job_opening j WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id AND j.status <> 'closed') THEN
   RAISE EXCEPTION 'A closed job is not released to agencies' USING ERRCODE = '23514';
  END IF;
  IF NOT app.recruitment_contract_usable(NEW.contract_id) THEN
   RAISE EXCEPTION 'The contract is not usable today by the current user' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
 ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
  OR NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An assignment keeps its job and contract' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id();
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job_agency_contract() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_agency_contract_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_job_agency_contract
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job_agency_contract();
--> statement-breakpoint
-- A submission. INSERT: recorded by the current user, an operator of a job that is not closed, from a contract assigned to
-- the job and usable today by them, with an Active consultant of that contract, dated today or earlier and not before the
-- contract start; its outcome is the one app.recruitment_agency_submission_check computes again here (the service's answer
-- is never trusted): new → accepted at once with its own new candidate and application at source "agency"; protected →
-- refused; duplicate or suspected → waiting; repeat → refused outright (nothing stored).
-- UPDATE: an administrator decides a waiting submission once (accepted onto an application of the job with source "agency",
-- or rejected with a reason), the resume moving to the candidate's files; or the slice 5 removal clears its personal data.
CREATE FUNCTION app.recruitment_guard_agency_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE v_user uuid := app.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_starts date; v_outcome text;
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'An agency submission is kept' USING ERRCODE = '23514';
 END IF;
 -- Owner-run: refuse any row outside the caller's tenant before anything else, so the guard is safe even under an owner
 -- that bypasses row security (a superuser owner in development and test).
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR (TG_OP = 'UPDATE' AND OLD.tenant_id IS DISTINCT FROM app.current_tenant_id()) THEN
  RAISE EXCEPTION 'An agency submission belongs to the caller''s tenant' USING ERRCODE = '42501';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF (NEW.tenant_id, NEW.company_id, NEW.job_id, NEW.contract_id, NEW.agency_id, NEW.consultant_id, NEW.submitted_on, NEW.match_kind, NEW.refusal_reason,
      NEW.created_at, NEW.created_by_user_id)
   IS DISTINCT FROM (OLD.tenant_id, OLD.company_id, OLD.job_id, OLD.contract_id, OLD.agency_id, OLD.consultant_id, OLD.submitted_on, OLD.match_kind,
      OLD.refusal_reason, OLD.created_at, OLD.created_by_user_id) THEN
   RAISE EXCEPTION 'An agency submission keeps what was submitted' USING ERRCODE = '23514';
  END IF;
  -- The slice 5 removal (a waiting one closed as rejected), or an administrator clearing a decided submission
  -- (app.recruitment_clear_agency_submission): personal data cleared; nothing else moves.
  IF OLD.personal_data_removed_at IS NULL AND NEW.personal_data_removed_at IS NOT NULL THEN
   IF NOT (app.recruitment_destroying(OLD.candidate_id) OR (OLD.candidate_id IS NULL AND app.recruitment_destroying_in(OLD.tenant_id))
     OR (app.recruitment_agency_clearing(OLD.id) AND OLD.outcome IN ('refused','rejected') AND NEW.outcome = OLD.outcome))
    OR num_nonnulls(NEW.full_name, NEW.email, NEW.mobile, NEW.id_type, NEW.id_number, NEW.current_salary_amount, NEW.current_salary_currency,
      NEW.expected_salary_amount, NEW.expected_salary_currency, NEW.comments, NEW.review_reason, NEW.resume_name, NEW.resume_mime, NEW.resume_size,
      NEW.resume_content) > 0
    OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
    OR NOT (NEW.outcome = OLD.outcome OR (OLD.outcome = 'waiting' AND NEW.outcome = 'rejected'))
    OR (NEW.outcome = OLD.outcome AND (NEW.decided_at, NEW.decided_by_user_id) IS DISTINCT FROM (OLD.decided_at, OLD.decided_by_user_id)) THEN
    RAISE EXCEPTION 'Removing a person''s data only clears an agency submission' USING ERRCODE = '42501';
   END IF;
   IF NEW.outcome <> OLD.outcome THEN NEW.decided_at := now(); NEW.decided_by_user_id := v_user; END IF;
   RETURN NEW;
  END IF;
  IF OLD.personal_data_removed_at IS NOT NULL OR NEW.personal_data_removed_at IS NOT NULL THEN
   RAISE EXCEPTION 'This person''s data has been removed' USING ERRCODE = '23514';
  END IF;
  IF (NEW.full_name, NEW.email, NEW.mobile, NEW.id_type, NEW.id_number, NEW.current_salary_amount, NEW.current_salary_currency, NEW.expected_salary_amount,
      NEW.expected_salary_currency, NEW.comments)
   IS DISTINCT FROM (OLD.full_name, OLD.email, OLD.mobile, OLD.id_type, OLD.id_number, OLD.current_salary_amount, OLD.current_salary_currency,
      OLD.expected_salary_amount, OLD.expected_salary_currency, OLD.comments) THEN
   RAISE EXCEPTION 'An agency submission keeps what was submitted' USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome <> 'waiting' OR NOT app.can_admin_recruitment_for(OLD.company_id) THEN
   RAISE EXCEPTION 'Only a waiting submission is decided, by a recruitment administrator' USING ERRCODE = '42501';
  END IF;
  IF NEW.outcome = 'accepted' THEN
   IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id AND a.job_id = NEW.job_id
     AND a.candidate_id = NEW.candidate_id AND a.source = 'agency')
    OR EXISTS (SELECT 1 FROM public.recruitment_agency_submission s WHERE s.application_id = NEW.application_id AND s.id <> NEW.id) THEN
    RAISE EXCEPTION 'An accepted submission is the agency application of its job' USING ERRCODE = '23514';
   END IF;
   NEW.review_reason := NULL;
  ELSIF NEW.outcome = 'rejected' THEN
   IF NEW.review_reason IS NULL OR NEW.candidate_id IS NOT NULL OR NEW.application_id IS NOT NULL THEN
    RAISE EXCEPTION 'A rejection gives a reason' USING ERRCODE = '23514';
   END IF;
  ELSE
   RAISE EXCEPTION 'A waiting submission is accepted or rejected' USING ERRCODE = '23514';
  END IF;
  -- The resume may only go — to the candidate's files on acceptance, or away on rejection; it is never replaced.
  IF NEW.resume_content IS NOT NULL AND (NEW.resume_name, NEW.resume_mime, NEW.resume_size) IS DISTINCT FROM (OLD.resume_name, OLD.resume_mime, OLD.resume_size) THEN
   RAISE EXCEPTION 'A submission''s resume is not replaced' USING ERRCODE = '23514';
  END IF;
  IF NEW.resume_content IS NOT NULL AND NEW.outcome = 'accepted' THEN
   RAISE EXCEPTION 'An accepted submission''s resume moves to the candidate' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := now();
  NEW.decided_by_user_id := v_user;
  RETURN NEW;
 END IF;

 -- INSERT
 IF NEW.created_by_user_id IS DISTINCT FROM v_user OR NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
  RAISE EXCEPTION 'An agency submission is recorded by the job''s recruiter or assistant' USING ERRCODE = '42501';
 END IF;
 IF NEW.personal_data_removed_at IS NOT NULL OR NEW.review_reason IS NOT NULL THEN
  RAISE EXCEPTION 'A new submission is undecided' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_job_opening j WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id AND j.status <> 'closed') THEN
  RAISE EXCEPTION 'A closed job takes no agency submissions' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_job_agency_contract x WHERE x.job_id = NEW.job_id AND x.contract_id = NEW.contract_id AND x.tenant_id = NEW.tenant_id)
  OR NOT app.recruitment_contract_usable(NEW.contract_id) THEN
  RAISE EXCEPTION 'The contract is not assigned to the job or not usable today' USING ERRCODE = '23514';
 END IF;
 SELECT c.starts_on INTO v_starts FROM public.recruitment_agency_contract c WHERE c.id = NEW.contract_id AND c.tenant_id = NEW.tenant_id;
 IF NEW.submitted_on > v_today OR NEW.submitted_on < v_starts THEN
  RAISE EXCEPTION 'The submission date is not in the future nor before the contract start' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_agency_consultant k WHERE k.id = NEW.consultant_id AND k.contract_id = NEW.contract_id
  AND k.tenant_id = NEW.tenant_id AND k.status = 'active') THEN
  RAISE EXCEPTION 'The consultant is not an active consultant of the contract' USING ERRCODE = '23514';
 END IF;
 -- An accepted submission brings its OWN new candidate: created by the current user in this very transaction (created_at
 -- equals now(); 4405's guard keeps created_at and created_by fixed, so no later UPDATE can forge either), with no
 -- application but this one — also created by the current user in this transaction — and the typed name, e-mail and
 -- mobile. Only then is that candidate left out of the re-check; an existing candidate is never accepted onto here (that is
 -- an administrator's review).
 IF NEW.outcome = 'accepted' OR NEW.candidate_id IS NOT NULL OR NEW.application_id IS NOT NULL THEN
  IF NEW.outcome <> 'accepted' OR NOT EXISTS (SELECT 1 FROM public.recruitment_candidate c
    WHERE c.id = NEW.candidate_id AND c.tenant_id = NEW.tenant_id AND c.company_id = NEW.company_id AND c.destroyed_at IS NULL
     AND c.created_at = now() AND c.created_by_user_id = v_user
     AND app.recruitment_norm_name(c.full_name) IS NOT DISTINCT FROM app.recruitment_norm_name(NEW.full_name)
     AND app.recruitment_norm_email(c.email) IS NOT DISTINCT FROM app.recruitment_norm_email(NEW.email)
     AND app.recruitment_norm_mobile(c.phone) IS NOT DISTINCT FROM app.recruitment_norm_mobile(NEW.mobile))
   OR (SELECT count(*) FROM public.recruitment_application a WHERE a.candidate_id = NEW.candidate_id AND a.tenant_id = NEW.tenant_id) <> 1
   OR NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.candidate_id = NEW.candidate_id
     AND a.tenant_id = NEW.tenant_id AND a.applied_at = now() AND a.created_by_user_id = v_user) THEN
   RAISE EXCEPTION 'An accepted submission brings its own new candidate' USING ERRCODE = '42501';
  END IF;
 END IF;
 SELECT r.outcome INTO v_outcome FROM app.recruitment_agency_check(NEW.job_id, NEW.contract_id, NEW.full_name, NEW.email, NEW.mobile,
  NEW.id_number, CASE WHEN NEW.outcome = 'accepted' THEN NEW.candidate_id END, false) r;
 IF v_outcome = 'repeat' THEN
  RAISE EXCEPTION 'The agency already submitted this person to this job' USING ERRCODE = '23505';
 END IF;
 IF NOT ((NEW.outcome = 'accepted' AND v_outcome = 'new' AND NEW.match_kind = 'new')
  OR (NEW.outcome = 'refused' AND v_outcome = 'protected' AND NEW.match_kind = 'duplicate' AND NEW.refusal_reason = 'protected')
  OR (NEW.outcome = 'waiting' AND v_outcome IN ('duplicate','suspected') AND NEW.match_kind = v_outcome)) THEN
  RAISE EXCEPTION 'The submission''s outcome is not the one its duplicate check gives' USING ERRCODE = '23514';
 END IF;
 IF NEW.outcome = 'accepted' THEN
  IF NEW.resume_content IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id
   AND a.job_id = NEW.job_id AND a.candidate_id = NEW.candidate_id AND a.source = 'agency') THEN
   RAISE EXCEPTION 'An accepted submission is the agency application of its job' USING ERRCODE = '23514';
  END IF;
  NEW.decided_at := now(); NEW.decided_by_user_id := v_user;
 ELSIF NEW.outcome = 'refused' THEN
  NEW.resume_name := NULL; NEW.resume_mime := NULL; NEW.resume_size := NULL; NEW.resume_content := NULL;
  NEW.decided_at := now(); NEW.decided_by_user_id := v_user;
 ELSE
  NEW.decided_at := NULL; NEW.decided_by_user_id := NULL;
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_agency_submission() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_agency_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_agency_submission
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_submission();
--> statement-breakpoint
-- After a refused or waiting submission is stored: record which candidates it matched (the same answer as the check), so a
-- later removal of a candidate touches only submissions about that person. Owner-run; writes only the private link table.
CREATE FUNCTION app.recruitment_agency_submission_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 -- Owner-run: only a row of the caller's own tenant (safe under an owner that bypasses row security).
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
  RAISE EXCEPTION 'An agency submission belongs to the caller''s tenant' USING ERRCODE = '42501';
 END IF;
 IF NEW.outcome IN ('refused','waiting') THEN
  INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id) VALUES (txid_current(), NEW.company_id, NEW.tenant_id) ON CONFLICT DO NOTHING;
  INSERT INTO app.recruitment_agency_submission_match (submission_id, candidate_id, tenant_id, duplicate)
   SELECT NEW.id, m.candidate_id, NEW.tenant_id, m.duplicate
   FROM app.recruitment_agency_matches(NEW.tenant_id, NEW.company_id, NEW.full_name, NEW.email, NEW.mobile, NEW.id_number, NULL) m;
  DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_submission_link() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_agency_submission_link AFTER INSERT ON public.recruitment_agency_submission
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_agency_submission_link();
--> statement-breakpoint
-- An administrator removes the personal data of a REFUSED or REJECTED submission (the Privacy due list, or the
-- submission's page): name, contacts, ID number, salaries, comments, the review reason and any held resume. The row keeps
-- its job, contract, consultant, dates and outcome. Returns false when there was nothing to clear.
CREATE FUNCTION app.recruitment_clear_agency_submission(p_submission uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '5s' AS $$
DECLARE s public.recruitment_agency_submission%ROWTYPE;
BEGIN
 IF p_submission IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Removing a submission''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO s FROM public.recruitment_agency_submission WHERE id = p_submission AND tenant_id = app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(s.company_id) THEN
  RAISE EXCEPTION 'Removing a submission''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO s FROM public.recruitment_agency_submission WHERE id = p_submission FOR UPDATE;
 IF s.personal_data_removed_at IS NOT NULL THEN RETURN false; END IF;
 IF s.outcome NOT IN ('refused','rejected') THEN
  RAISE EXCEPTION 'Only a refused or rejected submission is cleared on its own' USING ERRCODE = '23514';
 END IF;
 INSERT INTO app.recruitment_agency_clear_marker (txid, submission_id) VALUES (txid_current(), s.id);
 UPDATE public.recruitment_agency_submission SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL, personal_data_removed_at = now()
  WHERE id = s.id;
 DELETE FROM app.recruitment_agency_submission_match WHERE submission_id = s.id;
 DELETE FROM app.recruitment_agency_clear_marker WHERE txid = txid_current() AND submission_id = s.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_clear_agency_submission(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_clear_agency_submission(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 7. Removal: 4408's app.recruitment_destroy_candidate, byte for byte, plus agency submissions ─────────────────
-- (The new step stays before the restricted values are deleted, where 4410 first placed it.)
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

-- ── 8. Deleting a company (core/company-refs.ts): 4409's body plus the agency setup ────────────────────────────
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
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
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
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
