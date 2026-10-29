/**
 * WP13 (architecture review R18; ADR-0151 §4.4-4.5; owner decisions 1-2, 29 Oct 2026) — the first Automatic-tier
 * entries, run by the tenant's named agent principal (0672) with no model call.
 *
 *  1. Selection: only items overdue at their current stage are chased, and only their current approver is told.
 *  2. Cooldown and caps: no second reminder within the cooldown; a lifetime cap per (item, stage); a cap per run.
 *  3. Isolation: another company's HR is never told; another tenant's items are invisible; a foreign principal is nothing.
 *  4. Refusal: a non-agent context, a switched-off, unattributed, killed or re-switched specialist, a missing
 *     notifications module, and an unstamped chase event are all refused.
 *  5. No model call, ever.
 *  6. Idempotent: a re-run or a concurrent run writes one reminder per item.
 *  7. Outcomes: the admin outcome view counts reminders, items acted on since and items still waiting, by scope.
 * Fictional fixtures only.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../lib/ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/ai')>();
  return { ...original,
    generateDraft: async () => { model.calls++; throw new Error('No model call is allowed under the agent principal.'); },
    converse: async () => { model.calls++; throw new Error('No model call is allowed under the agent principal.'); } };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { resolveEntitlementsTx } from '../core/entitlements';
import { agentContext, agentStamp, agentSwitchStatesTx, attributedEnablements, ensureAgentPrincipal } from '../core/agent-principal';
import { AutomaticChaserRefusal, APPROVAL_CHASE_EVENT, REVIEW_CHASE_EVENT, engineWorkingDayCalendar, runApprovalChasers } from '../core/automatic-chasers';
import { checkIn, checkOut, decideAttendanceCorrection, requestAttendanceCorrection } from '../core/attendance';
import { saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import {setAgentActionPause} from '../core/ai-inventory';
import { assertAiActionUnpausedTx } from '../core/ai-governance';
import { runAutomaticChasers } from '../core/hr-orchestrator';
import { dispatchNotifications } from '../core/notifications';
import { assistantOutcomes } from '../core/assistant-outcomes';
import { addDaysIso } from '../core/leave-escalation';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const APPROVALS = 'notifications.approval_chasers_enabled';
const REVIEWS = 'notifications.review_chasers_enabled';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function pgText(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e as Record<string, unknown> | undefined, n = 0; cur && typeof cur === 'object' && n < 5; cur = cur.cause as never, n++)
    for (const k of ['message', 'detail', 'code']) if (typeof cur[k] === 'string') parts.push(cur[k] as string);
  return parts.join(' | ');
}

describe('WP13 Automatic-tier chasers under the agent principal', () => {
  let base: Base;
  let seq = 0;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); seq = 0; model.calls = 0; vi.unstubAllEnvs(); });
  afterAll(closeAll);

  async function hire(b: Base, companyId = b.companyId, departmentId = b.deptA) {
    seq++;
    return hireEmployee(adminCtx(b), {
      person: { fullName: `Chaser fixture ${seq}`, primaryEmail: `chaser.${seq}.${b.tenantId.slice(0, 8)}@example.test` },
      companyId, departmentId, employmentType: 'full_time', hiredOn: '2024-01-01', paymentMethod: 'cash',
    } as never);
  }
  const reportsTo = (b: Base, subordinate: string, manager: string) => owner.db.insert(schema.reportingLine).values({
    tenantId: b.tenantId, subordinateEmploymentId: subordinate, managerEmploymentId: manager, lineType: 'administrative', validFrom: '2020-01-01' });
  /** An administrator switches a specialist on: the setting plus the change event setTenantSetting writes. */
  async function switchEvent(b: Base, key: string, value: boolean, userId: string | null = b.adminUserId) {
    await owner.db.insert(schema.domainEvent).values({ tenantId: b.tenantId, aggregateType: 'tenant-setting', aggregateId: b.tenantId,
      eventType: 'tenant-setting.changed', actorType: userId ? 'user' : 'system', actorId: userId, payload: { key, value } });
    await setSetting(b.tenantId, key, value);
  }
  /** The working-day clock, read by an engine (non-agent) context as the nightly sweep does. */
  const calendar = (b: Base = base) => engineWorkingDayCalendar(adminCtx(b));
  async function agent(b: Base = base): Promise<SessionContext> {
    const principalId = await ensureAgentPrincipal(owner.db, b.tenantId);
    const entitlements = await owner.db.transaction(tx => resolveEntitlementsTx(tx, b.tenantId));
    const bare = agentContext(b.tenantId, principalId, entitlements);
    const enablements = attributedEnablements(await withTenant(bare, tx => agentSwitchStatesTx(tx, bare)));
    return agentContext(b.tenantId, principalId, entitlements, enablements);
  }
  async function claim(b: Base, employmentId: string, createdAt: Date, status: 'pending' | 'approved' = 'pending') {
    const [type] = await owner.db.insert(schema.claimType).values({ tenantId: b.tenantId, code: `FICT${++seq}`, name: 'Fictional travel' }).returning();
    const [row] = await owner.db.insert(schema.claimRequest).values({ tenantId: b.tenantId, employmentId, claimTypeId: type.id, amount: '312.50',
      incurredOn: '2026-01-05', description: 'Fictional secret description', status, createdAt }).returning();
    return row.id;
  }
  async function correction(b: Base, employmentId: string, createdAt: Date) {
    const [row] = await owner.db.insert(schema.attendanceCorrection).values({ tenantId: b.tenantId, employmentId, attendanceDate: `2026-02-${String(10 + (++seq % 15)).padStart(2, '0')}`,
      proposedCheckIn: '09:00:00', reason: 'Fictional reason', status: 'pending', createdAt } as never).returning();
    return row.id;
  }
  async function replacement(b: Base, employmentId: string, createdAt: Date) {
    const [row] = await owner.db.insert(schema.replacementLeaveRequest).values({ tenantId: b.tenantId, employmentId, unit: 'day',
      submittedOn: '2026-01-05', status: 'pending', reason: 'Fictional reason', createdAt }).returning();
    return row.id;
  }
  async function review(b: Base, who: { employmentId: string; personId: string }, endDate: string, status: 'pending_manager' | 'pending_hr', managerEmploymentId: string | null) {
    const { employmentId, personId } = who;
    const [row] = await owner.db.insert(schema.employmentReview).values({ tenantId: b.tenantId, employmentId, personId, reviewType: 'probation', status,
      endDate, dueDate: addDaysIso(endDate, -30), managerEmploymentId } as never).returning();
    return row.id;
  }
  const chaseEvents = (b: Base = base) => owner.db.select().from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), inArray(schema.domainEvent.eventType, [APPROVAL_CHASE_EVENT, REVIEW_CHASE_EVENT])))
    .orderBy(schema.domainEvent.sequence);
  const notificationsFor = (eventIds: string[]) => eventIds.length ? owner.db.select().from(schema.notification)
    .where(inArray(schema.notification.sourceEventId, eventIds)) : Promise.resolve([]);

  /** Company A: subject E reports to manager M; H is a group HR admin employed in A. */
  async function fixture() {
    await setModule(base.tenantId, 'notifications', 'active');
    const E = await hire(base), M = await hire(base), H = await hire(base);
    await reportsTo(base, E.employmentId, M.employmentId);
    await createAppUser(base.tenantId, H.personId, 'hr_admin');
    return { E, M, H };
  }

  it('chases only items overdue at their current stage, to their current approver, with ids and dates only', async () => {
    const { E, M, H } = await fixture();
    const overdueClaim = await claim(base, E.employmentId, daysAgo(10));
    const freshClaim = await claim(base, E.employmentId, daysAgo(1));
    await claim(base, E.employmentId, daysAgo(10), 'approved');
    const laterDecided = await claim(base, E.employmentId, daysAgo(9));
    const att = await correction(base, E.employmentId, daysAgo(10));
    const toil = await replacement(base, E.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    const result = await runApprovalChasers(await agent(), { calendar: calendar() });
    expect(result).toMatchObject({ disabled: false, stopped: false, sent: 4 });
    expect(result.byAction['approvals.claim.chase']).toMatchObject({ sent: 2, cooled: 0, exhausted: 0, changed: 0, cappedOut: false });
    const events = await chaseEvents();
    expect(events.map(e => e.aggregateId).sort()).toEqual([overdueClaim, laterDecided, att, toil].sort());
    expect(events.map(e => e.aggregateId)).not.toContain(freshClaim);
    const principalId = await ensureAgentPrincipal(owner.db, base.tenantId);
    for (const e of events) {
      expect(e).toMatchObject({ actorType: 'agent', actorId: principalId, aggregateType: 'automatic-chase', subjectEmploymentId: E.employmentId });
      const p = e.payload as Record<string, unknown>;
      expect(p).toMatchObject({ companyId: base.companyId, chaseNumber: 1, agent: { principalId, enabledBy: [{ feature: 'approval_chasers', userId: base.adminUserId }] } });
      // Only ids, stage and dates: no amount, description, reason or name leaves the source.
      expect(Object.keys(p).sort()).toEqual(['action','source','stage','companyId','waitingOn','workingDaysWaiting','chaseNumber','agent'].sort());
      expect(JSON.stringify(p)).not.toMatch(/312\.50|Fictional|secret|Chaser fixture/);
    }
    // The approver acts on one claim after the sweep: the registry re-checks at dispatch and tells nobody.
    await owner.db.update(schema.claimRequest).set({ status: 'approved' }).where(eq(schema.claimRequest.id, laterDecided));
    await dispatchNotifications(adminCtx(base));
    const sent = await notificationsFor(events.map(e => e.id));
    expect(sent.map(n => n.recipientEmploymentId)).toEqual([M.employmentId, M.employmentId, M.employmentId]);
    expect(sent.map(n => n.kind).sort()).toEqual(['attendance.approval-overdue', 'claim.approval-overdue', 'toil.approval-overdue']);
    expect(sent.some(n => n.recipientEmploymentId === E.employmentId || n.recipientEmploymentId === H.employmentId)).toBe(false);
    for (const n of sent) { expect(n.body).toMatch(/waiting for your decision for \d+ working day/); expect(n.body).not.toMatch(/312|Fictional/); expect(n.linkPath).toBe('/approvals'); }
    expect(model.calls).toBe(0);
  });

  it('chases matching stand-ins for claims, unrouted attendance and replacement leave, with no model call',async()=>{
    const {E,M}=await fixture(),stand=await hire(base),report=await hire(base);
    await reportsTo(base,report.employmentId,stand.employmentId);
    await createAppUser(base.tenantId,stand.personId,'manager');
    const [line]=await owner.db.insert(schema.reportingLine).values({tenantId:base.tenantId,subordinateEmploymentId:M.employmentId,managerEmploymentId:stand.employmentId,lineType:'delegate',validFrom:'2020-01-01'}).returning({id:schema.reportingLine.id});
    await claim(base,E.employmentId,daysAgo(10));await correction(base,E.employmentId,daysAgo(10));await replacement(base,E.employmentId,daysAgo(10));
    await switchEvent(base,APPROVALS,true);await runApprovalChasers(await agent(),{calendar:calendar()});
    await dispatchNotifications(adminCtx(base));
    const events=await chaseEvents();expect(events).toHaveLength(3);
    for(const event of events)expect((await notificationsFor([event.id])).map(n=>n.recipientEmploymentId).sort()).toEqual([M.employmentId,stand.employmentId].sort());
    expect(model.calls).toBe(0);
    // A matching task is required even on reminders. Retired receipts remain, so use a new overdue item.
    await owner.db.insert(schema.reportingLineScope).values({tenantId:base.tenantId,reportingLineId:line.id,module:'leave',taskType:'leave.application'});
    const second=await claim(base,E.employmentId,daysAgo(10));await runApprovalChasers(await agent(),{calendar:calendar()});await dispatchNotifications(adminCtx(base));
    const [last]=(await chaseEvents()).filter(e=>e.aggregateId===second);
    expect((await notificationsFor([last.id])).map(n=>n.recipientEmploymentId)).toEqual([M.employmentId]);
  });

  it('falls back to the company HR when the subject has no manager, and never tells another company or tenant', async () => {
    const { H } = await fixture();
    const [companyB] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Two Sdn Bhd' }).returning();
    const [deptB] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: companyB.id, name: 'Fictional ops' }).returning();
    const HB = await hire(base, companyB.id, deptB.id);
    const [hbUser] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: `user_fict_${seq}`, personId: HB.personId }).returning();
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: hbUser.id, companyId: companyB.id, role: 'hr_admin' });
    const lonelyA = await hire(base), lonelyB = await hire(base, companyB.id, deptB.id);
    const claimA = await claim(base, lonelyA.employmentId, daysAgo(10));
    const claimB = await claim(base, lonelyB.employmentId, daysAgo(10));
    // Another tenant with its own overdue claim and its own switched-on principal.
    const other = await seedBase();
    await setModule(other.tenantId, 'notifications', 'active');
    const foreign = await hire(other, other.companyId, other.deptA);
    const foreignClaim = await claim(other, foreign.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    await switchEvent(other, APPROVALS, true);

    const ctx = await agent();
    expect((await runApprovalChasers(ctx, { calendar: calendar() })).sent).toBe(2);
    expect((await chaseEvents()).map(e => e.aggregateId).sort()).toEqual([claimA, claimB].sort());
    expect(await chaseEvents(other)).toEqual([]);
    // The source definer never returns another tenant's item, even when asked for it by id.
    const seen = await withTenant(ctx, tx => tx.execute<{ item_id: string }>(sql`select item_id from app.agent_overdue_approvals('claim', now(), array[${foreignClaim}::uuid, ${claimA}::uuid]::uuid[], 10)`));
    expect(Array.from(seen).map(r => r.item_id)).toEqual([claimA]);
    // A principal named under the wrong tenant is nothing: the definer refuses.
    const foreignPrincipal = await ensureAgentPrincipal(owner.db, other.tenantId);
    const forged = agentContext(base.tenantId, foreignPrincipal, ctx.entitlements!, ctx.agent!.enablements);
    await expect(withTenant(forged, tx => tx.execute(sql`select * from app.agent_overdue_approvals('claim', now(), null, 10)`)))
      .rejects.toSatisfy((e: unknown) => /Agent source unavailable|42501/.test(pgText(e)));

    await dispatchNotifications(adminCtx(base));
    const events = await chaseEvents();
    const byItem = new Map(events.map(e => [e.aggregateId, e.id]));
    const toA = await notificationsFor([byItem.get(claimA)!]), toB = await notificationsFor([byItem.get(claimB)!]);
    // Company A's item goes to A's HR (group grant, employed in A); company B's only to B's scoped HR.
    expect(toA.map(n => n.recipientEmploymentId)).toEqual([H.employmentId]);
    expect(toB.map(n => n.recipientEmploymentId)).toEqual([HB.employmentId]);
    // The other tenant's principal sees and chases only its own.
    expect((await runApprovalChasers(await agent(other), { calendar: calendar(other) })).sent).toBe(1);
    expect((await chaseEvents(other)).map(e => e.aggregateId)).toEqual([foreignClaim]);
  });

  it('holds a cooldown per item and stage, caps reminders per item and per run, and is idempotent under concurrency', async () => {
    const { E } = await fixture();
    const overdue = await claim(base, E.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    const ctx = await agent();
    const today = todayInKualaLumpur();
    const runs = await Promise.all([runApprovalChasers(ctx, { today, calendar: calendar() }), runApprovalChasers(ctx, { today, calendar: calendar() })]);
    expect(runs.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect((await runApprovalChasers(ctx, { today, calendar: calendar() })).byAction['approvals.claim.chase']).toMatchObject({ sent: 0, cooled: 1 });
    expect((await runApprovalChasers(ctx, { today: addDaysIso(today, 6), calendar: calendar() })).byAction['approvals.claim.chase']).toMatchObject({ sent: 0, cooled: 1 });
    // The receipts are dated today, so a later run date stands in for the cooldown passing.
    expect((await runApprovalChasers(ctx, { today: addDaysIso(today, 7), calendar: calendar() })).byAction['approvals.claim.chase']).toMatchObject({ sent: 1 });
    // Third and last reminder: age the receipts past the cooldown, then the per-item cap holds.
    await owner.db.execute(sql`update domain_event set occurred_at = occurred_at - interval '30 days' where aggregate_id = ${overdue}::uuid and event_type = ${APPROVAL_CHASE_EVENT}`);
    expect((await runApprovalChasers(ctx, { today, calendar: calendar() })).byAction['approvals.claim.chase']).toMatchObject({ sent: 1 });
    await owner.db.execute(sql`update domain_event set occurred_at = occurred_at - interval '30 days' where aggregate_id = ${overdue}::uuid and event_type = ${APPROVAL_CHASE_EVENT}`);
    expect((await runApprovalChasers(ctx, { today, calendar: calendar() })).byAction['approvals.claim.chase']).toMatchObject({ sent: 0, exhausted: 1 });
    expect((await chaseEvents()).map(e => (e.payload as { chaseNumber: number }).chaseNumber)).toEqual([1, 2, 3]);
    // Per-run cap: 100 reminders, then it stops and says so.
    const [type] = await owner.db.insert(schema.claimType).values({ tenantId: base.tenantId, code: 'BULK', name: 'Fictional bulk' }).returning();
    await owner.db.insert(schema.claimRequest).values(Array.from({ length: 101 }, () => ({ tenantId: base.tenantId, employmentId: E.employmentId,
      claimTypeId: type.id, amount: '1.00', incurredOn: '2026-01-05', status: 'pending' as const, createdAt: daysAgo(7) })));
    const capped = (await runApprovalChasers(ctx, { today, calendar: calendar() })).byAction['approvals.claim.chase'];
    expect(capped).toMatchObject({ sent: 100, cappedOut: true });
    expect(model.calls).toBe(0);
  }, 120_000);

  it('refuses outside the principal and stops when the switch is off, unattributed, killed, re-switched or the module is gone', async () => {
    const { E } = await fixture();
    await claim(base, E.employmentId, daysAgo(10));
    await expect(runApprovalChasers(adminCtx(base), { calendar: calendar() })).rejects.toBeInstanceOf(AutomaticChaserRefusal);
    await expect(runAutomaticChasers(adminCtx(base), { calendar: calendar() })).rejects.toBeInstanceOf(AutomaticChaserRefusal);
    // Off (the default).
    expect(await runApprovalChasers(await agent(), { calendar: calendar() })).toMatchObject({ disabled: 'off', sent: 0 });
    // On without a named administrator: not run.
    await switchEvent(base, APPROVALS, true, null);
    expect(await runApprovalChasers(await agent(), { calendar: calendar() })).toMatchObject({ disabled: 'off', sent: 0 });
    // Operator kill lever.
    await switchEvent(base, APPROVALS, true);
    vi.stubEnv('SETTING_KILL', APPROVALS);
    try { expect(await runApprovalChasers(await agent(), { calendar: calendar() })).toMatchObject({ disabled: 'off', sent: 0 }); } finally { vi.unstubAllEnvs(); }
    // Switched off, or off and on again, after the run started: the effect transaction refuses and the run stops.
    const stale = await agent();
    await switchEvent(base, APPROVALS, false);
    await switchEvent(base, APPROVALS, true);
    expect(await runApprovalChasers(stale, { calendar: calendar() })).toMatchObject({ stopped: true, sent: 0 });
    // Without the notifications module there is nobody to tell.
    await setModule(base.tenantId, 'notifications', 'disabled');
    expect(await runApprovalChasers(await agent(), { calendar: calendar() })).toMatchObject({ disabled: 'module_off', sent: 0 });
    expect(await chaseEvents()).toEqual([]);
    // The database refuses a chase event that does not name the chaser switch it relies on.
    await setModule(base.tenantId, 'notifications', 'active');
    await switchEvent(base, 'notifications.readiness_nudge_enabled', true);
    const readinessOnly = await agent();
    const onlyReadiness = { ...readinessOnly, agent: { ...readinessOnly.agent!, enablements: readinessOnly.agent!.enablements.filter(e => e.feature === 'readiness_reminders') } };
    await expect(withTenant(onlyReadiness, tx => tx.insert(schema.domainEvent).values({ tenantId: base.tenantId, aggregateType: 'automatic-chase',
      aggregateId: E.employmentId, eventType: APPROVAL_CHASE_EVENT, actorType: 'agent', actorId: onlyReadiness.agent.principalId, subjectEmploymentId: E.employmentId,
      payload: { action: 'approvals.claim.chase', stage: 'pending', ...agentStamp(onlyReadiness) } })))
      .rejects.toSatisfy((e: unknown) => /row-level security/i.test(pgText(e)));
    expect(model.calls).toBe(0);
  });

  it('chases a probation review undecided after its end date to its stage owner, and never a future or leaver review', async () => {
    const { E, M, H } = await fixture();
    const today = todayInKualaLumpur();
    const managerStage = await review(base, E, addDaysIso(today, -3), 'pending_manager', M.employmentId);
    const other = await hire(base);
    const hrStage = await review(base, other, addDaysIso(today, -3), 'pending_hr', null);
    const future = await hire(base);
    await review(base, future, addDaysIso(today, 5), 'pending_manager', M.employmentId);
    const leaver = await hire(base);
    await review(base, leaver, addDaysIso(today, -3), 'pending_manager', M.employmentId);
    await owner.db.update(schema.employment).set({ terminatedOn: addDaysIso(today, -1) }).where(eq(schema.employment.id, leaver.employmentId));
    await switchEvent(base, REVIEWS, true);
    // The approval switch is off: only the review specialist runs.
    const both = await runAutomaticChasers(await agent(), { calendar: calendar() });
    expect(both.approvals).toMatchObject({ status: 'succeeded', value: { disabled: 'off' } });
    expect(both.reviews).toMatchObject({ status: 'succeeded', value: { sent: 2 } });
    const events = await chaseEvents();
    expect(events.map(e => e.aggregateId).sort()).toEqual([managerStage, hrStage].sort());
    for (const e of events) expect(e.payload).toMatchObject({ action: 'employees.review_overdue.remind', reviewType: 'probation', agent: { enabledBy: [{ feature: 'review_chasers' }] } });
    await dispatchNotifications(adminCtx(base));
    const byItem = new Map(events.map(e => [e.aggregateId, e.id]));
    expect((await notificationsFor([byItem.get(managerStage)!])).map(n => n.recipientEmploymentId)).toEqual([M.employmentId]);
    expect((await notificationsFor([byItem.get(hrStage)!])).map(n => n.recipientEmploymentId)).toEqual([H.employmentId]);
    expect((await notificationsFor(events.map(e => e.id))).some(n => n.recipientEmploymentId === E.employmentId)).toBe(false);
    expect(model.calls).toBe(0);
  });

  it('records outcomes in the administrator outcome view, by scope', async () => {
    const { E } = await fixture();
    const acted = await claim(base, E.employmentId, daysAgo(10));
    await claim(base, E.employmentId, daysAgo(10));
    await replacement(base, E.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    await runApprovalChasers(await agent(), { calendar: calendar() });
    await owner.db.update(schema.claimRequest).set({ status: 'approved' }).where(eq(schema.claimRequest.id, acted));
    const group = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: null }] };
    const view = await assistantOutcomes(group, 30);
    expect(view.automatic.map(a => a.action)).toEqual(['approvals.claim.chase', 'approvals.attendance.chase', 'approvals.toil.chase', 'employees.review_overdue.remind', 'attendance.missing_clock.remind', 'employees.passport_expiry.remind', 'lifecycle.step.chase']);
    expect(view.automatic.find(a => a.action === 'approvals.claim.chase')).toMatchObject({ chased: 2, items: 2, acted: 1, waiting: 1 });
    expect(view.automatic.find(a => a.action === 'approvals.toil.chase')).toMatchObject({ chased: 1, items: 1, acted: 0, waiting: 1 });
    expect(view.automatic.find(a => a.action === 'approvals.attendance.chase')).toMatchObject({ chased: 0, firstChasedAt: null });
    // An administrator of another company sees none of company A's reminders.
    const [companyB] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Fictional Three Sdn Bhd' }).returning();
    const scoped = await assistantOutcomes({ ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: companyB.id }] }, 30);
    expect(scoped.automatic.every(a => a.chased === 0)).toBe(true);
  });

  it('counts working days on the requester roster: a Friday-evening submission is not chased at the Monday sweep', async () => {
    const { E } = await fixture();
    // Friday 2 Oct 2026, 19:00 in Kuala Lumpur.
    const friday = await claim(base, E.employmentId, new Date('2026-10-02T19:00:00+08:00'));
    await switchEvent(base, APPROVALS, true);
    const ctx = await agent();
    // Three calendar days but one working day (Mon): not overdue, although a calendar clock would chase it.
    expect((await runApprovalChasers(ctx, { today: '2026-10-05', calendar: calendar() })).sent).toBe(0);
    expect((await runApprovalChasers(ctx, { today: '2026-10-06', calendar: calendar() })).sent).toBe(0);
    // Mon, Tue, Wed: three working days.
    expect((await runApprovalChasers(ctx, { today: '2026-10-07', calendar: calendar() })).sent).toBe(1);
    const [event] = await chaseEvents();
    expect(event.aggregateId).toBe(friday);
    expect(event.payload).toMatchObject({ waitingOn: '2026-10-02', workingDaysWaiting: 3 });
  });

  it('does not count a public holiday', async () => {
    const { E } = await fixture();
    await owner.db.insert(schema.holiday).values({ tenantId: base.tenantId, country: 'MY', state: null, holidayDate: '2026-10-06', name: 'Fictional holiday' });
    await claim(base, E.employmentId, new Date('2026-10-02T19:00:00+08:00'));
    await switchEvent(base, APPROVALS, true);
    const ctx = await agent();
    // (Fri, Wed] = Mon + Wed: Tuesday is a holiday, so two working days.
    expect((await runApprovalChasers(ctx, { today: '2026-10-07', calendar: calendar() })).sent).toBe(0);
    expect((await runApprovalChasers(ctx, { today: '2026-10-08', calendar: calendar() })).sent).toBe(1);
    expect((await chaseEvents())[0].payload).toMatchObject({ workingDaysWaiting: 3 });
  });

  it('chases only the participant who can act now in a sequential attendance level', async () => {
    await setModule(base.tenantId, 'notifications', 'active');
    const root = adminCtx(base);
    const actor = async (name: string) => {
      const hired = await hire(base);
      const userId = await createAppUser(base.tenantId, hired.personId, 'employee');
      const ctx: SessionContext = { ...adminCtx(base), userId, personId: hired.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: base.companyId }] };
      return { ...hired, userId, ctx, name };
    };
    const worker = await actor('worker'), first = await actor('first'), second = await actor('second');
    const date = todayInKualaLumpur();
    await checkIn(root, { employmentId: worker.employmentId, date, time: '08:00', manual: true });
    await checkOut(root, { employmentId: worker.employmentId, date, time: '17:00', manual: true });
    await saveAttendanceWorkflow(root, { companyId: base.companyId, routingVersion: 3, code: 'WP13_SEQUENTIAL', name: 'Fictional sequential route', applicationType: 'irregularity', priority: 100,
      criteria: { employeeIds: [worker.employmentId] }, active: true,
      stages: [{ name: 'Review', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [first.employmentId, second.employmentId] }, hrAlternative: false }] });
    await setAttendanceWorkflowEnabled(root, base.companyId, 'irregularity', true);
    const { correctionId } = await requestAttendanceCorrection(worker.ctx, { employmentId: worker.employmentId, date, checkIn: '09:00', checkOut: '18:00', reason: 'Fictional recorded evidence' });
    await switchEvent(base, APPROVALS, true);
    const later = addDaysIso(todayInKualaLumpur(), 10);
    expect((await runApprovalChasers(await agent(), { today: later, calendar: calendar() })).byAction['approvals.attendance.chase']).toMatchObject({ sent: 1 });
    await dispatchNotifications(adminCtx(base));
    let events = await chaseEvents();
    expect(events.map(e => [e.aggregateId, (e.payload as { stage: string }).stage])).toEqual([[correctionId, '0.0']]);
    expect((await notificationsFor([events[0].id])).map(n => n.recipientEmploymentId)).toEqual([first.employmentId]);
    // The first participant decides; the level stays open and only the second can act now.
    await decideAttendanceCorrection(first.ctx, { correctionId, decision: 'approved', expectedStageIndex: 0, expectedParticipantSlot: '0:0' });
    expect((await runApprovalChasers(await agent(), { today: later, calendar: calendar() })).byAction['approvals.attendance.chase']).toMatchObject({ sent: 1 });
    await dispatchNotifications(adminCtx(base));
    events = await chaseEvents();
    expect((events[1].payload as { stage: string }).stage).toBe('0.1');
    expect((await notificationsFor([events[1].id])).map(n => n.recipientEmploymentId)).toEqual([second.employmentId]);
    // The first reminder is not re-sent to the second participant: it was for a stage that has moved on.
    expect((await notificationsFor([events[0].id])).map(n => n.recipientEmploymentId)).toEqual([first.employmentId]);
  });

  it('never chases the manager of a superseded reporting line', async () => {
    const { E, M } = await fixture();
    const former = await hire(base);
    await owner.db.insert(schema.reportingLine).values({ tenantId: base.tenantId, subordinateEmploymentId: E.employmentId, managerEmploymentId: former.employmentId,
      lineType: 'administrative', validFrom: '2020-01-01', supersededAt: new Date() } as never);
    await claim(base, E.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    expect((await runApprovalChasers(await agent(), { calendar: calendar() })).sent).toBe(1);
    await dispatchNotifications(adminCtx(base));
    expect((await notificationsFor((await chaseEvents()).map(e => e.id))).map(n => n.recipientEmploymentId)).toEqual([M.employmentId]);
  });

  it('records the failure cause by error class and message only', async () => {
    const { E } = await fixture();
    await claim(base, E.employmentId, daysAgo(10));
    await switchEvent(base, APPROVALS, true);
    const failing = async () => { throw new TypeError('fictional calendar outage'); };
    const result = await runAutomaticChasers(await agent(), { calendar: failing });
    expect(result.failed).toBe(true);
    expect(result.approvals).toEqual({ status: 'failed', error: { name: 'TypeError', message: 'fictional calendar outage' } });
    expect(result.reviews).toMatchObject({ status: 'succeeded', value: { disabled: 'off' } });
  });

  it('honours its own action pause for direct scheduled invocation without a browser scope',async()=>{
    const {E}=await fixture();await claim(base,E.employmentId,daysAgo(10));await switchEvent(base,APPROVALS,true);
    const current=await agent();await setAgentActionPause({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},'approvals.claim.chase',true);
    await runApprovalChasers(current,{calendar:calendar()});
    const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,APPROVAL_CHASE_EVENT)));
    expect(events).toEqual([]);expect(model.calls).toBe(0);
    await setAgentActionPause({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]},'approvals.claim.chase',false);
    await runApprovalChasers(current,{calendar:calendar()});
    const after=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,base.tenantId),eq(schema.domainEvent.eventType,APPROVAL_CHASE_EVENT)));
    expect(after).toHaveLength(1);
  });

  it('is template-only: no model, provider, spend or admission path, and admission refuses the chasers', async () => {
    const source = readFileSync(path.join(__dirname, '..', 'core', 'automatic-chasers.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\.\/lib\/ai'|lib\/ai\/providers|generateDraft|converse\(|resolveActiveAiConfig|bindAiSpendTask|ai_admit|ai_action_unpaused|assertAiActionUnpausedTx|_ai_control_context|governedAiConfig|ai-governance/);
    const migration = readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0697_automatic_chasers.sql'), 'utf8');
    expect(migration).not.toMatch(/FUNCTION app\._ai_control_context|ai_admit/);
    for (const feature of ['approval_chasers', 'review_chasers'] as const)
      await expect(withTenant(adminCtx(base), tx => assertAiActionUnpausedTx(tx, adminCtx(base), feature))).rejects.toThrow('no model call');
  });
});
