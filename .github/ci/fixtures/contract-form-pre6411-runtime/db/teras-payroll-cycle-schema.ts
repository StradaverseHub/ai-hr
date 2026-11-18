/** AI v2 P2-2a (migration 0964) — Drizzle declarations for the payroll-cycle loops' own tables: the per-company settings
 * (Pre-salary check interval, net-swing threshold and exclusions), the administrators' decisions on threshold proposals,
 * and payroll HR's dispositions of net-swing flags. Kept out of db/schema.ts (inside the approved provider-data closure)
 * and out of db/teras-schema.ts (shared by parallel AI v2 workers), as db/teras-schema.ts explains. Imported only by
 * core/loops. Every column is a reference, a closed key, a ratio in basis points or a time: no name, amount or prose. */
import {boolean,date,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,employment,person,tenant} from './schema';
import {terasLoopCase} from './teras-schema';

const at=(name:string)=>timestamp(name,{withTimezone:true});
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);

export type PayrollLoopCheckInterval='hourly'|'twice_daily'|'daily';
export type SwingDisposition='expected'|'problem';
export type ThresholdProposalKind='threshold'|'exclusion';
/** What a threshold proposal was derived from: counts and ratios only (core/loops/swing-proposals.ts). */
export type ThresholdEvidence=Readonly<{windowDays:number;flags:number;expected:number;problems:number;expectedShareBp:number;smallestProblemBp:number|null}>;

export const terasPayrollThresholdDecision=pgTable('teras_payroll_threshold_decision',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 proposalKey:text('proposal_key').notNull(),kind:text('kind').$type<ThresholdProposalKind>().notNull(),
 fromThresholdBp:integer('from_threshold_bp').notNull(),toThresholdBp:integer('to_threshold_bp'),pattern:text('pattern'),
 evidence:jsonb('evidence').$type<ThresholdEvidence>().notNull(),decision:text('decision').$type<'approved'|'rejected'>().notNull(),
 decidedByUserId:uuid('decided_by_user_id').notNull().references(()=>appUser.id),decidedAt:at('decided_at').notNull().defaultNow(),
},t=>[index('teras_payroll_threshold_decision_company_idx').on(t.tenantId,t.companyId,t.decidedAt)]);

export const terasPayrollLoopSetting=pgTable('teras_payroll_loop_setting',{
 tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),version:integer('version').notNull(),
 checkInterval:text('check_interval').$type<PayrollLoopCheckInterval>().notNull(),swingThresholdBp:integer('swing_threshold_bp').notNull(),
 swingExclusions:text('swing_exclusions').array().notNull().default([]),
 /** Phase 2 hardening: whether the Pre-salary loop sends automatic cut-off reminders for the company (owner ruling 18). */
 remindersEnabled:boolean('reminders_enabled').notNull().default(true),source:text('source').$type<'admin'|'proposal'>().notNull(),
 decisionId:uuid('decision_id'),changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),
 changedAt:at('changed_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.companyId,t.version]})]);

export const terasPayrollSwingDisposition=pgTable('teras_payroll_swing_disposition',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),caseId:uuid('case_id').notNull().references(()=>terasLoopCase.id),
 companyId:uuid('company_id').notNull().references(()=>company.id),employmentId:uuid('employment_id').notNull().references(()=>employment.id),
 payPeriod:text('pay_period').notNull(),pattern:text('pattern').notNull(),swingBp:integer('swing_bp').notNull(),thresholdBp:integer('threshold_bp').notNull(),
 disposition:text('disposition').$type<SwingDisposition>().notNull(),
 decidedByUserId:uuid('decided_by_user_id').notNull().references(()=>appUser.id),decidedAt:at('decided_at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_payroll_swing_disposition_tenant_id_case_id_key').on(t.tenantId,t.caseId),
 index('teras_payroll_swing_disposition_company_idx').on(t.tenantId,t.companyId,t.decidedAt)]);

// ── AI v2 Phase 2 hardening (migration 2011): standing acknowledgements, their learned-rule decisions, and the Pre-salary
// loop's cut-off reminder ledger. References, closed keys, dates, counts and a person's own stated reason only. ──
export type AcknowledgementScope='person'|'group'|'company';
export const payrollCheckRuleDecision=pgTable('payroll_check_rule_decision',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 proposalKey:text('proposal_key').notNull(),checkId:text('check_id').notNull(),employmentId:uuid('employment_id').notNull().references(()=>employment.id),
 evidence:jsonb('evidence').$type<Readonly<Record<string,number|string|null>>>().notNull(),decision:text('decision').$type<'approved'|'rejected'>().notNull(),
 decidedByUserId:uuid('decided_by_user_id').notNull().references(()=>appUser.id),decidedAt:at('decided_at').notNull().defaultNow(),
},t=>[index('payroll_check_rule_decision_company_idx').on(t.tenantId,t.companyId,t.decidedAt)]);

export const payrollCheckAcknowledgement=pgTable('payroll_check_acknowledgement',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 checkId:text('check_id').notNull(),scope:text('scope').$type<AcknowledgementScope>().notNull(),
 employmentId:uuid('employment_id').references(()=>employment.id),departmentId:uuid('department_id'),
 reason:text('reason').notNull(),reviewOn:date('review_on'),source:text('source').$type<'person'|'proposal'>().notNull().default('person'),
 decisionId:uuid('decision_id'),createdByUserId:uuid('created_by_user_id').notNull().references(()=>appUser.id),createdAt:at('created_at').notNull().defaultNow(),
 revokedAt:at('revoked_at'),revokedByUserId:uuid('revoked_by_user_id').references(()=>appUser.id),
},t=>[index('payroll_check_acknowledgement_company_idx').on(t.tenantId,t.companyId,t.createdAt)]);

export const terasCutOffReminder=pgTable('teras_cut_off_reminder',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 payPeriod:text('pay_period').notNull(),cutOff:date('cut_off').notNull(),leadDays:integer('lead_days').notNull(),
 recipientEmploymentId:uuid('recipient_employment_id').notNull().references(()=>employment.id),audience:text('audience').$type<'employee'|'approver'|'both'>().notNull(),
 ownItems:integer('own_items').notNull().default(0),approvals:integer('approvals').notNull().default(0),runId:uuid('run_id'),
 agentPrincipalId:uuid('agent_principal_id').notNull(),sentAt:at('sent_at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_cut_off_reminder_tenant_id_recipient_employment_id_cut_off_lead_days_key').on(t.tenantId,t.recipientEmploymentId,t.cutOff,t.leadDays),
 index('teras_cut_off_reminder_company_idx').on(t.tenantId,t.companyId,t.cutOff)]);

/** Phase 2 hardening (migration 2011): a new joiner's own answer to "Did you work for another employer earlier this year?"
 * on their "Before payroll" checklist. Append-only; the latest answer of the person and year counts. Never pay data: the
 * TP3 form (employee_tp3) stays the only source of previous-employer income. Written only through core/pre-salary/tp3-answer.ts. */
export const payrollTp3PreviousEmployerAnswer=pgTable('payroll_tp3_previous_employer_answer',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),personId:uuid('person_id').notNull().references(()=>person.id,{onDelete:'cascade'}),
 employmentId:uuid('employment_id').notNull().references(()=>employment.id,{onDelete:'cascade'}),assessmentYear:integer('assessment_year').notNull(),
 hadPreviousEmployer:boolean('had_previous_employer').notNull(),answeredByUserId:uuid('answered_by_user_id').notNull().references(()=>appUser.id),
 answeredAt:at('answered_at').notNull().defaultNow(),
},t=>[index('payroll_tp3_previous_employer_answer_person_idx').on(t.tenantId,t.personId,t.assessmentYear,t.answeredAt.desc())]);
