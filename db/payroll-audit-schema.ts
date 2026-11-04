/** AI v2 P2-2b — Drizzle declarations for the payroll Audit loop (migration 0965).
 *
 * A separate file for the same reason as db/teras-schema.ts: db/schema.ts sits inside the approved provider-data source
 * closure, and nothing in that closure imports this file. The hashes, sequence and link columns are computed by the
 * database (app.payroll_audit_capture_chain_tg, app.payroll_audit_finding_hash_tg); a writer never supplies them. */
import {sql} from 'drizzle-orm';
import {index,integer,jsonb,numeric,pgTable,primaryKey,text,timestamp,uniqueIndex,uuid} from 'drizzle-orm/pg-core';
import {appUser,company,tenant} from './schema';
import type {AuditCaptureKind,AuditControlId,AuditDisposition,AuditRootCause} from '../core/payroll-audit/types';

const id=()=>uuid('id').primaryKey().defaultRandom();
const tenantId=()=>uuid('tenant_id').notNull().references(()=>tenant.id);
const at=(name:string)=>timestamp(name,{withTimezone:true});

export const payrollAuditReader=pgTable('payroll_audit_reader',{
 id:id(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 appUserId:uuid('app_user_id').notNull().references(()=>appUser.id),grantedByUserId:uuid('granted_by_user_id').notNull().references(()=>appUser.id),
 grantedAt:at('granted_at').notNull().defaultNow(),revokedAt:at('revoked_at'),revokedByUserId:uuid('revoked_by_user_id').references(()=>appUser.id),
},t=>[uniqueIndex('payroll_audit_reader_current_uq').on(t.tenantId,t.companyId,t.appUserId).where(sql`revoked_at IS NULL`)]);

export const payrollAuditCapture=pgTable('payroll_audit_capture',{
 id:id(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),payPeriod:text('pay_period').notNull(),
 batchId:uuid('batch_id'),seq:integer('seq').notNull().default(0),kind:text('kind').$type<AuditCaptureKind>().notNull(),
 sourceKey:text('source_key').notNull(),content:jsonb('content').$type<Record<string,unknown>>().notNull(),
 contentHash:text('content_hash').notNull().default(''),prevHash:text('prev_hash').notNull().default(''),chainHash:text('chain_hash').notNull().default(''),
 capturedAt:at('captured_at').notNull().defaultNow(),writer:text('writer').$type<'agent'|'user'>().notNull(),writerId:uuid('writer_id').notNull(),
 runId:uuid('run_id'),
},t=>[uniqueIndex('payroll_audit_capture_seq_uq').on(t.tenantId,t.companyId,t.payPeriod,t.seq),
 index('payroll_audit_capture_key_idx').on(t.tenantId,t.companyId,t.payPeriod,t.sourceKey,t.seq.desc()),
 index('payroll_audit_capture_batch_idx').on(t.tenantId,t.batchId)]);

export const payrollAuditFinding=pgTable('payroll_audit_finding',{
 id:id(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),payPeriod:text('pay_period').notNull(),
 batchId:uuid('batch_id'),employmentId:uuid('employment_id'),controlId:text('control_id').$type<AuditControlId>().notNull(),
 subjectKey:text('subject_key').notNull(),evidence:jsonb('evidence').$type<Record<string,unknown>>().notNull(),
 evidenceHash:text('evidence_hash').notNull().default(''),
 /** The logins the finding is about, derived by the database from the evidence (Phase 2 hardening); none may dispose of it. */
 subjectUserIds:uuid('subject_user_ids').array().notNull().default(sql`'{}'::uuid[]`),detectedAt:at('detected_at').notNull().defaultNow(),
 writer:text('writer').$type<'agent'|'user'>().notNull(),writerId:uuid('writer_id').notNull(),runId:uuid('run_id'),
},t=>[uniqueIndex('payroll_audit_finding_tenant_id_control_id_subject_key_key').on(t.tenantId,t.controlId,t.subjectKey),
 index('payroll_audit_finding_company_idx').on(t.tenantId,t.companyId,t.payPeriod)]);

export const payrollAuditDisposition=pgTable('payroll_audit_disposition',{
 id:id(),tenantId:tenantId(),findingId:uuid('finding_id').notNull(),companyId:uuid('company_id').notNull().references(()=>company.id),
 disposition:text('disposition').$type<AuditDisposition>().notNull(),note:text('note').notNull(),
 disposedByUserId:uuid('disposed_by_user_id').notNull().references(()=>appUser.id),disposedAt:at('disposed_at').notNull().defaultNow(),
},t=>[index('payroll_audit_disposition_finding_idx').on(t.tenantId,t.findingId,t.disposedAt)]);

export const payrollAuditCorrectionCause=pgTable('payroll_audit_correction_cause',{
 id:id(),tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),payPeriod:text('pay_period').notNull(),
 batchId:uuid('batch_id').notNull(),correctionKey:text('correction_key').notNull(),rootCause:text('root_cause').$type<AuditRootCause>().notNull(),
 note:text('note').notNull(),recordedByUserId:uuid('recorded_by_user_id').notNull().references(()=>appUser.id),recordedAt:at('recorded_at').notNull().defaultNow(),
},t=>[index('payroll_audit_correction_cause_idx').on(t.tenantId,t.companyId,t.payPeriod,t.correctionKey)]);

export const payrollAuditControlSetting=pgTable('payroll_audit_control_setting',{
 tenantId:tenantId(),companyId:uuid('company_id').notNull().references(()=>company.id),
 bankChangeDays:integer('bank_change_days').notNull().default(7),adjustmentThreshold:numeric('adjustment_threshold',{precision:12,scale:2}).notNull().default('1000.00'),
 /** Phase 2 hardening: whether "one login both processed and closed a run" opens a finding or is information only. */
 preparerClosedMode:text('preparer_closed_mode').$type<'info'|'finding'>().notNull().default('info'),
 version:integer('version').notNull().default(1),changedByUserId:uuid('changed_by_user_id').notNull().references(()=>appUser.id),
 changedAt:at('changed_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.tenantId,t.companyId]})]);
