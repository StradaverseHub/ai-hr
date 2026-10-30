/** ADR-0109. One coordination layer above the existing governed HR services. */
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { withTenant, type Tx, type SessionContext } from '../db/client';
import { appendEvent } from '../db/events';
import * as schema from '../db/schema';
import { agentReadinessSnapshot, GAP_BLOCKS, readinessSnapshot, type ReadinessGapId } from './record-readiness';
import { agentActor, agentStamp, isAgentContext } from './agent-principal';
import { sweepReadinessNudges } from './readiness-nudge';
import { loadReadinessActions } from './readiness-actions';
import { EntitlementError } from './entitlements';
import type { ReadinessAction } from '../lib/readiness-correction-actions';
import { triagePendingClaims } from './input-triage';
import { digestOf } from './agent-proposal';
import { HR_HARNESS_VERSION, readinessTransition, runOrchestrationPass, summarizeOrchestrationPass } from './orchestrator-harness';
import {runAutomaticFollowups} from './automatic-followups';
import { AutomaticChaserRefusal, runApprovalChasers, runReviewChasers, type ChaserRunOptions } from './automatic-chasers';

/** Run state is administrative. Employee self-service continues through its existing services.
 *  The tenant's agent principal may run the pass (ADR-0151 §4.5) but never reads the admin queue. */
function assertRunner(ctx: SessionContext) {
  if (isAgentContext(ctx)) return;
  assertAdmin(ctx);
}

function assertAdmin(ctx: SessionContext) {
  if (isAgentContext(ctx)) throw new Error('Orchestrator access denied');
  if (!(ctx.grants ?? ctx.roles?.map(role => ({ role, companyId: null })) ?? [])
    .some(g => g.role === 'hr_admin' || g.role === 'super_admin')) throw new Error('Orchestrator access denied');
}

/** Only metadata from a named scheduled tenant pass may be shared with company administrators.
 * Counts and people always come from their own RLS-scoped case query; manual passes stay exact-scope. */
function receiptScope(ctx: SessionContext) {
  return or(
    sql`${schema.domainEvent.payload} ->> 'scopeDigest' = ${scopeDigest(ctx)}`,
    and(eq(schema.domainEvent.actorType, 'agent'),
      sql`${schema.domainEvent.actorId}::text = ${schema.domainEvent.payload} -> 'agent' ->> 'principalId'`,
      sql`${schema.domainEvent.payload} ->> 'scheduled' = 'true'`,
      sql`${schema.domainEvent.payload} ->> 'scopeDigest' = ${digestOf(['all-employments'])}`),
  );
}

function scopeDigest(ctx: SessionContext) {
  // The principal observes every active employment of its tenant, the same scope as a group administrator.
  if (isAgentContext(ctx)) return digestOf(['all-employments']);
  const grants = ctx.grants ?? ctx.roles?.map(role => ({ role, companyId: null })) ?? [];
  // Match effective administrative authority, not unrelated employee/manager grants on the same user.
  if (grants.some(g => g.role === 'super_admin' || (g.role === 'hr_admin' && g.companyId == null))) {
    return digestOf(['all-employments']);
  }
  return digestOf([...new Set(grants.filter(g => g.role === 'hr_admin').map(g => g.companyId))].sort());
}

export async function reconcileReadinessCases(ctx: SessionContext) {
  assertRunner(ctx);
  const actor = isAgentContext(ctx) ? agentActor(ctx) : ctx.userId ? { type: 'user' as const, id: ctx.userId } : { type: 'agent' as const };
  return withTenant(ctx, async tx => {
    // Serialize overlapping reconcilers before reading source facts. No model/network call holds this lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('hr-orchestrator'), hashtext(${ctx.tenantId}))`);
    const { view, activeEmploymentIds } = isAgentContext(ctx) ? await agentReadinessSnapshot(tx, Number.POSITIVE_INFINITY)
      : await readinessSnapshot(tx, Number.POSITIVE_INFINITY, true);
    const actions = await loadReadinessActions(tx, ctx, activeEmploymentIds);
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
      if (!Object.hasOwn(GAP_BLOCKS, gap)) continue;
      const action = actions.get(key);
      const audience = current ? action?.audience ?? 'hr' : previous!.audience;
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
        actor, subjectEmploymentId: employmentId,
        payload: { gap, from: previous?.state ?? null, to: state, action: action?.type ?? null,
          requestId: action?.requestId ?? null, harnessVersion: HR_HARNESS_VERSION, ...agentStamp(ctx) },
      });
    }
    for (let offset = 0; offset < unchanged.length; offset += 500) {
      await tx.update(schema.hrOrchestrationCase).set({ observedAt: now, harnessVersion: HR_HARNESS_VERSION })
        .where(inArray(schema.hrOrchestrationCase.id, unchanged.slice(offset, offset + 500)));
    }
    await appendEvent(tx, { tenantId: ctx.tenantId, aggregateType: 'hr_orchestrator',
      aggregateId: ctx.tenantId, eventType: 'orchestrator.readiness-checked',
      actor, payload: { scheduled: isAgentContext(ctx), scopeDigest: scopeDigest(ctx), harnessVersion: HR_HARNESS_VERSION, ...agentStamp(ctx) },
    });
    return counts;
  });
}

/**
 * Scheduled entry point. Each specialist retains its settings, adjudicator and source ownership.
 * A failed specialist does not suppress the others. Effects are never retried inside this pass.
 */
export async function runHrOrchestrator(ctx: SessionContext) {
  assertRunner(ctx);
  return runOrchestrationPass({
    observe: () => reconcileReadinessCases(ctx),
    readiness: () => sweepReadinessNudges(ctx),
    claims: () => triagePendingClaims(ctx),
    recordTrace: trace => withTenant(ctx, tx => appendEvent(tx, {
      tenantId: ctx.tenantId, aggregateType: 'hr_orchestrator', aggregateId: ctx.tenantId,
      eventType: 'orchestrator.pass-finished', actor: agentActor(ctx),
      payload: { scheduled: isAgentContext(ctx), scopeDigest: scopeDigest(ctx), ...trace, ...agentStamp(ctx) },
    })),
  });
}

/**
 * WP13 (R18; ADR-0151 §4.5) — the Automatic-tier reminders, beside the readiness pass rather than inside its
 * harness: they are separate specialists with their own switches, observe no readiness cases and need no case
 * trace. Only the tenant's agent principal runs them, and each runs only behind its own attributed switch.
 * A failure in one does not suppress the other; neither retries an effect.
 */
export async function runAutomaticChasers(ctx: SessionContext, opts: ChaserRunOptions) {
  if (!isAgentContext(ctx)) throw new AutomaticChaserRefusal('not_agent');
  // The cause is the error class and message only (bounded); sources never put names or HR values in them.
  const attempt = async <T>(run: () => Promise<T>) => {
    try { return { status: 'succeeded' as const, value: await run() }; }
    catch (e) {
      const error = e instanceof Error ? { name: e.constructor.name || e.name, message: e.message.slice(0, 200) } : { name: typeof e, message: '' };
      return { status: 'failed' as const, error };
    }
  };
  const approvals = await attempt(() => runApprovalChasers(ctx, opts));
  const reviews = await attempt(() => runReviewChasers(ctx, opts));
  const followups = await attempt(() => runAutomaticFollowups(ctx, opts));
  return { approvals, reviews, followups, failed: approvals.status === 'failed' || reviews.status === 'failed' || followups.status === 'failed' };
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
    const checks = await tx.select({ at: schema.domainEvent.occurredAt }).from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.eventType, 'orchestrator.readiness-checked'),
        receiptScope(ctx)))
      .orderBy(desc(schema.domainEvent.occurredAt), desc(schema.domainEvent.sequence)).limit(1);
    const open = rows.filter(r => r.state === 'needs_input' || r.state === 'needs_review');
    const displayed = open.slice(0, 50);
    let actions = new Map<string, ReadinessAction>();
    let actionsUnavailable = false;
    // Counts cover the full scope; guidance is only needed for rows actually displayed.
    try { actions = await loadReadinessActions(tx, ctx, [...new Set(displayed.map(row => row.employmentId))]); }
    catch (error) {
      // Settings resolution happens before action queries; a display failure must not hide the queue.
      if (!(error instanceof EntitlementError)) throw error;
      actionsUnavailable = true;
    }
    const runs = await tx.select({ at: schema.domainEvent.occurredAt, payload: schema.domainEvent.payload,
      scheduled: sql<boolean>`${schema.domainEvent.payload} ->> 'scheduled' = 'true'` })
      .from(schema.domainEvent).where(and(eq(schema.domainEvent.eventType, 'orchestrator.pass-finished'),
        receiptScope(ctx)))
      .orderBy(desc(schema.domainEvent.occurredAt), desc(schema.domainEvent.sequence)).limit(1);
    return { rows: displayed.map(row => ({ ...row, action: actions.get(`${row.employmentId}:${row.gap}`) ?? null })), total: open.length,
      actionsUnavailable,
      verified: rows.filter(r => r.state === 'verified').length,
      inactive: rows.filter(r => r.state === 'inactive').length,
      observedAt: checks.length ? checks[0].at : null,
      scheduledRun: runs[0]?.scheduled === true,
      lastRun: runs.length ? { at: runs[0].at, ...summarizeOrchestrationPass(runs[0].payload) } : null,
    };
  }, { readOnlySnapshot: true });
}

/** Recorded readiness queue workload, not a claim about live workforce health or historic throughput. */
export async function organisationAnalysisSourceTx(tx:Tx,ctx:SessionContext,companyIds:readonly string[]){
 assertAdmin(ctx);if(!companyIds.length)throw Error('Workload analysis requires a company scope.');
 const rows=await tx.select({personId:schema.employment.personId,state:schema.hrOrchestrationCase.state})
  .from(schema.hrOrchestrationCase).innerJoin(schema.employment,eq(schema.employment.id,schema.hrOrchestrationCase.employmentId))
  .innerJoin(schema.person,eq(schema.person.id,schema.employment.personId)).innerJoin(schema.company,eq(schema.company.id,schema.employment.companyId))
  .where(inArray(schema.employment.companyId,[...companyIds]));
 return {selection:'recorded_noninactive_cases',rows:rows.filter(row=>row.state!=='inactive').map(row=>({personId:row.personId,
  conditions:{open_workload:row.state==='needs_input'||row.state==='needs_review'}}))};
}
