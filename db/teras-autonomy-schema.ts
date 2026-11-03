/** AI v2 Phase 2 P2-1 — Drizzle declarations for the autonomy ladder (migration 0963): a loop's level and limits per
 * company, their history, the automatic actions a loop took and their undos.
 *
 * A separate file, like db/teras-schema.ts and for the same reason: db/schema.ts and db/teras-schema.ts are inside the
 * approved provider-data source closure, and this step must leave that closure's digest unchanged. Imported only by
 * core/loops. Fold into db/schema.ts when the next approval of that closure is taken. */
import {date,index,integer,jsonb,pgTable,primaryKey,smallint,text,timestamp,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,employment,tenant} from './schema';
import {terasLoopCase} from './teras-schema';
import type {ActCondition,AutonomyLevel,LevelChangeKind,LevelChangedBy,LoopActionCheck,LoopActionFacts,LoopActionReason,LoopActionState,UndoWindowDays,UndoneBy} from '../core/loops/autonomy-types';
import type {LoopId} from '../core/loops/types';

const id=()=>uuid('id').primaryKey().defaultRandom();
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);
const at=(name:string)=>timestamp(name,{withTimezone:true});

/** 0963 — the current level and limits of one loop in one company. No row is Prepare. */
export const terasLoopLevel=pgTable('teras_loop_level',{
 tenantId:tenantId(),workerId:text('worker_id').$type<LoopId>().notNull(),companyId:uuid('company_id').notNull().references(()=>company.id),
 level:smallint('level').$type<AutonomyLevel>().notNull(),
 maxActionsPerNight:integer('max_actions_per_night').notNull().default(50),
 undoDays:smallint('undo_days').$type<UndoWindowDays>().notNull().default(3),
 actCondition:text('act_condition').$type<ActCondition>().notNull().default('roster_and_site_exit'),
 conditionSetByUserId:uuid('condition_set_by_user_id').references(()=>appUser.id),conditionSetAt:at('condition_set_at'),
 version:integer('version').notNull().default(1),
 changedBy:text('changed_by').$type<LevelChangedBy>().notNull(),changedByUserId:uuid('changed_by_user_id').references(()=>appUser.id),
 changedAt:at('changed_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.workerId,t.companyId]})]);

/** 0963 — append-only history of every level change, with the evidence behind it. */
export const terasLoopLevelChange=pgTable('teras_loop_level_change',{
 id:id(),tenantId:tenantId(),workerId:text('worker_id').$type<LoopId>().notNull(),companyId:uuid('company_id').notNull().references(()=>company.id),
 fromLevel:smallint('from_level').$type<AutonomyLevel>().notNull(),toLevel:smallint('to_level').$type<AutonomyLevel>().notNull(),
 kind:text('kind').$type<LevelChangeKind>().notNull(),changedBy:text('changed_by').$type<LevelChangedBy>().notNull(),
 changedByUserId:uuid('changed_by_user_id').references(()=>appUser.id),runId:uuid('run_id'),
 limits:jsonb('limits').$type<Record<string,unknown>>().notNull(),evidence:jsonb('evidence').$type<Record<string,unknown>>().notNull(),
 changedAt:at('changed_at').notNull().defaultNow(),
},t=>[index('teras_loop_level_change_latest_idx').on(t.tenantId,t.workerId,t.companyId,t.changedAt)]);

/** 0963 — one automatic action a loop attempted on one of its cases (at most one per case). */
export const terasLoopAction=pgTable('teras_loop_action',{
 id:id(),tenantId:tenantId(),workerId:text('worker_id').$type<LoopId>().notNull(),companyId:uuid('company_id').notNull().references(()=>company.id),
 caseId:uuid('case_id').notNull().references(()=>terasLoopCase.id),employmentId:uuid('employment_id').notNull().references(()=>employment.id),
 runId:uuid('run_id').notNull(),level:smallint('level').$type<AutonomyLevel>().notNull(),state:text('state').$type<LoopActionState>().notNull(),
 reason:text('reason').$type<LoopActionReason>(),ruleVersion:text('rule_version').notNull(),
 sponsorUserId:uuid('sponsor_user_id').notNull().references(()=>appUser.id),agentPrincipalId:uuid('agent_principal_id').notNull(),
 checks:jsonb('checks').$type<LoopActionCheck[]>().notNull(),facts:jsonb('facts').$type<LoopActionFacts>().notNull(),
 ownerRef:uuid('owner_ref'),createdAt:at('created_at').notNull().defaultNow(),appliedAt:at('applied_at'),undoUntil:at('undo_until').notNull(),
 peopleChangedAt:at('people_changed_at'),
},t=>[index('teras_loop_action_company_idx').on(t.tenantId,t.workerId,t.companyId,t.createdAt)]);

/** 0963 — the undo of an applied action, with the owner's compensating record. Append-only. */
export const terasLoopActionUndo=pgTable('teras_loop_action_undo',{
 actionId:uuid('action_id').primaryKey().references(()=>terasLoopAction.id),tenantId:tenantId(),
 undoneBy:text('undone_by').$type<UndoneBy>().notNull(),undoneByUserId:uuid('undone_by_user_id').notNull().references(()=>appUser.id),
 compensationRef:uuid('compensation_ref').notNull(),undoneAt:at('undone_at').notNull().defaultNow(),
});

/** 0963 — a weekly sample of a Level 3 loop's actions, reviewed by HR. Append-only. */
export const terasLoopSampleReview=pgTable('teras_loop_sample_review',{
 id:id(),tenantId:tenantId(),workerId:text('worker_id').$type<LoopId>().notNull(),companyId:uuid('company_id').notNull().references(()=>company.id),
 weekStart:date('week_start').notNull(),actionIds:jsonb('action_ids').$type<string[]>().notNull(),
 reviewedByUserId:uuid('reviewed_by_user_id').notNull().references(()=>appUser.id),reviewedAt:at('reviewed_at').notNull().defaultNow(),
},t=>[index('teras_loop_sample_review_week_idx').on(t.tenantId,t.workerId,t.companyId,t.weekStart)]);
