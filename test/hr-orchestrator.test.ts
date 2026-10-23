import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { reconcileReadinessCases, orchestrationQueue, runHrOrchestrator } from '../core/hr-orchestrator';
import { sweepReadinessNudges } from '../core/readiness-nudge';
import { drainNotificationProjection } from '../core/orchestrator-harness';
import { dispatchNotifications } from '../core/notifications';
import { digestOf } from '../core/agent-proposal';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

describe('central HR orchestrator', () => {
  let base: Base;
  beforeAll(migrateTestDb);
  beforeEach(async () => { await resetDb(); base = await seedBase(); });
  afterAll(closeAll);

  async function hire() {
    const employee = await hireEmployee(adminCtx(base), {
      person: { fullName: 'Orchestration fixture', primaryEmail: 'orchestrator@example.test' },
      companyId: base.companyId, departmentId: base.deptA,
      employmentType: 'full_time', hiredOn: '2024-01-01', paymentMethod: 'bank_transfer',
    } as never);
    await owner.db.insert(schema.employeeStatutoryMy).values({ tenantId: base.tenantId,
      personId: employee.personId, passportNumber: 'ORCH-PASSPORT',
      taxNumber: 'ORCH-TAX', epfNumber: 'ORCH-EPF', socsoNumber: 'ORCH-SOCSO' });
    return employee;
  }
  const cases = () => owner.db.select().from(schema.hrOrchestrationCase).orderBy(schema.hrOrchestrationCase.id);

  it('opens, resumes, verifies and reopens a case using source evidence', async () => {
    const employee = await hire();
    const ctx = adminCtx(base);
    const first = await reconcileReadinessCases(ctx);
    expect(first.opened).toBeGreaterThan(0);
    const bank = (await cases()).find(c => c.employmentId === employee.employmentId && c.gap === 'no_bank_account')!;
    expect(bank.state).toBe('needs_input');
    expect((await reconcileReadinessCases(ctx)).opened).toBe(0);
    // Cash removes the bank requirement in the engine. The coordinator does not invent a bank value.
    await owner.db.update(schema.employment).set({ paymentMethod: 'cash' }).where(eq(schema.employment.id, employee.employmentId));
    expect((await reconcileReadinessCases(ctx)).verified).toBe(1);
    const closed = (await cases()).find(c => c.id === bank.id)!;
    expect(closed.state).toBe('verified');
    expect(closed.verifiedAt).not.toBeNull();
    await owner.db.update(schema.employment).set({ paymentMethod: 'bank_transfer' }).where(eq(schema.employment.id, employee.employmentId));
    expect((await reconcileReadinessCases(ctx)).reopened).toBe(1);
    const reopened = (await cases()).find(c => c.id === bank.id)!;
    expect(reopened.reopenCount).toBe(1);
    expect(reopened.verifiedAt).toBeNull();
    expect((await orchestrationQueue(ctx)).observedAt).not.toBeNull();
  });

  it('retirement is not counted as a successful correction', async () => {
    const employee = await hire();
    const ctx = adminCtx(base);
    await reconcileReadinessCases(ctx);
    await owner.db.update(schema.employment).set({ terminatedOn: '2025-01-01' }).where(eq(schema.employment.id, employee.employmentId));
    const result = await reconcileReadinessCases(ctx);
    expect(result.inactive).toBeGreaterThan(0);
    expect(result.verified).toBe(0);
    expect((await cases()).every(c => c.state === 'inactive')).toBe(true);
  });

  it('records a successful empty check, and rejects non-admin coordination', async () => {
    await reconcileReadinessCases(adminCtx(base));
    expect((await orchestrationQueue(adminCtx(base))).observedAt).not.toBeNull();
    await hire();
    await reconcileReadinessCases(adminCtx(base));
    expect((await cases()).length).toBeGreaterThan(0);
    const employee = { ...adminCtx(base), roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
    await expect(reconcileReadinessCases(employee)).rejects.toThrow('access denied');
    await expect(runHrOrchestrator(employee)).rejects.toThrow('access denied');
    expect(await withTenant(employee, tx => tx.select().from(schema.hrOrchestrationCase))).toEqual([]);
  });

  it('concurrent reconciliation opens each issue once', async () => {
    await hire();
    const ctx = adminCtx(base);
    const results = await Promise.all([reconcileReadinessCases(ctx), reconcileReadinessCases(ctx)]);
    expect(results.reduce((sum, r) => sum + r.opened, 0)).toBe((await cases()).length);
  });

  it('a scoped observer cannot read or close cases outside its company', async () => {
    await hire();
    await reconcileReadinessCases(adminCtx(base));
    const before = await cases();
    const scoped = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: crypto.randomUUID() }] };
    expect((await orchestrationQueue(scoped)).total).toBe(0);
    await reconcileReadinessCases(scoped);
    expect(await cases()).toEqual(before);
    const otherTenant = await seedBase();
    expect(await withTenant(adminCtx(otherTenant), tx => tx.select().from(schema.hrOrchestrationCase))).toEqual([]);
    await expect(withTenant(adminCtx(otherTenant), tx => tx.insert(schema.hrOrchestrationCase).values({
      tenantId: otherTenant.tenantId, employmentId: before[0].employmentId, gap: 'no_bank_account',
      state: 'needs_input', audience: 'employee', harnessVersion: 'test',
    }))).rejects.toThrow();
  });

  it('respects switches while still observing work', async () => {
    await hire();
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', false);
    await setSetting(base.tenantId, 'claims.input_triage_enabled', false);
    const run = await runHrOrchestrator(adminCtx(base));
    expect(run.failed).toBe(false);
    expect(run.nudge).toMatchObject({ status: 'succeeded', value: { disabled: true } });
    expect(run.triage).toMatchObject({ status: 'succeeded', value: { disabled: true } });
    expect((await cases()).length).toBeGreaterThan(0);
    const reader = { ...adminCtx(base), grants: [
      { role: 'hr_admin', companyId: null }, { role: 'employee', companyId: null },
    ] };
    expect((await orchestrationQueue(reader)).lastRun?.failed).toBe(false);
    expect((await orchestrationQueue(reader)).lastRun?.steps).toEqual({
      observe: 'succeeded', readiness: 'succeeded', claims: 'succeeded', verify: 'succeeded',
    });
    expect((await orchestrationQueue({ ...adminCtx(base), grants: [{ role: 'super_admin', companyId: null }] })).observedAt).not.toBeNull();
  });

  it('keeps pass receipts scoped to the matching administrative authority and tenant', async () => {
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', false);
    await setSetting(base.tenantId, 'claims.input_triage_enabled', false);
    await runHrOrchestrator(adminCtx(base));
    expect((await orchestrationQueue(adminCtx(base))).lastRun).not.toBeNull();
    const scoped = { ...adminCtx(base), grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    // A tenant-wide pass exists, but is not a receipt for this company-scoped observer.
    expect((await orchestrationQueue(scoped)).lastRun).toBeNull();
    await runHrOrchestrator(scoped);
    expect((await orchestrationQueue(scoped)).lastRun?.failed).toBe(false);
    const other = await seedBase();
    expect((await orchestrationQueue(adminCtx(other))).lastRun).toBeNull();
  });

  it('uses the latest tied receipt and safely projects malformed metadata without source text', async () => {
    const at = new Date();
    const event = { tenantId: base.tenantId, aggregateType: 'hr_orchestrator', aggregateId: base.tenantId,
      eventType: 'orchestrator.pass-finished', actorType: 'agent' as const, occurredAt: at };
    const scopeDigest = digestOf(['all-employments']);
    await owner.db.insert(schema.domainEvent).values({ ...event, payload: { scopeDigest, harnessVersion: 'readiness-v2', failed: false,
      steps: { observe: 'succeeded', readiness: 'succeeded', claims: 'succeeded', verify: 'succeeded' } } });
    await owner.db.insert(schema.domainEvent).values({ ...event, payload: { scopeDigest, harnessVersion: 'private source text',
      failed: 'private exception', steps: { claims: 'private instruction' }, prompt: 'private prompt' } });
    const view = await orchestrationQueue(adminCtx(base));
    expect(view.lastRun).toEqual({ at, harnessVersion: null, failed: null,
      steps: { observe: 'unknown', readiness: 'unknown', claims: 'unknown', verify: 'unknown' } });
    expect(JSON.stringify(view.lastRun)).not.toContain('private');
  });

  it('a failed specialist does not suppress verification and is recorded as failed', async () => {
    await hire();
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', true);
    await setSetting(base.tenantId, 'claims.input_triage_enabled', false);
    await owner.db.execute(sql`revoke select on agent_proposal from ai_hr_app`);
    try {
      const result = await runHrOrchestrator(adminCtx(base));
      expect(result.nudge.status).toBe('failed');
      expect(result.after.status).toBe('succeeded');
      expect(result.failed).toBe(true);
      expect((await orchestrationQueue(adminCtx(base))).lastRun?.failed).toBe(true);
    } finally { await owner.db.execute(sql`grant select on agent_proposal to ai_hr_app`); }
  });

  it('fails the run when only its trace receipt cannot commit, while preserving source observations', async () => {
    await hire();
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', false);
    await setSetting(base.tenantId, 'claims.input_triage_enabled', false);
    await owner.db.execute(sql`create function public.test_refuse_orchestrator_trace() returns trigger
      language plpgsql as $$ begin
        if new.event_type = 'orchestrator.pass-finished' then raise exception 'fictional trace refusal'; end if;
        return new;
      end $$`);
    try {
      await owner.db.execute(sql`create trigger test_refuse_orchestrator_trace before insert on domain_event
        for each row execute function public.test_refuse_orchestrator_trace()`);
      const ctx = adminCtx(base);
      const result = await runHrOrchestrator(ctx);
      expect(result.before.status).toBe('succeeded');
      expect(result.nudge).toMatchObject({ status: 'succeeded', value: { disabled: true } });
      expect(result.triage).toMatchObject({ status: 'succeeded', value: { disabled: true } });
      expect(result.after.status).toBe('succeeded');
      expect(result.failed).toBe(true);
      const view = await orchestrationQueue(ctx);
      expect(view.total).toBeGreaterThan(0);
      expect(view.observedAt).not.toBeNull();
      expect(view.lastRun).toBeNull(); // No invented receipt for a run whose trace did not commit.
      const checks = await owner.db.select().from(schema.domainEvent)
        .where(eq(schema.domainEvent.eventType, 'orchestrator.readiness-checked')).orderBy(schema.domainEvent.sequence);
      expect(checks).toHaveLength(2);
    } finally {
      await owner.db.execute(sql`drop trigger if exists test_refuse_orchestrator_trace on domain_event`);
      await owner.db.execute(sql`drop function public.test_refuse_orchestrator_trace()`);
    }
  });

  it('does not duplicate a reminder after the best-effort proposal write fails', async () => {
    await hire();
    await setModule(base.tenantId, 'notifications', 'active');
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', true);
    await owner.db.execute(sql`revoke insert on agent_proposal from ai_hr_app`);
    try {
      const ctx = adminCtx(base);
      const results = await Promise.all([sweepReadinessNudges(ctx), sweepReadinessNudges(ctx)]);
      // Only bank details have an employee recipient; this fixture has no HR employee to notify.
      expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
      expect((await sweepReadinessNudges(ctx)).sent).toBe(0);
      expect(await owner.db.select().from(schema.agentProposal)).toEqual([]);
      const events = await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType, 'readiness.nudge-raised'));
      expect(events).toHaveLength(1);
    } finally { await owner.db.execute(sql`grant insert on agent_proposal to ai_hr_app`); }
  });

  it('projects reminders beyond the first page of coordination history', async () => {
    await hire();
    await setModule(base.tenantId, 'notifications', 'active');
    await setSetting(base.tenantId, 'notifications.readiness_nudge_enabled', true);
    await setSetting(base.tenantId, 'claims.input_triage_enabled', false);
    await owner.db.insert(schema.domainEvent).values(Array.from({ length: 1001 }, () => ({
      tenantId: base.tenantId, aggregateType: 'hr_orchestrator', aggregateId: base.tenantId,
      eventType: 'orchestrator.readiness-checked', actorType: 'agent' as const, payload: {},
    })));
    const ctx = adminCtx(base);
    await runHrOrchestrator(ctx);
    const projected = await drainNotificationProjection(limit => dispatchNotifications(ctx, { limit }));
    expect(projected.processed).toBeGreaterThan(1000);
    expect(projected.cappedOut).toBe(false);
    const nudges = await owner.db.select().from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'readiness.nudge-raised')).orderBy(schema.domainEvent.sequence);
    expect(nudges).toHaveLength(1);
    expect(await owner.db.select().from(schema.notification)
      .where(eq(schema.notification.sourceEventId, nudges[0].id)).orderBy(schema.notification.id)).toHaveLength(1);
  });
});
