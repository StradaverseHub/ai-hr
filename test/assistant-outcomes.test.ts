import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { ACTION_PROCESS, assistantOutcomes, comparisonPeriods, per30 } from '../core/assistant-outcomes';
import { AGENT_CAPABILITY_INVENTORY, agentBacklogByTier, agentCapabilityCoverage } from '../lib/ai/agent-capability-inventory';
import { NATIVE_REVIEW_ACTIONS } from '../lib/ai/module-native-outcomes';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);

describe('pure rules', () => {
  it('compares equal periods either side of first use, clipped to the window', () => {
    const now = new Date('2026-10-29T00:00:00Z'), from = new Date('2026-07-31T00:00:00Z');
    const recent = comparisonPeriods(new Date('2026-10-09T00:00:00Z'), from, now);
    expect(recent.days).toBe(20);
    expect(recent.after.from.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    expect(recent.before.from.toISOString()).toBe('2026-09-19T00:00:00.000Z');
    expect(recent.before.to.toISOString()).toBe('2026-10-09T00:00:00.000Z');
    // First use older than the window: after is the window, before ends at first use.
    const older = comparisonPeriods(new Date('2026-05-01T00:00:00Z'), from, now);
    expect(older.after.from.toISOString()).toBe(from.toISOString());
    expect(older.before.to.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(older.before.to.getTime() - older.before.from.getTime()).toBe(older.days * DAY);
    expect(per30(12, 20)).toBe(18);
    expect(per30(5, 0)).toBe(0);
  });

  it('maps only real reviewable kinds to processes', () => {
    for (const action of Object.keys(ACTION_PROCESS)) expect(NATIVE_REVIEW_ACTIONS).toContain(action);
  });

  it('splits the backlog by tier without losing or inventing entries', () => {
    const tiers = agentBacklogByTier(), coverage = agentCapabilityCoverage();
    expect(tiers.automatic + tiers.confirm + tiers.approve).toBe(coverage.backlog);
    const total = Object.values(AGENT_CAPABILITY_INVENTORY).reduce((n, e) => n + Object.keys(e).length, 0);
    expect(Object.values(coverage).reduce((n, v) => n + v, 0)).toBe(total);
  });

  it('has the outcome copy in all six locales with the same keys and placeholders', () => {
    const read = (l: string) => JSON.parse(readFileSync(join(process.cwd(), 'messages', `${l}.json`), 'utf8')).processAssessment.outcomes as Record<string, string>;
    const en = read('en'), slots = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort();
    for (const l of ['ms', 'zh', 'ta', 'vi', 'th']) {
      const copy = read(l);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(en)) { expect(copy[k].trim()).not.toBe(''); expect(slots(copy[k])).toEqual(slots(v)); }
    }
  });
});

describe('Assistant outcome measurement (ADR-0151 §4.6c)', () => {
  let base: Base;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); });
  afterAll(closeAll);

  const group = () => ({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] });
  const scoped = (companyId: string) => ({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId }] });

  async function employee() {
    const hired = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Outcome fixture', primaryEmail: `outcome-${randomUUID()}@example.test` },
      companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2024-01-01', paymentMethod: 'bank_transfer',
    } as never);
    return { ...hired, userId: await createAppUser(base.tenantId, hired.personId, 'employee'), companyId: base.companyId };
  }

  async function leave(employmentId: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled', created: Date) {
    const [row] = await owner.db.insert(schema.leaveRequest).values({ tenantId: base.tenantId, employmentId, leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-01-05', endDate: '2026-01-05', days: '1', status, createdAt: created,
      decidedAt: status === 'pending' ? null : new Date(created.getTime() + 3_600_000) }).returning({ id: schema.leaveRequest.id });
    return row.id;
  }

  async function event(aggregateId: string, eventType: string, actorId: string | null, employmentId: string, at = new Date()) {
    const [row] = await owner.db.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'leave-request', aggregateId,
      eventType, actorType: actorId ? 'user' : 'system', actorId, subjectEmploymentId: employmentId, occurredAt: at }).returning({ id: schema.domainEvent.id });
    return row.id;
  }

  type Review = { kind: string; state: 'awaiting_confirmation' | 'discarded' | 'expired' | 'refused' | 'completed'; created: Date;
    expires?: Date; leaveRequestId?: string; submissionEventId?: string; subjectId?: string; receiptEventId?: string; tenantWide?: boolean };
  async function review(who: Awaited<ReturnType<typeof employee>>, r: Review) {
    const digest = r.state === 'awaiting_confirmation' ? 'a'.repeat(64) : null;
    const subjectKind = r.kind === 'claims.cancel' ? 'claim_request' : ['leave.cancel', 'leave.edit'].includes(r.kind) ? 'leave_request' : null;
    await owner.db.execute(sql`insert into app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,
        intent_digest,reviewed_digest,state,created_at,expires_at,leave_request_id,submission_event_id,receipt_subject_kind,receipt_subject_id,receipt_event_id)
      values(${r.kind},${randomUUID()},${base.tenantId},${who.userId},${r.tenantWide ? null : who.personId},${r.tenantWide ? null : who.employmentId},
        ${r.tenantWide ? null : who.companyId},${digest},${digest},${r.state},${r.created.toISOString()}::timestamptz,
        ${(r.expires ?? new Date(r.created.getTime() + 600_000)).toISOString()}::timestamptz,
        ${r.leaveRequestId ?? null},${r.submissionEventId ?? null},${subjectKind},${r.subjectId ?? null},${r.receiptEventId ?? null})`);
  }

  it('counts each kind by what happened, treats an unswept past-expiry review as expired, and keeps the window', async () => {
    const e = await employee();
    const approved = await leave(e.employmentId, 'approved', ago(5 * DAY));
    const rejected = await leave(e.employmentId, 'rejected', ago(4 * DAY));
    await review(e, { kind: 'leave.apply', state: 'completed', created: ago(5 * DAY), leaveRequestId: approved, submissionEventId: randomUUID() });
    await review(e, { kind: 'leave.apply', state: 'completed', created: ago(4 * DAY), leaveRequestId: rejected, submissionEventId: randomUUID() });
    await review(e, { kind: 'leave.apply', state: 'discarded', created: ago(3 * DAY) });
    await review(e, { kind: 'leave.apply', state: 'refused', created: ago(3 * DAY) });
    await review(e, { kind: 'leave.apply', state: 'awaiting_confirmation', created: ago(DAY), expires: ago(DAY - 600_000) });
    await review(e, { kind: 'leave.apply', state: 'awaiting_confirmation', created: ago(60_000), expires: new Date(Date.now() + 540_000) });
    // Outside a 30-day window, but it is the first use.
    await review(e, { kind: 'leave.apply', state: 'expired', created: ago(60 * DAY) });
    const pending = await leave(e.employmentId, 'pending', ago(2 * DAY));
    await review(e, { kind: 'leave.cancel', state: 'completed', created: ago(2 * DAY), subjectId: pending, receiptEventId: randomUUID() });

    const view = await assistantOutcomes(group(), 30);
    const apply = view.actions.find(a => a.action === 'leave.apply')!;
    expect(apply).toMatchObject({ prepared: 6, completed: 2, discarded: 1, refused: 1, expired: 1, awaiting: 1, reversed: 1 });
    expect(apply.firstPreparedAt!.getTime()).toBeLessThan(ago(59 * DAY).getTime());
    // A withdrawal cannot be proved undone: no figure rather than zero.
    expect(view.actions.find(a => a.action === 'leave.cancel')).toMatchObject({ prepared: 1, completed: 1, reversed: null });
    // Every catalogue kind is present, used or not.
    for (const kind of NATIVE_REVIEW_ACTIONS) expect(view.actions.some(a => a.action === kind)).toBe(true);
    expect(view.actions.find(a => a.action === 'claims.submit')).toMatchObject({ prepared: 0, reversed: null, firstPreparedAt: null });
  });

  it('proves an edit undone only from a later edit or withdrawal of the same leave', async () => {
    const e = await employee();
    const stood = await leave(e.employmentId, 'pending', ago(3 * DAY)), changed = await leave(e.employmentId, 'pending', ago(3 * DAY));
    const r1 = await event(stood, 'leave-request.edited', e.userId, e.employmentId, ago(2 * DAY));
    const r2 = await event(changed, 'leave-request.edited', e.userId, e.employmentId, ago(2 * DAY));
    await event(stood, 'leave-request.step.approved', base.adminUserId, e.employmentId, ago(DAY));
    await event(changed, 'leave-request.self-cancelled', e.userId, e.employmentId, ago(DAY));
    await review(e, { kind: 'leave.edit', state: 'completed', created: ago(2 * DAY), subjectId: stood, receiptEventId: r1 });
    await review(e, { kind: 'leave.edit', state: 'completed', created: ago(2 * DAY), subjectId: changed, receiptEventId: r2 });
    const view = await assistantOutcomes(group(), 30);
    expect(view.actions.find(a => a.action === 'leave.edit')).toMatchObject({ completed: 2, reversed: 1 });
  });

  it('counts only companies the caller administers, and tenant-wide rows only for a group administrator', async () => {
    const [other] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Other Sdn Bhd', country: 'MY' })
      .returning({ id: schema.company.id });
    const here = await employee();
    // The definer scopes by the review row's company; one fictional employment stands in for both.
    const there = { ...here, companyId: other.id };
    await review(here, { kind: 'leave.apply', state: 'discarded', created: ago(DAY) });
    await review(there, { kind: 'leave.apply', state: 'discarded', created: ago(DAY) });
    await review(there, { kind: 'leave.apply', state: 'refused', created: ago(DAY) });
    await review(here, { kind: 'knowledge_base.article.create', state: 'discarded', created: ago(DAY), tenantWide: true });

    const count = async (ctx: SessionContext) => {
      const v = await assistantOutcomes(ctx, 30);
      return { apply: v.actions.find(a => a.action === 'leave.apply')!.prepared, kb: v.actions.find(a => a.action === 'knowledge_base.article.create')!.prepared };
    };
    expect(await count(group())).toEqual({ apply: 3, kb: 1 });
    expect(await count(scoped(base.companyId))).toEqual({ apply: 1, kb: 0 });
    expect(await count(scoped(other.id))).toEqual({ apply: 2, kb: 0 });
    // Another tenant's administrator sees nothing of this tenant.
    const foreign = await seedBase();
    const v = await assistantOutcomes({ ...adminCtx(foreign), grants: [{ role: 'hr_admin', companyId: null }] }, 30);
    expect(v.actions.every(a => a.prepared === 0)).toBe(true);
  });

  it('refuses a non-administrator in code and in the database', async () => {
    const e = await employee();
    const ctx = { tenantId: base.tenantId, userId: e.userId, roles: ['employee'], entitlements: adminCtx(base).entitlements,
      grants: [{ role: 'employee', companyId: null }] };
    await expect(assistantOutcomes(ctx, 30)).rejects.toThrow(/administrators/);
    await expect(withTenant(ctx, tx => tx.execute(sql`select * from app.assistant_action_outcome_summary(now() - interval '1 day')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('gives each process with Assistant use a before and after in staff actions per 30 days', async () => {
    const e = await employee();
    // Before first use (20 days ago): three cases, each decided by HR. After: one case decided by HR.
    for (const d of [35, 30, 25]) { const id = await leave(e.employmentId, 'approved', ago(d * DAY)); await event(id, 'leave-request.approved', base.adminUserId, e.employmentId, ago(d * DAY)); }
    const later = await leave(e.employmentId, 'approved', ago(10 * DAY));
    await event(later, 'leave-request.approved', base.adminUserId, e.employmentId, ago(10 * DAY));
    await review(e, { kind: 'leave.apply', state: 'completed', created: ago(20 * DAY), leaveRequestId: later, submissionEventId: randomUUID() });

    const view = await assistantOutcomes(group(), 90);
    const leaveCmp = view.processes.find(p => p.id === 'leave')!;
    expect(leaveCmp.firstUse).not.toBeNull();
    expect(leaveCmp.before).toMatchObject({ started: 3, staffActions: 3 });
    expect(leaveCmp.after).toMatchObject({ started: 1, staffActions: 1 });
    expect(leaveCmp.before!.per30).toBeCloseTo(4.5, 0);
    expect(leaveCmp.assistantCompleted).toBe(1);
    expect(leaveCmp.early).toBe(false);
    // No Assistant use for claims: no comparison is invented.
    expect(view.processes.find(p => p.id === 'claims')).toMatchObject({ firstUse: null, before: null, after: null });
  });
});
