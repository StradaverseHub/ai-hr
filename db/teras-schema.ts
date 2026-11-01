/** ADR-0170 step 5a — Drizzle declarations for the outcome record, task memory and work-job mandates
 * (migration 0890), and the rule-version columns migration 0891 added to three native owners.
 *
 * WHY A SEPARATE FILE. db/schema.ts is inside the approved provider-data source closure
 * (scripts/ai-provider-data-source-manifest.mjs): any edit to it, even an additive table, changes the
 * approved digest and blocks provider egress until a fresh human approval. Step 5a must leave both approved
 * digests unchanged, so its tables are declared here, imported only by core/outcome-record, core/mandates
 * and the new harness adapters. Nothing in the provider or agent closures imports this file.
 * Fold these into db/schema.ts when the next approval of that closure is taken.
 *
 * The three `*RuleVersion` tables redeclare only the id and `rule_version` of existing owner tables, so the
 * labeller can read a version without the owner's full declaration changing. */
import {boolean,index,integer,jsonb,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,person,tenant} from './schema';
import type {HumanInvolvement,NoticeState,OutcomeCheck,OutcomeKind,OutcomeRead,OutcomeReplay} from '../core/outcome-record/types';
import type {MandateLimits,MandateSchedule,MandateScope,WorkJobType} from '../core/mandates/job-types';

const id=()=>uuid('id').primaryKey().defaultRandom();
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);
const at=(name:string)=>timestamp(name,{withTimezone:true});

export const terasMandateJobTypeEnablement=pgTable('teras_mandate_job_type_enablement',{
 tenantId:tenantId(),jobType:text('job_type').$type<WorkJobType>().notNull(),enabled:boolean('enabled').notNull().default(false),
 maxValidityDays:integer('max_validity_days').notNull().default(90),maxRunsPerDay:integer('max_runs_per_day').notNull().default(1),
 version:integer('version').notNull().default(1),
 changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),changedAt:at('changed_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.jobType]})]);

export const terasMandateControl=pgTable('teras_mandate_control',{
 tenantId:uuid('tenant_id').primaryKey().references(()=>tenant.id),stopped:boolean('stopped').notNull().default(false),
 version:integer('version').notNull().default(1),
 changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),changedAt:at('changed_at').notNull().defaultNow(),
});

export const terasMandate=pgTable('teras_mandate',{
 id:id(),tenantId:tenantId(),jobType:text('job_type').$type<WorkJobType>().notNull(),version:integer('version').notNull().default(1),
 grantorUserId:uuid('grantor_user_id').notNull().references(()=>appUser.id),grantorPersonId:uuid('grantor_person_id').notNull().references(()=>person.id),
 agentIdentityId:uuid('agent_identity_id').notNull().unique().defaultRandom(),
 scope:jsonb('scope').$type<MandateScope>().notNull(),limits:jsonb('limits').$type<MandateLimits>().notNull(),
 schedule:jsonb('schedule').$type<MandateSchedule>().notNull(),notify:text('notify').$type<'each_action'|'daily_summary'>().notNull(),
 validFrom:at('valid_from').notNull(),validUntil:at('valid_until').notNull(),
 revokedAt:at('revoked_at'),revokedByUserId:uuid('revoked_by_user_id').references(()=>appUser.id),revokedBy:text('revoked_by').$type<'grantor'|'administrator'>(),
 createdAt:at('created_at').notNull().defaultNow(),
},t=>[index('teras_mandate_grantor_idx').on(t.tenantId,t.grantorUserId)]);

export const terasOutcomeRecord=pgTable('teras_outcome_record',{
 id:id(),tenantId:tenantId(),companyId:uuid('company_id').references(()=>company.id),
 runId:uuid('run_id').notNull(),runKind:text('run_kind').$type<'turn'|'mandate_run'>().notNull(),
 startedAt:at('started_at').notNull(),finishedAt:at('finished_at').notNull(),recordedAt:at('recorded_at').notNull().defaultNow(),
 authorityKind:text('authority_kind').$type<'person'|'mandate'>().notNull(),askedByUserId:uuid('asked_by_user_id').references(()=>appUser.id),
 mandateId:uuid('mandate_id'),mandateVersion:integer('mandate_version'),grantorUserId:uuid('grantor_user_id').references(()=>appUser.id),
 agentIdentity:text('agent_identity').notNull(),
 reads:jsonb('reads').$type<OutcomeRead[]>().notNull(),checks:jsonb('checks').$type<OutcomeCheck[]>().notNull(),replay:jsonb('replay').$type<OutcomeReplay>().notNull(),
 outcomeKind:text('outcome_kind').$type<OutcomeKind>().notNull(),outcome:jsonb('outcome').$type<Record<string,unknown>>().notNull(),
 humanInvolvement:text('human_involvement').$type<HumanInvolvement>().notNull(),notice:text('notice').$type<NoticeState>().notNull(),
 trace:jsonb('trace').$type<Record<string,unknown>>(),
},t=>[uniqueIndex('teras_outcome_record_tenant_id_run_id_key').on(t.tenantId,t.runId)]);

export const terasOutcomeFollowup=pgTable('teras_outcome_followup',{
 id:id(),tenantId:tenantId(),recordId:uuid('record_id').notNull(),
 kind:text('kind').$type<'decision'|'mandate_completion'|'undo'|'notice'>().notNull(),
 decision:text('decision').$type<'accepted'|'rejected'|'completed'|'undone'>(),humanInvolvement:text('human_involvement').$type<HumanInvolvement>().notNull(),
 notice:text('notice').$type<NoticeState>(),noticeChannel:text('notice_channel').$type<'in_app'|'email'>(),
 byUserId:uuid('by_user_id').references(()=>appUser.id),reference:jsonb('reference').$type<Record<string,string>>().notNull().default({}),
 at:at('at').notNull().defaultNow(),
});

export const terasTaskMemory=pgTable('teras_task_memory',{
 tenantId:tenantId(),appUserId:uuid('app_user_id').notNull().references(()=>appUser.id),conversationId:text('conversation_id').notNull(),
 // The step 1 task-memory shape; typed loosely here so this file names no harness module (the harness import guard).
 memory:jsonb('memory').$type<Record<string,unknown>>().notNull(),updatedAt:at('updated_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.appUserId,t.conversationId]})]);

// 0891 — the version columns only. The owners' full declarations stay in db/schema.ts.
export const leaveTypeRuleVersion=pgTable('leave_type',{id:uuid('id').primaryKey(),ruleVersion:integer('rule_version').notNull()});
export const leaveApprovalPolicyRuleVersion=pgTable('leave_approval_policy',{id:uuid('id').primaryKey(),ruleVersion:integer('rule_version').notNull(),
 templateId:uuid('template_id')});
export const leaveApprovalTemplateRuleVersion=pgTable('leave_approval_template',{id:uuid('id').primaryKey(),ruleVersion:integer('rule_version').notNull(),
 isTenantDefault:boolean('is_tenant_default').notNull(),active:boolean('active').notNull()});
