/**
 * The Recruitment module pack (ADR-0080 D10: a NEW module starts life as a pack — interface, descriptors,
 * satellite tables and drift guard from its first slice).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the sidebar imports
 * it through packs/register-all.ts): lucide icon refs and flat data only. The service surface is
 * `./service` (the facade); importing it here would drag db/client into the client bundle.
 *
 * ## Pack surface (slice 1; slices 2–4 add ./hiring-model, ./interviews, ./offers and ./requisitions behind ./service)
 * - Rules: `./model` (pure, client-safe). Service: `./data` behind `./service`. Tables: `./schema`
 *   (DDL, row security and guards in db/migrations/5201_recruitment_core.sql).
 * - Routes: `app/recruitment/**` — Overview, Positions, Candidates, Settings. Each calls
 *   requireModule('recruitment') and then admits only recruitment administrators (HR administrators and the
 *   company-scoped Recruiting Partner, ADR-0049); the service and row security refuse independently.
 * - Kernel reads (no other pack is imported, D9): company, department, business_unit, job_grade, employment
 *   (the employee a job replaces) and app.recruitment_user_labels for names. A link to an approved job
 *   description or position is a later slice, through a kernel contract.
 * - Hire → employee (slice 3): "Start new hire" opens the existing personnel create form pre-filled on the server; the
 *   draft is created by the personnel writer when HR saves, then linked back. Recruitment never creates a person,
 *   employee or employment.
 * - Candidate records and privacy (slice 5, ./candidates and ./privacy-model): profile, restricted values, files, duplicate
 *   detection that discloses only a count, repeated applications, manual tags, consent, retention and administrator-confirmed
 *   destruction (db/migrations/5205_recruitment_candidate_privacy.sql).
 * - Reports (slice 6, ./reports and ./report-model): four fixed dashboards (Overview, Positions, Interviews, Team) of
 *   aggregates only, each in one read-only snapshot with a local statement timeout; administrators see their companies,
 *   a job's recruiter, assistants and hiring managers only their jobs; Team is administrator-only. Indexes: 5206.
 * - Employee referrals (slice 7, ./referrals and ./referral-model): the portal, the refer form and My referrals live under
 *   app/me/referrals for any person with an active employment in a company with Recruitment; they reach the pack only through
 *   5207's definer functions (the referrer holds no grant on a recruitment table). HR sets "Show on the referral portal" per
 *   job and the protection period per company, and sees the referrer on the application. No rewards or notifications.
 * - Careers page (slice 8, ./careers and ./careers-model): one public page per company at /careers/<address> with its Open
 *   jobs and a short application form, served to visitors who are not signed in by app/careers/** route handlers (plain HTML,
 *   no script, no cookie) that reach the data ONLY through 5208's definer functions. HR sets the page, its privacy notice
 *   versions and "Show on careers page" per job; an application lands as a new candidate with source "Careers page".
 * - Tasks and updates (slice 9, ./tasks and ./tasks-model): live personal to-dos (approval steps waiting for the viewer,
 *   interview feedback due) on the Overview, in the bell and on My tasks (core/approvals-inbox.ts PACK_TASK_SOURCES);
 *   per-job counts of applications to schedule and to screen on the Overview only, streamed after the page (D-035); and
 *   live updates per category with unread counts. Everything is read as
 *   the viewer under row security; only the viewer's own "read up to" time per company and category is stored (5209).
 * - Agencies and headhunters (slice 10, ./agencies and ./agency-model): administrators keep agencies, tags, contracts (fee rate and
 *   file in an administrators-only table) and consultants (contact records) under Settings › Agencies; administrators and a job's
 *   recruiter release the job to usable contracts; the job's recruiter and assistants record submissions on the agency's behalf,
 *   checked for duplicates and channel protection by 5210's definer, which answers an outcome (and match ids to administrators
 *   only). No agency login or message (D-036); no fee is calculated (D-037).
 * - Resume screening (slice 11, ./screening and ./screening-model): a job's recruiter, assistants and administrators send
 *   applications to the job's hiring managers (optionally moving them to the next stage in the same transaction); each reviewer
 *   answers Advance, Reject or Pending on the To screen page; the board shows each card's derived assignment status and filters
 *   by it (5211). One fixed form (D-040); reviewers are hiring managers only (D-041).
 * - Background checks (slice 12, ./background-checks and ./background-check-model): administrators keep the company's check
 *   types under Settings › Background checks; the job's recruiter, assistants and administrators record checks run outside AI
 *   HR (D-043) at or after the Offer stage — the candidate's authorisation first (D-044), then In progress, Completed with an
 *   outcome or Cancelled; the summary, provider, reference and files sit in operator-only tables, and hiring managers see
 *   types, status and outcome (D-045). Checks gate nothing and are never copied to an employee (D-046) (5212).
 * - Talent pools and the blocked list (slice 13, ./pools, ./blocked-list and ./pool-model): administrators keep custom pools (two
 *   levels; shared with all recruiters or listed users, D-050) under Settings › Talent pools; operators add and remove the
 *   candidates they operate in pools they can see. Administrators add and remove blocked-list entries with a reason through
 *   5213's owner-run functions; every channel's new matching application is marked at commit and cannot move, get an offer or
 *   be hired until an administrator resolves the mark (D-049). Reasons are for administrators only (5213).
 * - Custom candidate and job fields (slice 14, ./custom-fields, ./custom-field-store and ./custom-field-model): administrators define
 *   fields per company and record kind under Settings › Custom fields (labels in six locales, eight types, options, required,
 *   restricted for candidates, order, enable/disable); a fixed word list refuses sensitive categories (D-052). Values are typed,
 *   one row per record and field, filled on the candidate profile and the job form and shown after the fixed fields; restricted
 *   candidate values sit in an operator-only table; the board, talent pool and job list filter by one choice or yes/no field (5215).
 * - Position templates (slice 15, ./position-templates and ./position-template-model): administrators keep the company's templates
 *   (job fields, process, interview plan, custom job values) under Settings › Position templates and switch the feature on; "New
 *   position from template" opens the ordinary form pre-filled (parts no longer usable left empty with notes; a requisition's values
 *   win) and the job records the template only (5216). Jobs carry an interview plan (a scorecard template per round).
 * - Import, export and To assign (slice 16, ./import, ./import-model, ./export and ./export-model): a structured candidate file is
 *   previewed in full, then imported by a background job on the shared bulk-job kernel (one step per row, rows independent, D-055);
 *   candidates without a usable job wait on the To assign list until assigned or hidden; the board, talent pool and a job's
 *   interview feedback export as CSV or Excel from what the exporter reads, capped and formula-escaped, with saved column sets (5217).
 * - Team access (slice 2): a job's recruiter, assistants, hiring managers and interviewers reach that job's data through
 *   database predicates (5202); the menu shows for team members, interviewers and pending approvers.
 */
import { UserSearch } from 'lucide-react';
import { registerPack, type ModulePack } from '../registry';

export const recruitmentPack: ModulePack = {
  id: 'recruitment',
  kind: 'module',
  serviceFacade: 'packs/recruitment/service',
  navLinks: [
    // One menu entry; Overview, Positions, Candidates and Settings are the page's own tabs.
    { group: 'manage', href: '/recruitment', labelKey: 'recruitment', icon: UserSearch },
  ],
  satelliteTables: [
    { table: 'recruitment_stage', note: 'company stage catalogue (editable seed defaults)' },
    { table: 'recruitment_process', note: 'named recruitment processes' },
    { table: 'recruitment_process_stage', note: 'ordered stages of a process' },
    { table: 'recruitment_archive_reason', note: 'rejection / archive reasons, internal and external' },
    { table: 'recruitment_job_opening', note: 'job openings (positions) with MJ job numbers' },
    { table: 'recruitment_job_member', note: 'per-job team: recruiter, assistants, hiring managers, interviewers' },
    { table: 'recruitment_candidate', note: 'candidates — never a person or employee' },
    { table: 'recruitment_application', note: 'candidate × job, current stage and terminal state' },
    { table: 'recruitment_application_event', note: 'append-only application history' },
    // Slice 2 (5202)
    { table: 'recruitment_company_setting', note: 'per-company feedback visibility, edit lock and offer settings' },
    { table: 'recruitment_evaluation_form', note: 'evaluation forms: ordered sections of 1–5 rated criteria' },
    { table: 'recruitment_interview', note: 'interviews of an application (status is derived)' },
    { table: 'recruitment_interview_interviewer', note: 'who interviews; grants read of that one application' },
    { table: 'recruitment_scorecard', note: 'one interviewer\'s own feedback per interview' },
    // Slice 3 (5203)
    { table: 'recruitment_offer_field', note: 'company offer-field set: type, required, needs approval, private' },
    { table: 'recruitment_approval_step', note: 'company approval flows (offers, requisitions): ordered approvers' },
    { table: 'recruitment_offer', note: 'one current offer per application, with its approval round' },
    { table: 'recruitment_offer_value', note: 'offer values; private ones readable only by admins, recruiter, creator' },
    { table: 'recruitment_offer_approval', note: 'offer approval decision log' },
    { table: 'recruitment_hire_handoff', note: 'application → employee draft HR saved through the personnel writer' },
    // Slice 4 (5204)
    { table: 'recruitment_requisition', note: 'job requisitions with HC numbers, statuses and approval' },
    { table: 'recruitment_requisition_approval', note: 'requisition approval decision log' },
    { table: 'recruitment_requisition_job', note: 'many jobs to one requisition' },
    // Slice 5 (5205)
    { table: 'recruitment_candidate_restricted', note: 'salaries and ID number: administrators and the candidate\'s job operators only' },
    { table: 'recruitment_candidate_entry', note: 'candidate work experience and education entries' },
    { table: 'recruitment_candidate_file', note: 'resumes and attachments (bytes), with the uploader\'s permission confirmation' },
    { table: 'recruitment_tag_group', note: 'company tag groups' },
    { table: 'recruitment_tag', note: 'manual tags, unique within a group; disabled tags stay on candidates' },
    { table: 'recruitment_candidate_tag', note: 'tags on candidates: reviewers read, operators write' },
    { table: 'recruitment_candidate_consent', note: 'append-only consent history entered by people' },
    // Slice 7 (5207)
    { table: 'recruitment_referral', note: 'employee referrals: referrer, job, application, reason and agreement time; no candidate data of its own' },
    // Slice 8 (5208)
    { table: 'recruitment_careers_site', note: 'one public careers page per company: address, display name, headline, introduction, published' },
    { table: 'recruitment_careers_notice', note: 'careers privacy notice versions, immutable, numbered by the database' },
    { table: 'recruitment_careers_application', note: 'applications received through the careers page: job, candidate, message, arrival time' },
    // Slice 9 (5209)
    { table: 'recruitment_task_read_marker', note: 'a user\'s own "read up to" time per company and update category; no candidate data' },
    // Slice 10 (5210)
    { table: 'recruitment_agency_tag', note: 'the company\'s agency tags (administrators); a tag in use is disabled, not deleted' },
    { table: 'recruitment_agency', note: 'agency companies (headhunters, RPO providers), name unique in the company' },
    { table: 'recruitment_agency_tag_link', note: 'tags on agencies' },
    { table: 'recruitment_agency_contract', note: 'agency contracts: type, status, period, HR contact, access, protection override' },
    { table: 'recruitment_agency_contract_terms', note: 'fee rate and contract file: recruitment administrators only (row security)' },
    { table: 'recruitment_agency_contract_user', note: 'the users a Restricted contract is released to' },
    { table: 'recruitment_agency_consultant', note: 'agency consultants: contact records, not users; nothing is sent to them' },
    { table: 'recruitment_job_agency_contract', note: 'contracts released to a job, with requirements for the agency' },
    { table: 'recruitment_agency_submission', note: 'submissions HR recorded for an agency, with the outcome of the duplicate and protection check' },
    // Slice 11 (5211)
    { table: 'recruitment_screening_request', note: 'a hiring manager asked to screen an application: sender, time, note, how it closed' },
    { table: 'recruitment_screening_answer', note: 'the reviewer\'s screening answers (Advance, Reject or Pending, comment), append-only' },
    // Slice 12 (5212)
    { table: 'recruitment_background_check_type', note: 'the company\'s background check types (administrators); a type in use is disabled, not deleted' },
    { table: 'recruitment_background_check', note: 'background checks on applications: status, outcome, recorder and status dates' },
    { table: 'recruitment_background_check_type_link', note: 'the types of a background check, fixed when it is added' },
    { table: 'recruitment_background_check_detail', note: 'provider, reference, authorisation, summary, cancellation reason: the job\'s operators and administrators only' },
    { table: 'recruitment_background_check_file', note: 'authorisation files and reports (bytes): the job\'s operators and administrators only' },
    // Slice 13 (5213)
    { table: 'recruitment_talent_pool', note: 'custom talent pools and sub-pools (two levels), shared with all recruiters or listed users' },
    { table: 'recruitment_talent_pool_share', note: 'the users a "listed users" pool is shared with' },
    { table: 'recruitment_talent_pool_member', note: 'candidates in custom pools, with who added them and when' },
    { table: 'recruitment_blocked_entry', note: 'candidates on the blocked list (no reason or identity values here)' },
    { table: 'recruitment_blocked_entry_restricted', note: 'blocked-list reasons and normalised identity values: recruitment administrators only' },
    { table: 'recruitment_blocked_history', note: 'blocked-list history: ids, action, actor and time, never a reason or identity value' },
    { table: 'recruitment_application_review_mark', note: '"Needs an administrator\'s review" marks from the blocked list; hold moves, offers and hire' },
    // Slice 14 (5215)
    { table: 'recruitment_custom_field', note: 'custom candidate and job fields: labels per locale, type, required, restricted, enabled, position' },
    { table: 'recruitment_custom_field_option', note: 'options of a custom choice field; an option in use is disabled, not deleted' },
    { table: 'recruitment_candidate_custom_value', note: 'a candidate\'s typed custom values (non-restricted fields), read with the candidate' },
    { table: 'recruitment_candidate_custom_restricted', note: 'a candidate\'s restricted custom values: administrators and the candidate\'s job operators only' },
    { table: 'recruitment_job_custom_value', note: 'a job\'s typed custom values, read with the job' },
    // Slice 15 (5216)
    { table: 'recruitment_position_template', note: 'position templates: name, job fields, process and interview plan to pre-fill new positions; administrators only' },
    { table: 'recruitment_position_template_value', note: 'a position template\'s typed custom job field values (no personal data)' },
    // Slice 16 (5217)
    { table: 'recruitment_candidate_import', note: 'one candidate import (the bulk job\'s id): company, importer, permission confirmation, file rows, ending; no personal data' },
    { table: 'recruitment_candidate_import_row', note: 'one result per import file row: outcome, created candidate and application, job result, flags and error codes; never a file value' },
    { table: 'recruitment_to_assign', note: 'a candidate with no application (To assign): importer, date, job title as written, hidden or shown; the company\'s operators' },
    { table: 'recruitment_candidate_import_note', note: 'the notes column of an import file, per candidate; operator-only' },
    { table: 'recruitment_export_template', note: 'saved export column sets per company and kind; administrators manage, operators use' },
  ],
};
registerPack(recruitmentPack);
