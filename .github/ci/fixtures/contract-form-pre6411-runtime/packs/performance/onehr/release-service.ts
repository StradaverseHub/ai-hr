/**
 * WP-E (CF-08, APR-021 / APR-022) — the two-step result release and the leader read.
 *
 * The ONE writer of performance_assessment_release. Every release goes through releaseReviewTx: the
 * per-person panel (releaseOnehrResult, both steps at once, as the source's form without a step) and the bulk
 * page (releaseOnehrResults). Rules (release-model.ts decideRelease), decided from the row as locked:
 *   - a release needs a result that resolves; a re-release keeps the first timestamp;
 *   - release 2 (to the person) needs release 1 (to leaders) for that component, else "leaders first";
 *   - revoking release 1 is refused while release 2 stands, else "still with the person";
 *   - the 360 report is single-step to the person and needs the valid minimum of submissions.
 * The employee columns are mirrored into performance_onehr_result (compatibility projection for frozen
 * readers); leader columns are never mirrored.
 *
 * Authority stays AI-HR's (E-3): the cycle's OneHR administrator who administers the person's company and is
 * not the person (app.onehr_release_admin, the release row's own policy).
 *
 * Concurrency: one transaction; the per-review advisory lock freeze and calibration writes also take, in
 * sorted review order; then SELECT … FOR UPDATE on the release row. A concurrent revoke and release on the
 * same person serialise, and the second sees the first's result.
 *
 * Notices (after the writes, same transaction, so they follow commit through the event sweep): one
 * `onehr.results-to-leader` event per leader newly reached, with a count; one `onehr.results-to-person` event
 * per person newly told, naming the components. Never a band; nothing on revoke. The append-only ledger
 * (performance_assessment_release_notice, UNIQUE per review/component/step/recipient, ON CONFLICT DO
 * NOTHING) decides "newly" atomically and survives a revoke. Delivery stays under AI-HR's notification rules:
 * the bell always, email only by tenant category policy and the recipient's consent (E-6).
 */
import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionContext, Tx } from '../../../db/client';
import { actorOf, appendEvent } from '../../../db/events';
import { assessmentRelease, assessmentReleaseNotice, notificationEmailPolicy, onehrResult } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { policySchema, type Policy } from './model';
import {
  chainSteps, decideRelease, ledRelease, ledSummary, ledTabs, leaderComponents, matchesReleaseStatus, releaseResults, releaseRowState, releaseStatuses, releaseSteps,
  requestedComponents, seesAtOnce, type BoardCell, type LedTab, type LeaderChain, type LeaderComponent, type ReleaseAction, type ReleaseComponent, type ReleaseOutcome,
  type ReleaseRow, type ReleaseStatus, type ReleaseStep,
} from './release-model';

const uuid = z.uuid();
const uuids = (values: readonly string[]): SQL => (values.length ? sql`array[${sql.join(values.map((v) => sql`${v}::uuid`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`);
const EMPLOYEE = { performance: 'performanceReleasedAt', potential: 'potentialReleasedAt', talent: 'talentReleasedAt', feedback: 'feedbackReleasedAt' } as const;
const LEADER = { performance: 'performanceLeaderReleasedAt', potential: 'potentialLeaderReleasedAt', talent: 'talentLeaderReleasedAt' } as const;
const isLeaderComponent = (c: ReleaseComponent): c is LeaderComponent => (leaderComponents as readonly string[]).includes(c);

async function flag(tx: Tx, query: SQL): Promise<boolean> {
  const [row] = await tx.execute<{ ok: boolean | null }>(sql`select (${query}) as ok`);
  return !!row?.ok;
}
async function lockReview(tx: Tx, reviewId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${reviewId},0))`);
}
type Card = { frozen: boolean; result: { performance: string | null; potential: string | null; talent: string | null; performanceSource: string | null; potentialSource: string | null } } | null;
async function resultCard(tx: Tx, reviewId: string): Promise<Card> {
  const [row] = await tx.execute<{ value: Card }>(sql`select app.onehr_result_card(${reviewId}::uuid) as value`);
  return row?.value ?? null;
}
type Review = { reviewId: string; cycleId: string; employmentId: string; companyId: string; grade: string };
async function cyclePolicy(tx: Tx, cycleId: string): Promise<{ cycleId: string; policy: Policy; status: string }> {
  const [row] = await tx.execute<{ policy: unknown; status: string }>(sql`
    select cfg.policy, c.status::text as status from review_cycle c join performance_onehr_cycle cfg on cfg.cycle_id=c.id and cfg.tenant_id=c.tenant_id
    where c.id=${cycleId}::uuid and c.tenant_id=app.current_tenant_id()`);
  if (!row) throw Error('Performance review cycle not found.');
  return { cycleId, policy: policySchema.parse(row.policy), status: row.status };
}
/** The 360 report needs the valid minimum: one submission for a lettered grade, the cycle minimum otherwise. */
async function feedbackReady(tx: Tx, review: Review, policy: Policy): Promise<boolean> {
  const [row] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from performance_onehr_panel p where p.review_id=${review.reviewId}::uuid and p.archived_at is null and p.submitted_at is not null`);
  const minimum = /^\d+$/.test(review.grade.replace(/^JG\s*/i, '').trim()) ? policy.minValid : 1;
  return (row?.n ?? 0) >= minimum;
}

type Change = { review: Review; component: ReleaseComponent; outcome: ReleaseOutcome; next: ReleaseRow; before: ReleaseRow };

/**
 * One review, every requested component, from the locked row. The caller holds the review's advisory lock
 * and has already decided authority. Returns one change per component.
 */
async function releaseReviewTx(tx: Tx, ctx: SessionContext, review: Review, policy: Policy, components: readonly ReleaseComponent[], step: ReleaseStep, action: ReleaseAction, now: Date): Promise<Change[]> {
  const [locked] = await tx.select().from(assessmentRelease).where(eq(assessmentRelease.reviewId, review.reviewId)).for('update');
  const card = action === 'release' ? await resultCard(tx, review.reviewId) : null;
  const patch: Record<string, Date | null> = {}, changes: Change[] = [];
  for (const component of components) {
    const before: ReleaseRow = {
      employee: (locked?.[EMPLOYEE[component]] as Date | null | undefined) ?? null,
      leader: isLeaderComponent(component) ? ((locked?.[LEADER[component]] as Date | null | undefined) ?? null) : null,
    };
    const resolvable = action !== 'release' ? true
      : component === 'feedback' ? !!card && await feedbackReady(tx, review, policy)
      : !!card?.result[component];
    const decided = decideRelease(component, before, step, action, resolvable, now);
    if (decided.outcome === 'done') {
      if (decided.next.employee?.getTime() !== before.employee?.getTime()) patch[EMPLOYEE[component]] = decided.next.employee;
      if (isLeaderComponent(component) && decided.next.leader?.getTime() !== before.leader?.getTime()) patch[LEADER[component]] = decided.next.leader;
    }
    changes.push({ review, component, outcome: decided.outcome, next: decided.next, before });
  }
  if (!Object.keys(patch).length) return changes;
  const columns = patch as Partial<typeof assessmentRelease.$inferInsert>;
  if (locked) await tx.update(assessmentRelease).set({ ...columns, updatedBy: ctx.userId!, updatedAt: now }).where(eq(assessmentRelease.reviewId, review.reviewId));
  else await tx.insert(assessmentRelease).values({ tenantId: ctx.tenantId, reviewId: review.reviewId, ...columns, updatedBy: ctx.userId!, updatedAt: now });
  // Compatibility projection for frozen-result readers: employee columns only.
  const mirror = Object.fromEntries(Object.entries(patch).filter(([k]) => (Object.values(EMPLOYEE) as string[]).includes(k)));
  if (Object.keys(mirror).length) await tx.update(onehrResult).set(mirror as Partial<typeof onehrResult.$inferInsert>).where(eq(onehrResult.reviewId, review.reviewId));
  const interim = !card?.frozen;
  for (const c of changes.filter((x) => x.outcome === 'done')) {
    const employeeChanged = c.next.employee?.getTime() !== c.before.employee?.getTime();
    // Release 1 alone is administration history: the person is not told their result went to their leaders.
    const eventType = employeeChanged ? (action === 'release' ? 'onehr.result-released' : 'onehr.result-revoked') : (action === 'release' ? 'onehr.result-released-to-leaders' : 'onehr.result-revoked-from-leaders');
    await appendEvent(tx, {
      tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: review.reviewId, eventType, actor: actorOf(ctx),
      subjectEmploymentId: employeeChanged ? review.employmentId : undefined, payload: { component: c.component, step, interim: action === 'release' ? interim : undefined },
    });
  }
  return changes;
}

type Notified = { leaders: number; people: number };
/** Ledger and notice events for what this action released. Nothing for a revoke; never a band. */
async function noticesTx(tx: Tx, ctx: SessionContext, cycle: { cycleId: string; policy: Policy }, changes: readonly Change[], step: ReleaseStep, now: Date): Promise<Notified> {
  const out: Notified = { leaders: 0, people: 0 };
  const toLeaders = step !== 'employees' ? changes.filter((c) => isLeaderComponent(c.component) && c.next.leader && (c.outcome === 'done' || c.outcome === 'unchanged')) : [];
  const toPeople = step !== 'leaders' ? changes.filter((c) => c.next.employee && (c.outcome === 'done' || c.outcome === 'unchanged')) : [];
  if (toLeaders.length) {
    const reviewIds = [...new Set(toLeaders.map((c) => c.review.reviewId))].sort();
    const reach = await tx.execute<{ review_id: string; leader_role: string; employment_id: string }>(sql`select review_id, leader_role, employment_id from app.onehr_release_leaders(${uuids(reviewIds)}) order by employment_id, review_id, leader_role`);
    const leaders = [...new Set(reach.map((r) => r.employment_id))].sort();
    const eventOf = new Map(leaders.map((l) => [l, randomUUID()]));
    const rows = reach.flatMap((r) => toLeaders.filter((c) => c.review.reviewId === r.review_id).map((c) => ({
      tenantId: ctx.tenantId, reviewId: r.review_id, component: c.component, step: 'leaders', recipientEmploymentId: r.employment_id, eventId: eventOf.get(r.employment_id)!, notifiedBy: ctx.userId!, notifiedAt: now,
    })));
    const fresh = rows.length ? await tx.insert(assessmentReleaseNotice).values(dedupe(rows)).onConflictDoNothing().returning({ reviewId: assessmentReleaseNotice.reviewId, recipient: assessmentReleaseNotice.recipientEmploymentId }) : [];
    const moved = cycle.policy.kind === 'mid_year' ? new Set<string>()
      : new Set((await tx.execute<{ id: string }>(sql`select q as id from app.onehr_bg_moved(${uuids(reviewIds)}) q`)).map((r) => r.id));
    const unitOf = new Map((await tx.execute<{ review_id: string; name: string }>(sql`select r.review_id, c.legal_name as name from performance_onehr_review r join company c on c.id=r.company_id and c.tenant_id=r.tenant_id where r.review_id = any(${uuids(reviewIds)}) order by r.review_id`)).map((r) => [r.review_id, r.name]));
    for (const leader of leaders) {
      const people = [...new Set(fresh.filter((f) => f.recipient === leader).map((f) => f.reviewId))].sort();
      if (!people.length) continue;
      const asBu = people.filter((id) => reach.some((r) => r.employment_id === leader && r.review_id === id && r.leader_role === 'bu'));
      const payload: Record<string, unknown> = { cycleId: cycle.cycleId, count: people.length, both: step === 'both' };
      if (asBu.length && cycle.policy.kind !== 'mid_year') {
        payload.moved = asBu.filter((id) => moved.has(id)).length;
        payload.units = [...new Set(asBu.map((id) => unitOf.get(id)).filter((n): n is string => !!n))].sort();
      }
      await appendEvent(tx, { id: eventOf.get(leader), tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: cycle.cycleId, eventType: 'onehr.results-to-leader', actor: actorOf(ctx), subjectEmploymentId: leader, payload });
      out.leaders++;
    }
  }
  if (toPeople.length) {
    const reviewIds = [...new Set(toPeople.map((c) => c.review.reviewId))].sort();
    const reach = await tx.execute<{ review_id: string; employment_id: string }>(sql`select review_id, employment_id from app.onehr_release_people(${uuids(reviewIds)}) order by review_id`);
    const eventOf = new Map(reach.map((r) => [r.review_id, randomUUID()]));
    const rows = reach.flatMap((r) => toPeople.filter((c) => c.review.reviewId === r.review_id).map((c) => ({
      tenantId: ctx.tenantId, reviewId: r.review_id, component: c.component, step: 'person', recipientEmploymentId: r.employment_id, eventId: eventOf.get(r.review_id)!, notifiedBy: ctx.userId!, notifiedAt: now,
    })));
    const fresh = rows.length ? await tx.insert(assessmentReleaseNotice).values(dedupe(rows)).onConflictDoNothing().returning({ reviewId: assessmentReleaseNotice.reviewId, component: assessmentReleaseNotice.component }) : [];
    for (const r of reach) {
      const kinds = [...new Set(fresh.filter((f) => f.reviewId === r.review_id).map((f) => f.component))].sort((a, b) => releaseOrder(a) - releaseOrder(b));
      if (!kinds.length) continue;
      await appendEvent(tx, { id: eventOf.get(r.review_id), tenantId: ctx.tenantId, aggregateType: 'onehr', aggregateId: r.review_id, eventType: 'onehr.results-to-person', actor: actorOf(ctx), subjectEmploymentId: r.employment_id, payload: { cycleId: cycle.cycleId, kinds } });
      out.people++;
    }
  }
  return out;
}
const releaseOrder = (c: string) => ['performance', 'potential', 'talent', 'feedback'].indexOf(c);
function dedupe<T extends { reviewId: string; component: string; step: string; recipientEmploymentId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.reviewId}|${r.component}|${r.step}|${r.recipientEmploymentId}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// ── Per-person panel: both steps at once (the source's form without a step) ──────────────────────────────

/** Kept for the per-person admin panel: release or revoke one component to leaders and the person together. */
export async function releaseOnehrResult(ctx: SessionContext, reviewId: string, component: ReleaseComponent, release: boolean) {
  uuid.parse(reviewId); z.enum(['performance', 'potential', 'talent', 'feedback']).parse(component); z.boolean().parse(release);
  return withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ reviewId: string; cycleId: string; employmentId: string; companyId: string; grade: string }>(sql`
      select review_id as "reviewId", cycle_id as "cycleId", employment_id as "employmentId", company_id as "companyId", grade from performance_onehr_review where review_id=${reviewId}::uuid`);
    if (!row || !(await flag(tx, sql`app.onehr_cycle_admin(${row.cycleId}::uuid)`))) throw Error('Performance administrator access is required.');
    if (await flag(tx, sql`exists(select 1 from employment e where e.id=${row.employmentId}::uuid and app.is_self_person(e.person_id))`)) throw Error('Ask another administrator to release your results.');
    if (!(await flag(tx, sql`app.onehr_release_admin(${reviewId}::uuid)`))) throw Error('Performance administrator access is required.');
    const cycle = await cyclePolicy(tx, row.cycleId), now = new Date();
    await lockReview(tx, reviewId);
    if (release && !(await resultCard(tx, reviewId))) throw Error('This assessment is not available for release.');
    const [change] = await releaseReviewTx(tx, ctx, row, cycle.policy, [component], 'both', release ? 'release' : 'revoke', now);
    if (change.outcome === 'no-result') throw Error(component === 'feedback' ? 'Enough valid feedback submissions are required before releasing the report.' : 'There is no result to release for this component yet.');
    if (release) await noticesTx(tx, ctx, cycle, [change], 'both', now);
  });
}

// ── Bulk release ────────────────────────────────────────────────────────────────────────────────────────

const bulkSchema = z.object({
  cycleId: uuid,
  reviewIds: z.array(uuid).min(1).max(2000),
  result: z.enum(releaseResults),
  step: z.enum(releaseSteps),
  action: z.enum(['release', 'revoke']),
});
export type BulkReleaseInput = z.input<typeof bulkSchema>;
type Counts = Partial<Record<ReleaseComponent, number>>;
export type BulkReleaseResult = { done: Counts; noResult: Counts; leadersFirst: Counts; stillWithEmployee: Counts; notAllowed: number; notified: Notified };
const bump = (m: Counts, c: ReleaseComponent) => { m[c] = (m[c] ?? 0) + 1; };

/**
 * Release or revoke one result kind for many people at one step. Each person is decided on their own
 * locked row and counted: released/revoked, no result yet, release to leaders first, still with the person,
 * or not yours to release (another company, yourself, another cycle). Idempotent per person.
 */
export async function releaseOnehrResults(ctx: SessionContext, raw: BulkReleaseInput): Promise<BulkReleaseResult> {
  const p = bulkSchema.parse(raw);
  const ids = [...new Set(p.reviewIds)].sort();
  return withPerformanceTenant(ctx, async (tx) => {
    if (!(await flag(tx, sql`app.onehr_cycle_admin(${p.cycleId}::uuid)`))) throw Error('Performance administrator access is required.');
    const cycle = await cyclePolicy(tx, p.cycleId), now = new Date();
    const components = requestedComponents(p.result, p.step, cycle.policy.modules.tm);
    const out: BulkReleaseResult = { done: {}, noResult: {}, leadersFirst: {}, stillWithEmployee: {}, notAllowed: 0, notified: { leaders: 0, people: 0 } };
    const reviews = await tx.execute<Review & { allowed: boolean }>(sql`
      select r.review_id as "reviewId", r.cycle_id as "cycleId", r.employment_id as "employmentId", r.company_id as "companyId", r.grade, app.onehr_release_admin(r.review_id) as allowed
      from performance_onehr_review r where r.review_id = any(${uuids(ids)}) and r.cycle_id=${p.cycleId}::uuid order by r.review_id`);
    out.notAllowed = ids.length - reviews.filter((r) => r.allowed).length;
    if (!components.length) return out;
    const changes: Change[] = [];
    for (const r of reviews.filter((x) => x.allowed)) {
      await lockReview(tx, r.reviewId);
      changes.push(...await releaseReviewTx(tx, ctx, r, cycle.policy, components, p.step, p.action, now));
    }
    for (const c of changes) {
      if (c.outcome === 'done' || c.outcome === 'unchanged') bump(out.done, c.component);
      else if (c.outcome === 'no-result') bump(out.noResult, c.component);
      else if (c.outcome === 'leaders-first') bump(out.leadersFirst, c.component);
      else bump(out.stillWithEmployee, c.component);
    }
    if (p.action === 'release') out.notified = await noticesTx(tx, ctx, cycle, changes, p.step, now);
    return out;
  });
}

// ── The release board ───────────────────────────────────────────────────────────────────────────────────

const boardFilters = z.object({
  businessGroup: z.string().trim().max(300).optional().transform((v) => v || undefined),
  companyId: uuid.optional().or(z.literal('').transform(() => undefined)),
  department: z.string().trim().max(300).optional().transform((v) => v || undefined),
  status: z.enum(releaseStatuses).optional().or(z.literal('').transform(() => undefined)),
});
export type ReleaseBoardFilters = z.input<typeof boardFilters>;
export type ReleaseBoardCell = BoardCell & { stage: string | null };
export type ReleaseBoardRow = {
  reviewId: string; employmentId: string; name: string; employeeCode: string | null; department: string | null; grade: string; companyId: string; company: string; businessGroup: string;
  performance: ReleaseBoardCell | null; potential: ReleaseBoardCell | null; talent: ReleaseBoardCell | null;
  report: { final: boolean; employeeAt: string | null } | null;
  leaders: { lm: string[]; hod: string[]; bu: string[] };
  state: ReturnType<typeof releaseRowState>;
};
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

/** One row per releasable person in the cycle, with the step counts taken before the Show filter. */
export async function getOnehrReleaseBoard(ctx: SessionContext, cycleId: string, raw: ReleaseBoardFilters = {}) {
  uuid.parse(cycleId);
  const f = boardFilters.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    if (!(await flag(tx, sql`app.onehr_cycle_admin(${cycleId}::uuid)`))) throw Error('Performance administrator access is required.');
    const cycle = await cyclePolicy(tx, cycleId);
    const [named] = await tx.execute<{ name: string }>(sql`select name from review_cycle where id=${cycleId}::uuid`);
    type Raw = { review_id: string; employment_id: string; company_id: string; grade: string; full_name: string | null; employee_code: string | null; company: string; business_group: string; department: string | null;
      card: Card; panels: number; pl: string | null; ol: string | null; tl: string | null; pe: string | null; oe: string | null; te: string | null; fe: string | null };
    const rows = await tx.execute<Raw>(sql`
      select r.review_id, r.employment_id, r.company_id, r.grade, l.full_name, l.employee_code, co.legal_name as company, coalesce(bg.legal_name,'') as business_group,
       (select d.name from app.onehr_assignment a join department d on d.id=a.department_id and d.tenant_id=a.tenant_id
        where a.employment_id=r.employment_id and a.tenant_id=r.tenant_id and a.superseded_at is null and a.valid_from<=(now() at time zone 'Asia/Kuala_Lumpur')::date
         and (a.valid_to is null or a.valid_to>(now() at time zone 'Asia/Kuala_Lumpur')::date) order by a.valid_from desc, a.id limit 1) as department,
       app.onehr_result_card(r.review_id) as card,
       (select count(*)::int from performance_onehr_panel pp where pp.review_id=r.review_id and pp.tenant_id=r.tenant_id and pp.archived_at is null and pp.submitted_at is not null) as panels,
       rel.performance_leader_released_at as pl, rel.potential_leader_released_at as ol, rel.talent_leader_released_at as tl,
       rel.performance_released_at as pe, rel.potential_released_at as oe, rel.talent_released_at as te, rel.feedback_released_at as fe
      from performance_onehr_review r
      join company co on co.id=r.company_id and co.tenant_id=r.tenant_id
      left join company bg on bg.id=co.parent_company_id and bg.tenant_id=co.tenant_id
      left join lateral (select x.full_name, x.employee_code from app.onehr_person_labels(array[r.employment_id]::uuid[]) x limit 1) l on true
      left join performance_assessment_release rel on rel.review_id=r.review_id and rel.tenant_id=r.tenant_id
      where r.cycle_id=${cycleId}::uuid and r.tenant_id=app.current_tenant_id() and app.onehr_release_admin(r.review_id)
      order by l.full_name nulls last, r.review_id`);
    const withResult = rows.filter((r) => r.card);
    const leaders = withResult.length ? await tx.execute<{ review_id: string; leader_role: 'lm' | 'hod' | 'bu'; full_name: string }>(sql`
      select review_id, leader_role, full_name from app.onehr_release_leaders(${uuids(withResult.map((r) => r.review_id))}) order by review_id, leader_role, full_name`) : [];
    const minimum = (grade: string) => (/^\d+$/.test(grade.replace(/^JG\s*/i, '').trim()) ? cycle.policy.minValid : 1);
    const cell = (band: string | null | undefined, source: string | null | undefined, frozen: boolean, leaderAt: string | null, employeeAt: string | null): ReleaseBoardCell | null =>
      band ? { band, final: frozen, stage: frozen ? 'final' : source ?? null, leaderAt: iso(leaderAt), employeeAt: iso(employeeAt) } : null;
    const all: ReleaseBoardRow[] = withResult.map((r) => {
      const c = r.card!, frozen = c.frozen;
      const performance = cell(c.result.performance, c.result.performanceSource, frozen, r.pl, r.pe);
      const potential = cycle.policy.modules.tm ? cell(c.result.potential, c.result.potentialSource, frozen, r.ol, r.oe) : null;
      const talent = cycle.policy.modules.tm ? cell(c.result.talent, null, frozen, r.tl, r.te) : null;
      const mine = leaders.filter((l) => l.review_id === r.review_id);
      return {
        reviewId: r.review_id, employmentId: r.employment_id, name: r.full_name ?? '', employeeCode: r.employee_code, department: r.department, grade: r.grade, companyId: r.company_id, company: r.company, businessGroup: r.business_group,
        performance, potential, talent,
        report: cycle.policy.modules.tm ? { final: r.panels >= minimum(r.grade), employeeAt: iso(r.fe) } : null,
        leaders: { lm: mine.filter((l) => l.leader_role === 'lm').map((l) => l.full_name), hod: mine.filter((l) => l.leader_role === 'hod').map((l) => l.full_name), bu: mine.filter((l) => l.leader_role === 'bu').map((l) => l.full_name) },
        state: releaseRowState([performance, potential, talent].filter((x): x is ReleaseBoardCell => !!x)),
      };
    });
    const groups = [...new Set(all.map((r) => r.businessGroup).filter(Boolean))].sort();
    const businessGroup = f.businessGroup && groups.includes(f.businessGroup) ? f.businessGroup : undefined;
    const inGroup = businessGroup ? all.filter((r) => r.businessGroup === businessGroup) : all;
    const companies = [...new Map(inGroup.map((r) => [r.companyId, r.company])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const companyId = f.companyId && companies.some((c) => c.id === f.companyId) ? f.companyId : undefined;
    const inCompany = companyId ? inGroup.filter((r) => r.companyId === companyId) : inGroup;
    const departments = [...new Set(inCompany.map((r) => r.department).filter((d): d is string => !!d))].sort();
    const scoped = f.department ? inCompany.filter((r) => (r.department ?? '') === f.department) : inCompany;
    const counts = {
      all: scoped.length, ready: scoped.filter((r) => r.state.ready).length, withLeaders: scoped.filter((r) => r.state.withLeaders).length, toEmp: scoped.filter((r) => r.state.toEmp).length,
      leadAll: scoped.filter((r) => r.state.leadAll).length, notFinal: scoped.filter((r) => r.state.notFinal).length, leadOpen: scoped.filter((r) => r.state.leadOpen).length,
    };
    const shown = scoped.filter((r) => matchesReleaseStatus(f.status as ReleaseStatus | undefined, [r.performance, r.potential, r.talent].filter((x): x is ReleaseBoardCell => !!x), r.state));
    const [policyRow] = isModuleEnabled(ctx, 'notifications') ? await tx.select({ enabled: notificationEmailPolicy.enabled }).from(notificationEmailPolicy).where(eq(notificationEmailPolicy.category, 'performance')) : [];
    return {
      cycle: { id: cycleId, name: named?.name ?? '', status: cycle.status, kind: cycle.policy.kind, potential: cycle.policy.modules.tm },
      filters: { businessGroup: businessGroup ?? '', companyId: companyId ?? '', department: f.department ?? '', status: (f.status as ReleaseStatus | undefined) ?? '' },
      options: { businessGroups: groups, companies, departments },
      counts, rows: shown,
      /** Workflow email for performance notices: on, off, or the notifications module not bought. */
      email: !isModuleEnabled(ctx, 'notifications') ? 'off' as const : policyRow?.enabled ? 'on' as const : 'off' as const,
    };
  });
}

// ── What you led ────────────────────────────────────────────────────────────────────────────────────────

const ledSchema = z.object({ cycleId: uuid.optional(), tab: z.enum(ledTabs).optional() });
type LedRaw = { review_id: string; tabs: string[]; full_name: string; employee_code: string | null; department: string | null; grade: string; company: string | null; leaders_at: string | null; released_at: string | null; chain: LeaderChain | null };

/**
 * The people the viewer leads in one cycle, one tab per seat (narrowest first), each with what release 1 lets
 * the viewer read now. A viewer who leads nobody gets empty lists, never a refusal that would tell them more.
 */
export async function listOnehrLedPeople(ctx: SessionContext, raw: z.input<typeof ledSchema> = {}) {
  const p = ledSchema.parse(raw);
  return withPerformanceTenant(ctx, async (tx) => {
    const cycles = (await tx.execute<{ cycle_id: string; name: string; period_end: string | Date; status: string; people: number }>(sql`select * from app.onehr_led_cycles()`))
      .map((c) => ({ id: c.cycle_id, name: c.name, periodEnd: c.period_end instanceof Date ? c.period_end.toISOString().slice(0, 10) : String(c.period_end).slice(0, 10), status: c.status, people: c.people }));
    const cycle = cycles.find((c) => c.id === p.cycleId) ?? cycles[0] ?? null;
    if (!cycle) return { cycles, cycle: null, tabs: [], tab: null, state: 'before' as const, atOnce: false, nFull: 0, nRes: 0, midYear: false, filter: null, people: [] };
    const rows = await tx.execute<LedRaw>(sql`select * from app.onehr_led_people(${cycle.id}::uuid)`);
    const tabs = ledTabs.map((key) => ({ key, n: rows.filter((r) => r.tabs.includes(key)).length })).filter((t) => t.n > 0);
    const tab: LedTab | null = tabs.find((t) => t.key === p.tab)?.key ?? tabs.at(-1)?.key ?? null;
    const people = rows.filter((r) => tab && r.tabs.includes(tab) && r.chain).map((r) => {
      const chain = r.chain!, summary = ledSummary(chain);
      return {
        reviewId: r.review_id, name: r.full_name, employeeCode: r.employee_code, department: r.department, grade: r.grade, company: r.company ?? '',
        role: chain.role, midYear: chain.midYear, summary, release: ledRelease(chain.role, summary, chain.midYear, iso(r.leaders_at), iso(r.released_at)),
        axes: chain.axes.map((a) => ({ axis: a.axis, final: a.final, full: a.full, hasResult: a.hasResult, steps: chainSteps(a, chain.role) })),
      };
    });
    const nRes = people.filter((x) => !x.summary.none).length, nFull = people.filter((x) => x.summary.full && !x.summary.none).length;
    const filterKey = tab === 'bg' ? 'company' as const : tab === 'bu' ? 'department' as const : null;
    const filter = filterKey ? { key: filterKey, items: [...people.reduce((m, x) => { const v = x[filterKey]; if (v) m.set(v, (m.get(v) ?? 0) + 1); return m; }, new Map<string, number>()).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, n]) => ({ value, n })) } : null;
    return {
      cycles, cycle, tabs, tab, filter, people, nRes, nFull,
      state: nRes && nFull === nRes ? 'after' as const : nFull ? 'mixed' as const : 'before' as const,
      atOnce: people.some((x) => seesAtOnce(x.role)), midYear: people.some((x) => x.midYear),
    };
  });
}

/** One led person's band movement on both axes, cut at the viewer's step until release 1; null unless the viewer leads them. */
export async function getOnehrLedPerson(ctx: SessionContext, reviewId: string) {
  uuid.parse(reviewId);
  return withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx.execute<{ chain: LeaderChain | null }>(sql`select app.onehr_leader_result(${reviewId}::uuid) as chain`);
    const chain = row?.chain;
    if (!chain) return null;
    return { reviewId, role: chain.role, midYear: chain.midYear, talent: chain.talent, axes: chain.axes.map((a) => ({ axis: a.axis, final: a.final, full: a.full, hasResult: a.hasResult, steps: chainSteps(a, chain.role) })) };
  });
}

/** Does the viewer lead anyone in a OneHR cycle? (The /performance link and entry.) */
export async function hasLedPeople(ctx: SessionContext): Promise<boolean> {
  if (!ctx.userId || !isModuleEnabled(ctx, 'performance')) return false;
  return withPerformanceTenant(ctx, async (tx) => ((await tx.execute<{ n: number }>(sql`select count(*)::int as n from app.onehr_led_cycles()`))[0]?.n ?? 0) > 0);
}
