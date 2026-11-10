/**
 * The Recruitment module pack (ADR-0080 D10: a NEW module starts life as a pack — interface, descriptors,
 * satellite tables and drift guard from its first slice).
 *
 * This file is the pack's DECLARATION + registry wiring and is deliberately client-safe (the sidebar imports
 * it through packs/register-all.ts): lucide icon refs and flat data only. The service surface is
 * `./service` (the facade); importing it here would drag db/client into the client bundle.
 *
 * ## Pack surface (slice 1)
 * - Rules: `./model` (pure, client-safe). Service: `./data` behind `./service`. Tables: `./schema`
 *   (DDL, row security and guards in db/migrations/4401_recruitment_core.sql).
 * - Routes: `app/recruitment/**` — Overview, Positions, Candidates, Settings. Each calls
 *   requireModule('recruitment') and then admits only recruitment administrators (HR administrators and the
 *   company-scoped Recruiting Partner, ADR-0049); the service and row security refuse independently.
 * - Kernel reads (no other pack is imported, D9): company, department, business_unit, job_grade, employment
 *   (the employee a job replaces) and app.recruitment_user_labels for names. A link to an approved job
 *   description or position is a later slice, through a kernel contract.
 * - Hire → employee: NOT in slice 1. A hired application never creates a person, employee or employment.
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
  ],
};
registerPack(recruitmentPack);
