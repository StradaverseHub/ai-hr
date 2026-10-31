import {assertAgentActionUnpausedTx} from './agent-action-pause';
import {AiAllowanceError} from '../lib/ai/types';
/**
 * WP13 (architecture review R18; ADR-0151 §4.4-4.5; owner decisions 1-2, 29 Oct 2026) — the first Automatic-tier
 * entries: deterministic reminders run nightly by the tenant's named agent principal.
 *
 *   approval_chasers  `approvals.claim.chase`, `approvals.attendance.chase`, `approvals.toil.chase`: a pending
 *                     claim, attendance correction or replacement leave request that has waited past its
 *                     threshold at its CURRENT stage is chased to whoever can decide it now. This generalises the
 *                     leave escalation sweep (core/leave-escalation.ts): same clock idea (the latest of submission
 *                     and any earlier stage decision), the same HR-local date maths and the same rule that the
 *                     notification registry re-checks, at dispatch, that the item is still waiting.
 *   review_chasers    `employees.review_overdue.remind`: a probation, contract or internship review still
 *                     undecided after its end date is chased to the stage owner (manager, or HR). Reminders
 *                     BEFORE the end date remain the existing engine job (sweepReviewReminders); not duplicated.
 *
 * WHAT IT NEVER DOES. No model call and no spend (decision 2: the bodies are fixed templates rendered by the
 * notification registry). It never approves, rejects, submits, cancels or edits anything, and never touches pay,
 * access or employment state. Its only write is one stamped `automatic-chase.*` event per item; 0697's
 * restrictive policy refuses any other agent event, and the source definers return ids, stages and dates only.
 *
 * WHO MAY RUN IT. Only an agent context (no login, no grant), only for a registered Automatic entry within its
 * tier ceiling, only while the entry's specialist switch is on, attributed to the administrator who switched it
 * on, and still the same switch-on the run started with (re-read in every effect transaction; switching off, or
 * off-and-on, or SETTING_KILL stops the run). The notifications module must be held, or nothing could be told.
 *
 * CLOCK. Overdue means `overdueAfterDays` WORKING days elapsed since the wait began, on the requester's roster
 * minus their public holidays: the leave escalation's own owners (elapsedWorkingDaysTx). The principal may not read
 * rosters, so the nightly sweep supplies that count from its system engine context, which already computes the
 * leave escalation (engineWorkingDayCalendar); it returns a number per employment and date, nothing else.
 *
 * BOUNDS (owned by the registry entry's `automatic` block): overdue threshold in working days, a cooldown per
 * (item, stage), a lifetime cap per (item, stage) and a cap per run. The domain_event log is the ledger, as for
 * the leave escalation: an advisory lock per (entry, item) plus a re-read of earlier receipts makes a re-run or a
 * concurrent run idempotent.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent } from '../db/events';
import * as schema from '../db/schema';
import { isModuleEnabled, resolveEntitlementsTx, settingEnabled } from './entitlements';
import { agentActor, agentHolds, agentSpecialistCurrentTx, agentStamp, isAgentContext } from './agent-principal';
import { addDaysIso, elapsedWorkingDaysTx, localDate } from '../packs/leave/service';
import { todayInKualaLumpur } from '../lib/hr-date';
import { agentActionsByTier, type AgentAutomaticSource, type AgentAutomaticSpecialist } from '../lib/ai/agent-action-registry';
import { assertAgentActionTier } from '../lib/ai/agent-action-tier-guard';

export const CHASE_AGGREGATE = 'automatic-chase';
export const APPROVAL_CHASE_EVENT = 'automatic-chase.approval-raised';
export const REVIEW_CHASE_EVENT = 'automatic-chase.review-raised';

/** Every Automatic registry entry, in registry order. */
export const AUTOMATIC_CHASE_ACTIONS = agentActionsByTier('automatic').filter(action=>action.automatic.specialist==='approval_chasers'||action.automatic.specialist==='review_chasers');
export type AutomaticChaseAction = (typeof AUTOMATIC_CHASE_ACTIONS)[number];
export type AutomaticChaseActionId = AutomaticChaseAction['id'];

export type ChaserRefusalReason = 'not_agent' | 'unknown_action' | 'switched_off' | 'module_off';
export class AutomaticChaserRefusal extends Error {
  constructor(readonly reason: ChaserRefusalReason) { super(`Automatic chaser refused: ${reason}`); }
}

/** Literal keys: test/module-catalog-drift.test.ts only sees literal setting keys. */
const SWITCH_ON: Record<'approval_chasers'|'review_chasers', (ctx: SessionContext) => boolean> = {
  approval_chasers: ctx => settingEnabled(ctx, 'notifications.approval_chasers_enabled'),
  review_chasers: ctx => settingEnabled(ctx, 'notifications.review_chasers_enabled'),
};

const eventFor = (source: AgentAutomaticSource) => source === 'employment_review' ? REVIEW_CHASE_EVENT : APPROVAL_CHASE_EVENT;

/**
 * The registry guard for every Automatic entry (its `permission.guard`). Re-reads the tenant's switches inside
 * this transaction: a stale snapshot cannot keep a switched-off chaser running. Returns the fresh context the
 * effect must be stamped with.
 */
export async function assertAutomaticChaserTx(tx: Tx, ctx: SessionContext, actionId: string): Promise<{ action: AutomaticChaseAction; fresh: SessionContext }> {
  const action = AUTOMATIC_CHASE_ACTIONS.find(a => a.id === actionId);
  if (!action) throw new AutomaticChaserRefusal('unknown_action');
  // R17: the runtime tier check, not only the type. Throws for anything above its registered ceiling.
  assertAgentActionTier(action.id, 'automatic');
  if (!isAgentContext(ctx)) throw new AutomaticChaserRefusal('not_agent');
  const entitlements = await resolveEntitlementsTx(tx, ctx.tenantId);
  const fresh: SessionContext = { ...ctx, entitlements, entitlementsExempt: undefined };
  const specialist = action.automatic.specialist;
  if(specialist!=='approval_chasers'&&specialist!=='review_chasers')throw new AutomaticChaserRefusal('unknown_action');
  if (!SWITCH_ON[specialist](fresh) || !(await agentSpecialistCurrentTx(tx, fresh, specialist))) throw new AutomaticChaserRefusal('switched_off');
  try{await assertAgentActionUnpausedTx(tx,action.id);}catch(error){if(error instanceof AiAllowanceError&&error.reason==='paused')throw new AutomaticChaserRefusal('switched_off');throw error;}
  if (!isModuleEnabled(fresh, 'notifications')) throw new AutomaticChaserRefusal('module_off');
  return { action, fresh };
}

/** One overdue item as the principal may see it: ids, stage and the HR-local date its wait began. */
export type ChaseItem = { itemId: string; subjectEmploymentId: string; companyId: string; stage: string; waitingOn: string; reviewType?: string };

const asDate = (v: unknown) => v instanceof Date ? v : new Date(String(v));
const isoDay = (v: unknown) => typeof v === 'string' ? v.slice(0, 10) : asDate(v).toISOString().slice(0, 10);
const idArray = (ids: readonly string[] | null) =>
  ids ? sql`array[${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[]` : sql`null::uuid[]`;
/** The instant an HR-local calendar day begins (Asia/Kuala_Lumpur is UTC+8 all year). Only narrows the SQL read;
 *  every item is re-judged with localDate() below, so the HR date owner decides. */
const hrDayStart = (iso: string) => new Date(`${iso}T00:00:00+08:00`);

/** Items whose wait at the current stage began on or before `dueOn` (HR-local date). */
export async function overdueChaseItemsTx(tx: Tx, source: AgentAutomaticSource, dueOn: string, ids: readonly string[] | null = null, limit = 2000): Promise<ChaseItem[]> {
  if (source === 'employment_review') {
    const rows = await tx.execute<{ review_id: string; subject_employment_id: string; subject_company_id: string; review_type: string; stage: string; end_date: unknown }>(
      sql`select * from app.agent_overdue_employment_reviews(${dueOn}::date, ${idArray(ids)}, ${limit}::integer)`);
    return Array.from(rows).map(r => ({ itemId: r.review_id, subjectEmploymentId: r.subject_employment_id, companyId: r.subject_company_id,
      stage: r.stage, waitingOn: isoDay(r.end_date), reviewType: r.review_type }))
      .filter(r => r.waitingOn <= dueOn);
  }
  const before = hrDayStart(addDaysIso(dueOn, 1)).toISOString();
  const rows = await tx.execute<{ item_id: string; subject_employment_id: string; subject_company_id: string; stage: string; waiting_since: unknown }>(
    sql`select * from app.agent_overdue_approvals(${source}, ${before}::timestamptz, ${idArray(ids)}, ${limit}::integer)`);
  return Array.from(rows).map(r => ({ itemId: r.item_id, subjectEmploymentId: r.subject_employment_id, companyId: r.subject_company_id,
    stage: r.stage, waitingOn: localDate(asDate(r.waiting_since)) }))
    .filter(r => r.waitingOn <= dueOn);
}

export type ChaseOutcome = 'sent' | 'cooled' | 'exhausted' | 'changed';
/** `noWorkingDays`: the requester's roster has no working dates, so nothing can ever be overdue (the escalation's
 *  empty-roster skip); counted, never chased. */
export type ChaseCounts = Record<ChaseOutcome, number> & { noWorkingDays: number; cappedOut: boolean };

/** Elapsed working days in (fromDate, today] for one employment, or null when its roster has no working dates. */
export type WorkingDayCalendar = (employmentId: string, fromDate: string, today: string) => Promise<number | null>;

/** The calendar read from a system engine context (never the principal), with one read per (employment, dates). */
export function engineWorkingDayCalendar(readCtx: SessionContext): WorkingDayCalendar {
  if (isAgentContext(readCtx)) throw new Error('The working-day calendar is read by the engine context, not the agent principal.');
  const cache = new Map<string, Promise<number | null>>();
  return (employmentId, fromDate, today) => {
    const key = `${employmentId}:${fromDate}:${today}`;
    let hit = cache.get(key);
    if (!hit) { hit = withTenant(readCtx, tx => elapsedWorkingDaysTx(tx, employmentId, fromDate, today), { readOnlySnapshot: true }); cache.set(key, hit); }
    return hit;
  };
}
export type ChaseRunResult = {
  specialist: AgentAutomaticSpecialist;
  /** Why nothing ran: the switch is off or not attributed, or the notifications module is not held. */
  disabled: false | 'off' | 'module_off';
  /** The switch changed during the run, so the run stopped at that point. */
  stopped: boolean;
  byAction: Partial<Record<AutomaticChaseActionId, ChaseCounts>>;
  sent: number;
};

/**
 * Chase one item inside its own transaction. Re-checks authority, the item and earlier receipts under a lock;
 * the event is the receipt. Returns 'stopped' (as a thrown refusal) when the switch changed.
 */
async function chaseOneTx(tx: Tx, ctx: SessionContext, actionId: AutomaticChaseActionId, item: ChaseItem, today: string, workingDays: number): Promise<ChaseOutcome> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.tenantId}), hashtext(${actionId + ':' + item.itemId}))`);
  const { action, fresh } = await assertAutomaticChaserTx(tx, ctx, actionId);
  const p = action.automatic;
  const dueOn = addDaysIso(today, -p.overdueAfterDays);
  const [now] = await overdueChaseItemsTx(tx, p.source, dueOn, [item.itemId], 1);
  // Decided, withdrawn, moved to another stage or no longer overdue since the candidate read: nothing to chase.
  // The working-day count was taken for this wait; a restarted clock (a new decision) is a different wait.
  if (!now || now.stage !== item.stage || now.subjectEmploymentId !== item.subjectEmploymentId || now.waitingOn !== item.waitingOn) return 'changed';
  const prior = await tx.select({ at: schema.domainEvent.occurredAt }).from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, ctx.tenantId), eq(schema.domainEvent.eventType, eventFor(p.source)),
      eq(schema.domainEvent.aggregateType, CHASE_AGGREGATE), eq(schema.domainEvent.aggregateId, item.itemId),
      sql`${schema.domainEvent.payload} ->> 'action' = ${action.id}`, sql`${schema.domainEvent.payload} ->> 'stage' = ${now.stage}`))
    .orderBy(desc(schema.domainEvent.occurredAt), desc(schema.domainEvent.sequence));
  if (prior.length >= p.maxPerItem) return 'exhausted';
  if (prior[0] && localDate(asDate(prior[0].at)) > addDaysIso(today, -p.cooldownDays)) return 'cooled';
  await appendEvent(tx, {
    tenantId: ctx.tenantId, aggregateType: CHASE_AGGREGATE, aggregateId: now.itemId, eventType: eventFor(p.source),
    // Nobody pressed send: the actor is the principal and the stamp names the administrator's switch-on.
    actor: agentActor(fresh), subjectEmploymentId: now.subjectEmploymentId,
    // Ids, stage and dates only; the notification registry renders a fixed template from these.
    payload: { action: action.id, source: p.source, stage: now.stage, companyId: now.companyId, waitingOn: now.waitingOn,
      workingDaysWaiting: workingDays, chaseNumber: prior.length + 1,
      ...(now.reviewType ? { reviewType: now.reviewType } : {}), ...agentStamp(fresh, [p.specialist]) },
  });
  return 'sent';
}

export type ChaserRunOptions = { today?: string; calendar: WorkingDayCalendar };

async function runChasers(ctx: SessionContext, specialist: 'approval_chasers'|'review_chasers', opts: ChaserRunOptions): Promise<ChaseRunResult> {
  if (!isAgentContext(ctx)) throw new AutomaticChaserRefusal('not_agent');
  if (typeof opts?.calendar !== 'function') throw new Error('Automatic chasers need the working-day calendar.');
  ctx = { ...ctx, roles: ctx.roles?.slice(), grants: ctx.grants?.map(g => ({ ...g })) };
  const today = opts.today ?? todayInKualaLumpur();
  const result: ChaseRunResult = { specialist, disabled: false, stopped: false, byAction: {}, sent: 0 };
  if (!SWITCH_ON[specialist](ctx) || !agentHolds(ctx, specialist)) return { ...result, disabled: 'off' };
  if (!isModuleEnabled(ctx, 'notifications')) return { ...result, disabled: 'module_off' };
  for (const action of AUTOMATIC_CHASE_ACTIONS.filter(a => a.automatic.specialist === specialist)) {
    const p = action.automatic;
    const counts: ChaseCounts = { sent: 0, cooled: 0, exhausted: 0, changed: 0, noWorkingDays: 0, cappedOut: false };
    result.byAction[action.id] = counts;
    const candidates = await withTenant(ctx, tx => overdueChaseItemsTx(tx, p.source, addDaysIso(today, -p.overdueAfterDays)));
    for (const item of candidates) {
      if (counts.sent >= p.maxPerRun) { counts.cappedOut = true; break; }
      // Calendar days are only the SQL pre-filter; the working-day clock decides.
      const workingDays = await opts.calendar(item.subjectEmploymentId, item.waitingOn, today);
      if (workingDays == null) { counts.noWorkingDays++; continue; }
      if (workingDays < p.overdueAfterDays) continue;
      let outcome: ChaseOutcome;
      try { outcome = await withTenant(ctx, tx => chaseOneTx(tx, ctx, action.id, item, today, workingDays)); }
      catch (e) {
        if (e instanceof AutomaticChaserRefusal) { result.stopped = true; return result; }
        throw e;
      }
      counts[outcome]++;
      if (outcome === 'sent') result.sent++;
    }
  }
  return result;
}

/** Nightly: remind current approvers of overdue claims, attendance corrections and replacement leave requests. */
export async function runApprovalChasers(ctx: SessionContext, opts: ChaserRunOptions): Promise<ChaseRunResult> {
  return runChasers(ctx, 'approval_chasers', opts);
}

/** Nightly: remind the manager or HR about probation, contract and internship reviews undecided after their end date. */
export async function runReviewChasers(ctx: SessionContext, opts: ChaserRunOptions): Promise<ChaseRunResult> {
  return runChasers(ctx, 'review_chasers', opts);
}
