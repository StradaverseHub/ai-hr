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
 *   (DDL, row security and guards in db/migrations/4401_recruitment_core.sql).
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
 *   destruction (db/migrations/4405_recruitment_candidate_privacy.sql).
 * - Reports (slice 6, ./reports and ./report-model): four fixed dashboards (Overview, Positions, Interviews, Team) of
 *   aggregates only, each in one read-only snapshot with a local statement timeout; administrators see their companies,
 *   a job's recruiter, assistants and hiring managers only their jobs; Team is administrator-only. Indexes: 4406.
 * - Employee referrals (slice 7, ./referrals and ./referral-model): the portal, the refer form and My referrals live under
 *   app/me/referrals for any person with an active employment in a company with Recruitment; they reach the pack only through
 *   4407's definer functions (the referrer holds no grant on a recruitment table). HR sets "Show on the referral portal" per
 *   job and the protection period per company, and sees the referrer on the application. No rewards or notifications.
 * - Careers page (slice 8, ./careers and ./careers-model): one public page per company at /careers/<address> with its Open
 *   jobs and a short application form, served to visitors who are not signed in by app/careers/** route handlers (plain HTML,
 *   no script, no cookie) that reach the data ONLY through 4408's definer functions. HR sets the page, its privacy notice
 *   versions and "Show on careers page" per job; an application lands as a new candidate with source "Careers page".
 * - Tasks and updates (slice 9, ./tasks and ./tasks-model): live personal to-dos (approval steps waiting for the viewer,
 *   interview feedback due) on the Overview, in the bell and on My tasks (core/approvals-inbox.ts PACK_TASK_SOURCES);
 *   per-job counts of applications to schedule and to screen on the Overview only, streamed after the page (D-035); and
 *   live updates per category with unread counts. Everything is read as
 *   the viewer under row security; only the viewer's own "read up to" time per company and category is stored (4409).
 * - Team access (slice 2): a job's recruiter, assistants, hiring managers and interviewers reach that job's data through
 *   database predicates (4402); the menu shows for team members, interviewers and pending approvers.
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
    // Slice 2 (4402)
    { table: 'recruitment_company_setting', note: 'per-company feedback visibility, edit lock and offer settings' },
    { table: 'recruitment_evaluation_form', note: 'evaluation forms: ordered sections of 1–5 rated criteria' },
    { table: 'recruitment_interview', note: 'interviews of an application (status is derived)' },
    { table: 'recruitment_interview_interviewer', note: 'who interviews; grants read of that one application' },
    { table: 'recruitment_scorecard', note: 'one interviewer\'s own feedback per interview' },
    // Slice 3 (4403)
    { table: 'recruitment_offer_field', note: 'company offer-field set: type, required, needs approval, private' },
    { table: 'recruitment_approval_step', note: 'company approval flows (offers, requisitions): ordered approvers' },
    { table: 'recruitment_offer', note: 'one current offer per application, with its approval round' },
    { table: 'recruitment_offer_value', note: 'offer values; private ones readable only by admins, recruiter, creator' },
    { table: 'recruitment_offer_approval', note: 'offer approval decision log' },
    { table: 'recruitment_hire_handoff', note: 'application → employee draft HR saved through the personnel writer' },
    // Slice 4 (4404)
    { table: 'recruitment_requisition', note: 'job requisitions with HC numbers, statuses and approval' },
    { table: 'recruitment_requisition_approval', note: 'requisition approval decision log' },
    { table: 'recruitment_requisition_job', note: 'many jobs to one requisition' },
    // Slice 5 (4405)
    { table: 'recruitment_candidate_restricted', note: 'salaries and ID number: administrators and the candidate\'s job operators only' },
    { table: 'recruitment_candidate_entry', note: 'candidate work experience and education entries' },
    { table: 'recruitment_candidate_file', note: 'resumes and attachments (bytes), with the uploader\'s permission confirmation' },
    { table: 'recruitment_tag_group', note: 'company tag groups' },
    { table: 'recruitment_tag', note: 'manual tags, unique within a group; disabled tags stay on candidates' },
    { table: 'recruitment_candidate_tag', note: 'tags on candidates: reviewers read, operators write' },
    { table: 'recruitment_candidate_consent', note: 'append-only consent history entered by people' },
    // Slice 7 (4407)
    { table: 'recruitment_referral', note: 'employee referrals: referrer, job, application, reason and agreement time; no candidate data of its own' },
    // Slice 8 (4408)
    { table: 'recruitment_careers_site', note: 'one public careers page per company: address, display name, headline, introduction, published' },
    { table: 'recruitment_careers_notice', note: 'careers privacy notice versions, immutable, numbered by the database' },
    { table: 'recruitment_careers_application', note: 'applications received through the careers page: job, candidate, message, arrival time' },
    // Slice 9 (4409)
    { table: 'recruitment_task_read_marker', note: 'a user\'s own "read up to" time per company and update category; no candidate data' },
  ],
};
registerPack(recruitmentPack);
