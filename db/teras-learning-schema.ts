/** AI v2 Phase 2, P2-6 — Drizzle declarations of the learning loops (migration 0972): signals, their reviews, gap
 * occurrences with their redacted examples and statuses, and eval candidates.
 *
 * WHY NOT db/teras-schema.ts. That file is inside the approved provider-data source closure
 * (scripts/ai-provider-data-source-manifest.mjs), so any edit there changes the approved digest. These tables are part of no
 * provider request: they are declared here and imported only by core/learning/* and tests (the db/teras-capacity-schema.ts
 * precedent). Fold into db/schema.ts when the next approval of that closure is taken.
 *
 * Signals, reviews, gap occurrences and statuses are append-only (a trigger refuses UPDATE and DELETE). A gap example is
 * deleted only once expired. A candidate is updated in place, every change the next version (a trigger checks it). */
import {integer,pgTable,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,tenant} from './schema';
import type {CandidateState,EvalFactor,EvalKind,GapKind,GapStatus,LearningLocale,LearningRole,ReviewDecision,SignalKind} from '../core/learning/types';

const id=()=>uuid('id').primaryKey().defaultRandom();
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);
const companyId=()=>uuid('company_id').notNull().references(()=>company.id);
const at=(name:string)=>timestamp(name,{withTimezone:true});

export const terasLearningSignal=pgTable('teras_learning_signal',{
 id:id(),tenantId:tenantId(),companyId:companyId(),recordId:uuid('record_id').notNull(),signalKey:text('signal_key').notNull(),
 kind:text('kind').$type<SignalKind>().notNull(),action:text('action').notNull(),area:text('area').notNull(),
 role:text('role').$type<LearningRole>().notNull(),locale:text('locale').$type<LearningLocale>().notNull(),
 proposalId:uuid('proposal_id'),byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_learning_signal_tenant_id_record_id_signal_key_key').on(t.tenantId,t.recordId,t.signalKey)]);

export const terasLearningSignalReview=pgTable('teras_learning_signal_review',{
 id:id(),tenantId:tenantId(),companyId:companyId(),signalId:uuid('signal_id').notNull().references(()=>terasLearningSignal.id),
 decision:text('decision').$type<ReviewDecision>().notNull(),version:integer('version').notNull(),
 byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_learning_signal_review_tenant_id_signal_id_version_key').on(t.tenantId,t.signalId,t.version)]);

export const terasGapOccurrence=pgTable('teras_gap_occurrence',{
 id:id(),tenantId:tenantId(),companyId:companyId(),recordId:uuid('record_id').notNull(),
 kind:text('kind').$type<GapKind>().notNull(),area:text('area').notNull(),intentKey:text('intent_key').notNull(),
 role:text('role').$type<LearningRole>().notNull(),locale:text('locale').$type<LearningLocale>().notNull(),at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_gap_occurrence_tenant_id_record_id_key').on(t.tenantId,t.recordId)]);

export const terasGapExample=pgTable('teras_gap_example',{
 id:id(),tenantId:tenantId(),companyId:companyId(),recordId:uuid('record_id').notNull(),intentKey:text('intent_key').notNull(),
 text:text('text').notNull(),redactionVersion:integer('redaction_version').notNull(),at:at('at').notNull().defaultNow(),
 /** Stamped by the 0972 trigger from the tenant's "Keep chats for"; any value the writer gives is replaced. */
 expiresAt:at('expires_at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_gap_example_tenant_id_record_id_key').on(t.tenantId,t.recordId)]);

export const terasGapStatus=pgTable('teras_gap_status',{
 id:id(),tenantId:tenantId(),companyId:companyId(),intentKey:text('intent_key').notNull(),status:text('status').$type<GapStatus>().notNull(),
 duplicateOf:text('duplicate_of'),version:integer('version').notNull(),byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),
 at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_gap_status_tenant_id_company_id_intent_key_version_key').on(t.tenantId,t.companyId,t.intentKey,t.version)]);

export const terasEvalCandidate=pgTable('teras_eval_candidate',{
 id:id(),tenantId:tenantId(),companyId:companyId(),signalId:uuid('signal_id').references(()=>terasLearningSignal.id),intentKey:text('intent_key'),
 role:text('role').$type<LearningRole>().notNull(),locale:text('locale').$type<LearningLocale>().notNull(),
 kind:text('kind').$type<EvalKind>().notNull(),factor:text('factor').$type<EvalFactor>().notNull(),
 question:text('question').notNull(),expectation:text('expectation').notNull(),redactionVersion:integer('redaction_version').notNull(),
 state:text('state').$type<CandidateState>().notNull().default('draft'),version:integer('version').notNull().default(1),
 createdByUserId:uuid('created_by_user_id').notNull().references(()=>appUser.id),createdAt:at('created_at').notNull().defaultNow(),
 changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),changedAt:at('changed_at').notNull().defaultNow(),
 approvedByUserId:uuid('approved_by_user_id').references(()=>appUser.id),approvedAt:at('approved_at'),
 exportedByUserId:uuid('exported_by_user_id').references(()=>appUser.id),exportedAt:at('exported_at'),
});
