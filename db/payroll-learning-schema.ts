/** Payroll history learning (migration 2012) — Drizzle declarations for its three tables: the company's learning mode, the
 * learned baselines and the learning runs. Kept out of db/schema.ts (inside the approved provider-data closure) and out of
 * db/teras-schema.ts (shared by parallel AI v2 workers), as db/teras-payroll-cycle-schema.ts is. Imported only by
 * core/payroll-learning. Every amount is integer sen inside `components`; no name and no prose. */
import {index,integer,jsonb,pgTable,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,employment,tenant} from './schema';

const at=(name:string)=>timestamp(name,{withTimezone:true});
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);

export type PayrollLearningMode='off'|'evidence'|'classify';
export type LearningBasis='regular'|'month_total'|'bonus';
export type BaselineStatus='none'|'provisional'|'stable'|'rebasing'|'contradicted';
/** One pay line's or pay item's statistics over the clean closed months, in integer sen (core/payroll-learning/baseline-math.ts). */
export type ComponentStats=Readonly<{n:number;median:number;p10:number;p90:number;nonZero:number;monthMask:number;fixed:boolean}>;
export type LearningRunCounts=Readonly<{people:number;appended:number;none:number;provisional:number;stable:number;rebasing:number;contradicted:number;purged:number}>;

export const payrollLearningMode=pgTable('payroll_learning_mode',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 version:integer('version').notNull(),mode:text('mode').$type<PayrollLearningMode>().notNull(),source:text('source').$type<'admin'|'proposal'>().notNull().default('admin'),
 setByUserId:uuid('set_by_user_id').notNull().references(()=>appUser.id),setAt:at('set_at').notNull().defaultNow(),
},t=>[uniqueIndex('payroll_learning_mode_tenant_id_company_id_version_key').on(t.tenantId,t.companyId,t.version),
 index('payroll_learning_mode_company_idx').on(t.tenantId,t.companyId,t.version)]);

export const payrollLearnedBaseline=pgTable('payroll_learned_baseline',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 employmentId:uuid('employment_id').notNull().references(()=>employment.id,{onDelete:'cascade'}),
 basis:text('basis').$type<LearningBasis>().notNull(),asOfPeriod:text('as_of_period').notNull(),version:integer('version').notNull(),
 status:text('status').$type<BaselineStatus>().notNull(),runs:integer('runs').notNull(),excluded:integer('excluded').notNull(),
 throughPeriod:text('through_period'),components:jsonb('components').$type<Record<string,ComponentStats>>().notNull(),
 inputDigest:text('input_digest').notNull(),method:text('method').notNull(),
 sponsorUserId:uuid('sponsor_user_id').notNull().references(()=>appUser.id),computedAt:at('computed_at').notNull().defaultNow(),
},t=>[uniqueIndex('payroll_learned_baseline_tenant_id_employment_id_basis_version_key').on(t.tenantId,t.employmentId,t.basis,t.version),
 index('payroll_learned_baseline_company_idx').on(t.tenantId,t.companyId,t.asOfPeriod,t.employmentId,t.basis,t.version),
 index('payroll_learned_baseline_employment_idx').on(t.tenantId,t.employmentId)]);

export const payrollLearningRun=pgTable('payroll_learning_run',{
 id:uuid('id').primaryKey().defaultRandom(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 runId:uuid('run_id').notNull(),trigger:text('run_trigger').$type<'tick'|'sweep'>().notNull(),
 status:text('status').$type<'ran'|'sponsor_lost'|'failed'>().notNull(),asOfPeriod:text('as_of_period'),
 sponsorUserId:uuid('sponsor_user_id').references(()=>appUser.id),agentPrincipalId:uuid('agent_principal_id').notNull(),
 method:text('method').notNull(),counts:jsonb('counts').$type<LearningRunCounts>().notNull(),
 startedAt:at('started_at').notNull(),finishedAt:at('finished_at').notNull().defaultNow(),
},t=>[uniqueIndex('payroll_learning_run_tenant_id_run_id_company_id_key').on(t.tenantId,t.runId,t.companyId),
 index('payroll_learning_run_company_idx').on(t.tenantId,t.companyId,t.startedAt)]);
