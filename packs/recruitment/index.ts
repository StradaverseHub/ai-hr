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
  ],
};
registerPack(recruitmentPack);
