/** ADR-0104. One coordination layer above the existing governed HR services. */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import * as schema from '../db/schema';
import { readinessSnapshot, type ReadinessGapId } from './record-readiness';
import { NUDGE_AUDIENCE, sweepReadinessNudges } from './readiness-nudge';
import { triagePendingClaims } from './input-triage';
import { digestOf } from './agent-proposal';
import { HR_HARNESS_VERSION, readinessTransition, runHarnessStep } from './orchestrator-harness';

/** Run state is administrative. Employee self-service continues through its existing services. */
function assertAdmin(ctx: SessionContext) {
  if (!(ctx.grants ?? ctx.roles?.map(role => ({ role, companyId: null })) ?? [])
    .some(g => g.role === 'hr_admin' || g.role === 'super_admin')) throw new Error('Orchestrator access denied');
}

function scopeDigest(ctx: SessionContext) {
  return digestOf((ctx.grants ?? ctx.roles?.map(role => ({ role, companyId: null })) ?? [])
    .map(g => [g.role, g.companyId]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export async function reconcileReadinessCases(ctx: SessionContext) {
  assertAdmin(ctx);
  return withTenant(ctx, async tx => {
    // Serialize overlapping reconcilers before reading source facts. No model/network call holds this lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hr-orchestrator'), hashtext(${ctx.tenantId}))`);
    const { view, activeEmploymentIds } = await readinessSnapshot(tx, Number.POSITIVE_INFINITY, true);
    const active = new Set(activeEmploymentIds);
    const existing = await tx.select().from(schema.hrOrchestrationCase);
    const byKey = new Map(existing.map(c => [`${c.employmentId}:${c.gap}`, c]));
    const missing = new Map<string, { employmentId: string; gap: ReadinessGapId }>();
    for (const gap of view.gaps) for (const p of gap.people) {
      missing.set(`${p.employmentId}:${gap.id}`, { employmentId: p.employmentId, gap: gap.id });
    }
    // An invisible/deleted employment is unknown. Only an explicitly observed termination retires a case.
    const employments = existing.length ? await tx.select({ id: schema.employment.id, terminatedOn: schema.employment.terminatedOn })
      .from(schema.employment).where(inArray(schema.employment.id, [...new Set(existing.map(c => c.employmentId))])) : [];
    const inactive = new Set(employments.filter(e => e.terminatedOn != null).map(e => e.id));
    const now = new Date();
    const counts = { opened: 0, reopened: 0, verified: 0, inactive: 0, open: missing.size };
    const unchanged: string[] = [];
    for (const key of new Set([...missing.keys(), ...byKey.keys()])) {
      const previous = byKey.get(key);
      const current = missing.get(key);
      const employmentId = current?.employmentId ?? previous!.employmentId;
      const gap = current?.gap ?? previous!.gap;
      if (!Object.hasOwn(NUDGE_AUDIENCE, gap)) continue;
      const audience = current ? NUDGE_AUDIENCE[current.gap] : previous!.audience;
      const observation = current ? 'missing' : active.has(employmentId) ? 'complete' : inactive.has(employmentId) ? 'inactive' : 'unknown';
      const state = readinessTransition(observation, audience);
      if (state == null) continue;
      const reopened = !!previous && (previous.state === 'verified' || previous.state === 'inactive') && !!current;
      const changed = !previous || previous.state !== state;
      if (previous && !changed && previous.audience === audience) {
        unchanged.push(previous.id);
        continue;
      }
      const values = {
        state, audience, harnessVersion: HR_HARNESS_VERSION, observedAt: now,
        openedAt: reopened ? now : previous?.openedAt ?? now,
        verifiedAt: state === 'verified' ? previous?.verifiedAt ?? now : null,
        reopenCount: (previous?.reopenCount ?? 0) + Number(reopened),
      };
      let id = previous?.id;
      if (previous) await tx.update(schema.hrOrchestrationCase).set(values).where(eq(schema.hrOrchestrationCase.id, previous.id));
      else {
        const [row] = await tx.insert(schema.hrOrchestrationCase).values({ ...values, tenantId: ctx.tenantId, employmentId, gap }).returning({ id: schema.hrOrchestrationCase.id });
        id = row.id;
        counts.opened++;
      }
      if (reopened) counts.reopened++;
      if (changed && state === 'verified') counts.verified++;
      if (changed && state === 'inactive') counts.inactive++;
      if (changed) await appendEvent(tx, {
        tenantId: ctx.tenantId, aggregateType: 'hr_orchestration_case', aggregateId: id!,
        eventType: `orchestrator.case-${reopened ? 'reopened' : state}`,
        actor: ctx.userId ? { type: 'user', id: ctx.userId } : { type: 'agent' },
        subjectEmploymentId: employmentId,
        payload: { gap, from: previous?.state ?? null, to: state, harnessVersion: HR_HARNESS_VERSION },
      });
    }
    for (let offset = 0; offset < unchanged.length; offset += 500) {
      await tx.update(schema.hrOrchestrationCase).set({ observedAt: now, harnessVersion: HR_HARNESS_VERSION })
        .where(inArray(schema.hrOrchestrationCase.id, unchanged.slice(offset, offset + 500)));
    }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'hr_orchestrator',
      aggregateId: ctx.tenantId, eventType: 'orchestrator.readiness-checked',
      actor: ctx.userId ? { type: 'user', id: ctx.userId } : { type: 'agent' },
      payload: { scopeDigest: scopeDigest(ctx), harnessVersion: HR_HARNESS_VERSION },
    });
    return counts;
  });
}

/**
 * Scheduled entry point. Each specialist retains its settings, adjudicator and source ownership.
 * A failed specialist does not suppress the others. Effects are never retried inside this pass.
 */
export async function runHrOrchestrator(ctx: SessionContext) {
  assertAdmin(ctx);
  const before = await runHarnessStep(() => reconcileReadinessCases(ctx));
  const nudge = await runHarnessStep(() => sweepReadinessNudges(ctx));
  const triage = await runHarnessStep(() => triagePendingClaims(ctx));
  const after = await runHarnessStep(() => reconcileReadinessCases(ctx));
  const failed = [before, nudge, triage, after].some(s => s.status === 'failed');
  const trace = await runHarnessStep(() => withTenant(ctx, tx => appendEvent(tx, {
    tenantId: ctx.tenantId, aggregateType: 'hr_orchestrator', aggregateId: ctx.tenantId,
    eventType: 'orchestrator.pass-finished', actor: { type: 'agent' },
    payload: { scopeDigest: scopeDigest(ctx), harnessVersion: HR_HARNESS_VERSION, failed,
      steps: { observe: before.status, readiness: nudge.status, claims: triage.status, verify: after.status } },
  })));
  return { harnessVersion: HR_HARNESS_VERSION, before, nudge, triage, after,
    failed: failed || trace.status === 'failed' };
}

/** Scope follows the source employment even after a transfer. Never expose tenant-wide aggregates. */
export async function orchestrationQueue(ctx: SessionContext) {
  assertAdmin(ctx);
  return withTenant(ctx, async tx => {
    const rows = await tx.select({
      id: schema.hrOrchestrationCase.id, employmentId: schema.hrOrchestrationCase.employmentId,
      gap: schema.hrOrchestrationCase.gap, state: schema.hrOrchestrationCase.state,
      audience: schema.hrOrchestrationCase.audience, openedAt: schema.hrOrchestrationCase.openedAt,
      observedAt: schema.hrOrchestrationCase.observedAt, verifiedAt: schema.hrOrchestrationCase.verifiedAt,
      reopenCount: schema.hrOrchestrationCase.reopenCount,
      name: schema.person.fullName, company: schema.company.legalName,
    }).from(schema.hrOrchestrationCase)
      .innerJoin(schema.employment, eq(schema.employment.id, schema.hrOrchestrationCase.employmentId))
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .innerJoin(schema.company, eq(schema.company.id, schema.employment.companyId))
      .orderBy(asc(schema.hrOrchestrationCase.openedAt), asc(schema.hrOrchestrationCase.id));
    const [lastCheck] = await tx.select({ at: schema.domainEvent.occurredAt }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.eventType, 'orchestrator.readiness-checked'),
        sql`${schema.domainEvent.payload} ->> 'scopeDigest' = ${scopeDigest(ctx)}`))
      .orderBy(desc(schema.domainEvent.occurredAt)).limit(1);
    const open = rows.filter(r => r.state === 'needs_input' || r.state === 'needs_review');
    const [lastRun] = await tx.select({ at: schema.domainEvent.occurredAt,
      failed: sql<boolean>`coalesce((${schema.domainEvent.payload} ->> 'failed')::boolean, false)` })
      .from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType, 'orchestrator.pass-finished'),
        sql`${schema.domainEvent.payload} ->> 'scopeDigest' = ${scopeDigest(ctx)}`))
      .orderBy(desc(schema.domainEvent.occurredAt)).limit(1);
    return { rows: open.slice(0, 50), total: open.length,
      verified: rows.filter(r => r.state === 'verified').length,
      inactive: rows.filter(r => r.state === 'inactive').length,
      observedAt: lastCheck?.at ?? null,
      lastRun: lastRun ?? null,
    };
  });
}
