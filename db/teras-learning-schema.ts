/** AI v2 Phase 2, P2-6 — Drizzle declarations of the learning loops (migration 2010, first numbered 0972): signals, their
 * reviews, gap occurrences (with the asker's private counted-turn notes) and statuses, and eval candidates. No chat words
 * (AI v2 Phase 2 hardening: the redacted gap examples are gone).
 *
 * WHY NOT db/teras-schema.ts. That file is inside the approved provider-data source closure
 * (scripts/ai-provider-data-source-manifest.mjs), so any edit there changes the approved digest. These tables are part of no
 * provider request: they are declared here and imported only by core/learning/* and tests (the db/teras-capacity-schema.ts
 * precedent). Fold into db/schema.ts when the next approval of that closure is taken.
 *
 * Signals, reviews, counted-turn notes, gap occurrences and statuses are append-only (a trigger refuses UPDATE and DELETE).
 * A candidate is updated in place, every change the next version (a trigger checks it). */
import {sql} from 'drizzle-orm';
import {date,integer,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,tenant} from './schema';
import type {AnswerReason,CandidateState,EvalFactor,EvalKind,GapKind,GapStatus,LearningLocale,LearningRole,ReviewDecision,SignalKind} from '../core/learning/types';

const id=()=>uuid('id').primaryKey().defaultRandom();
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);
const companyId=()=>uuid('company_id').notNull().references(()=>company.id);
const at=(name:string)=>timestamp(name,{withTimezone:true});

export const terasLearningSignal=pgTable('teras_learning_signal',{
 id:id(),tenantId:tenantId(),companyId:companyId(),recordId:uuid('record_id').notNull(),signalKey:text('signal_key').notNull(),
 kind:text('kind').$type<SignalKind>().notNull(),action:text('action').notNull(),area:text('area').notNull(),
 role:text('role').$type<LearningRole>().notNull(),locale:text('locale').$type<LearningLocale>().notNull(),
 proposalId:uuid('proposal_id'),
 /** A "Not helpful" mark's optional reason, added once by the person (0972's column grant and trigger). */
 reason:text('reason').$type<AnswerReason>(),
 byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_learning_signal_tenant_id_record_id_signal_key_key').on(t.tenantId,t.recordId,t.signalKey)]);

export const terasLearningSignalReview=pgTable('teras_learning_signal_review',{
 id:id(),tenantId:tenantId(),companyId:companyId(),signalId:uuid('signal_id').notNull().references(()=>terasLearningSignal.id),
 decision:text('decision').$type<ReviewDecision>().notNull(),version:integer('version').notNull(),
 byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),at:at('at').notNull().defaultNow(),
},t=>[uniqueIndex('teras_learning_signal_review_tenant_id_signal_id_version_key').on(t.tenantId,t.signalId,t.version)]);

/** The asker's private note that a turn was counted as a gap: only the login that wrote it can read it (2010), so the
 * record it names never reaches an administrator. A turn counts once (its key). */
export const terasGapTurn=pgTable('teras_gap_turn',{
 tenantId:tenantId(),recordId:uuid('record_id').notNull(),companyId:companyId(),byUserId:uuid('by_user_id').notNull().references(()=>appUser.id),
 /** The intent the turn was counted under: the asker's own note only; app.teras_gap_detailed_intents counts distinct askers
  * per intent for the small-group rule and returns intent keys, never a login (2010, Phase 2 integration). */
 intentKey:text('intent_key').notNull(),
 /** Stamped by the 2010 trigger with the transaction's time; the occurrence's insert policy matches on it. */
 at:at('at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.recordId]})]);

/** One gap, read by the company's administrators: no words, no login, no record and no time finer than the Malaysian day. */
export const terasGapOccurrence=pgTable('teras_gap_occurrence',{
 id:id(),tenantId:tenantId(),companyId:companyId(),
 kind:text('kind').$type<GapKind>().notNull(),area:text('area').notNull(),intentKey:text('intent_key').notNull(),
 role:text('role').$type<LearningRole>().notNull(),locale:text('locale').$type<LearningLocale>().notNull(),
 /** The Malaysian day it was counted (YYYY-MM-DD), stamped by the 2010 trigger. */
 seenOn:date('seen_on').notNull().default(sql`(now() at time zone 'Asia/Kuala_Lumpur')::date`),
});

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
