/** AI v2 P2-2a (migration 0964) — Drizzle declarations for the payroll-cycle loops' own tables: the per-company settings
 * (Pre-salary check interval, net-swing threshold and exclusions), the administrators' decisions on threshold proposals,
 * and payroll HR's dispositions of net-swing flags. Kept out of db/schema.ts (inside the approved provider-data closure)
 * and out of db/teras-schema.ts (shared by parallel AI v2 workers), as db/teras-schema.ts explains. Imported only by
 * core/loops. Every column is a reference, a closed key, a ratio in basis points or a time: no name, amount or prose. */
import {index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,employment,tenant} from './schema';
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
 swingExclusions:text('swing_exclusions').array().notNull().default([]),source:text('source').$type<'admin'|'proposal'>().notNull(),
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
