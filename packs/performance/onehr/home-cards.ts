/**
 * WP-A2 (APR-015) — the Performance block on Home: a READ MODEL over owners that already decide every fact.
 * Nothing here is a second workflow store, and nothing here decides visibility.
 *
 *   KPI / Competency / Career Plan  `reviewWorkspaceParts` (workspace-model.ts) over the viewer's own assessment
 *                       as `getOnehrReview` returns it — the derivation /performance/workspace uses for "mine".
 *   360 Feedback        `pendingOnehrFeedbackTaskMetadata` (the bell's feedback task: its window and recipient
 *                       gates) for "Your turn"; the viewer's own submitted panels in the cycle for "Done".
 *   Team review, Calibration and the team chips
 *                       `pendingPerformanceTasks` — the SAME projection the bell and the Home task count read. It
 *                       already contains `pendingCalibrationTasks`; adding that list again would double count.
 *   Results released and "Where you stand"
 *                       `getOnehrReview` — the employee's own-person projection, which returns a band ONLY once it
 *                       has been released to them. This file never reads a band from anywhere else.
 *
 * A step whose state cannot be derived from those owners is omitted, never guessed.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { SessionContext } from '../../../db/client';
import { onehrCalibration, onehrPanel, onehrReview, reviewCycle } from '../../../db/schema';
import { withPerformanceTenant } from '../../../core/module-gate';
import { isModuleEnabled } from '../../../core/entitlements';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import type { PackTaskItem, PackTaskKind } from '../../../lib/assigned-work';
import { pmBands, type PMBand, type Policy, type WindowCell } from './model';
import { assessmentWorkWindowOpen, reviewWorkspaceParts, type ReviewWorkPart } from './workspace-model';
import { getOnehrReview, pendingOnehrFeedbackTaskMetadata } from './service';
import { pendingPerformanceTasks } from './tasks';

export type HomeStepKey = 'kpi' | 'kpiSetting' | 'feedback360' | 'competency' | 'careerPlan' | 'teamReview' | 'calibration' | 'results';
/** The strip's state words. `waiting` carries a count ("12 waiting"); `yourTurn` may (colleagues owed feedback). */
export type HomeStepState = 'done' | 'yourTurn' | 'waiting' | 'locked' | 'inProgress' | 'released' | 'notRequired';
export type HomeStep = { key: HomeStepKey; state: HomeStepState; count?: number };
export type HomeNextStep =
  | { kind: 'kpi' | 'kpiSetting' | 'competency' | 'careerPlan'; done: number; total: number; dueOn: string | null; href: string }
  | { kind: 'feedback360'; colleagues: number; dueOn: string | null; href: string }
  | { kind: 'none'; nextDate: { kind: 'opens' | 'closes'; on: string } | null };
export type HomeTeamChip = { kind: PackTaskKind; count: number };
export type HomeTeam = { total: number; chips: HomeTeamChip[]; href: string };
/**
 * "Where you stand". Under the default rule (WHERE_YOU_STAND_RULE = 'releasedOnly') `band` exists ONLY on a released
 * performance row: the key set is the guarantee. The 'lineManagerApproved' row is produced only when the DQ-1 switch
 * below is flipped; it carries the line manager's approved band, never a score.
 */
export type HomeStanding = {
  performance: { state: 'released'; band: PMBand } | { state: 'lineManagerApproved'; band: PMBand } | { state: 'awaitingManager' | 'notReleased' } | null;
  competency: 'notSubmitted' | 'withManager' | 'reviewed' | null;
  /** Only once the line manager has reviewed the competencies: how many they marked demonstrated, of all. */
  competencyDemonstrated?: { done: number; total: number };
  feedback360: 'released' | 'notReleased';
  careerTarget: { state: 'set'; title: string } | { state: 'notSet' };
};
export type PerformanceHomeBlock = {
  cycle: { id: string; name: string; closesOn: string };
  steps: HomeStep[]; done: number; total: number;
  next: HomeNextStep; team: HomeTeam | null; standing: HomeStanding;
  detailsHref: string;
};

/**
 * DQ-1 (owner decision OPEN): what the Performance row of "Where you stand" shows before release.
 *   'releasedOnly'         AI-HR's rule (wave 2, P1-02): the band only once it is released to the person; before
 *                          that a state word ("Awaiting your manager" / "Not released yet"). THE DEFAULT.
 *   'lineManagerApproved'  the source's rule: the line manager's approved overall band as soon as the manager has
 *                          approved it, with a note that calibration may still change it.
 * This constant is the ONE switch. Both the AI-HR home block and /performance/home read it through deriveHomeBlock.
 * Neither rule ever shows a score, and neither shows a band the line manager has not approved.
 */
export type WhereYouStandRule = 'releasedOnly' | 'lineManagerApproved';
export const WHERE_YOU_STAND_RULE: WhereYouStandRule = 'releasedOnly';

/** The Performance row under a rule. `released` is the band the own-person projection returns (null until release). */
export function standingPerformance(rule: WhereYouStandRule, facts: { released: PMBand | null; managerPerformance: string | null }): NonNullable<HomeStanding['performance']> {
  if (facts.released) return { state: 'released', band: facts.released };
  const approved = pmBands.find((b) => b === facts.managerPerformance);
  if (rule === 'lineManagerApproved' && approved) return { state: 'lineManagerApproved', band: approved };
  return { state: facts.managerPerformance ? 'notReleased' : 'awaitingManager' };
}

const PART_STATE: Record<ReviewWorkPart['state'], HomeStepState> = { open: 'yourTurn', waiting: 'inProgress', done: 'done', later: 'locked' };
const TEAM_KINDS: readonly PackTaskKind[] = ['performanceReview', 'assessmentWork', 'careerPlan'];
const CHIP_ORDER: readonly PackTaskKind[] = ['performanceReview', 'assessmentWork', 'careerPlan', 'calibration'];
const klDate = (iso: string) => todayInKualaLumpur(new Date(iso));
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const idAfter = (prefix: string, linkPath: string) => new RegExp(`^${prefix}(${UUID})$`).exec(linkPath)?.[1] ?? null;
export const reviewIdOfTask = (linkPath: string) => idAfter('/performance/review/', linkPath);
export const sessionIdOfTask = (linkPath: string) => idAfter('/performance/assessment/calibration/', linkPath);
export const requestIdOfTask = (linkPath: string) => idAfter('/performance/assessment/feedback/', linkPath);

/** One own part as a strip step. An open part whose window is not open now cannot be acted on: Locked. */
export function ownPartStep(part: ReviewWorkPart, policy: Pick<Policy, 'windows'>, now: Date): HomeStep {
  const key: HomeStepKey = part.module === 'pm' ? (part.stage === 'setting' ? 'kpiSetting' : 'kpi') : part.module === 'tm' ? 'competency' : 'careerPlan';
  const state = PART_STATE[part.state];
  return { key, state: state === 'yourTurn' && !assessmentWorkWindowOpen(policy, part.cell, now) ? 'locked' : state };
}

/** "N of M done": Done or Released, over every step required of this viewer. */
export function stripProgress(steps: readonly HomeStep[]) {
  const counted = steps.filter((s) => s.state !== 'notRequired');
  return { done: counted.filter((s) => s.state === 'done' || s.state === 'released').length, total: counted.length };
}

/** The team row's chips, in a fixed order, from the task projection's own kinds. */
export function teamChips(tasks: readonly Pick<PackTaskItem, 'kind'>[]): HomeTeamChip[] {
  return CHIP_ORDER.map((kind) => ({ kind, count: tasks.filter((t) => t.kind === kind).length })).filter((c) => c.count > 0);
}

/**
 * The viewer's Performance block, or null when there is nothing to show: the module is off for the tenant, the
 * session has no person, or the viewer has no assessment of their own in an open cycle. `scopeIds` is the
 * company scope the bell passes, so the team count is the bell's count.
 */
export async function getPerformanceHomeBlock(ctx: SessionContext, scopeIds: string[] | undefined, now = new Date()): Promise<PerformanceHomeBlock | null> {
  if (!ctx.personId || !ctx.userId || !isModuleEnabled(ctx, 'performance')) return null;
  const own = await withPerformanceTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({ reviewId: onehrReview.reviewId, cycleId: reviewCycle.id, cycleName: reviewCycle.name, periodEnd: reviewCycle.periodEnd })
      .from(onehrReview).innerJoin(reviewCycle, eq(reviewCycle.id, onehrReview.cycleId))
      .where(and(
        inArray(reviewCycle.status, ['open', 'calibration']),
        sql`exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`,
        sql`app.assessment_review_participates(${onehrReview.reviewId})`,
      ))
      .orderBy(desc(reviewCycle.periodEnd), asc(onehrReview.reviewId)).limit(1);
    return row ?? null;
  });
  if (!own) return null;

  const [review, tasks, feedbackTasks] = await Promise.all([
    getOnehrReview(ctx, own.reviewId),
    pendingPerformanceTasks(ctx, scopeIds),
    pendingOnehrFeedbackTaskMetadata(ctx),
  ]);
  if (!review) return null;
  const linkedReviewIds = [...new Set(tasks.filter((t) => TEAM_KINDS.includes(t.kind)).map((t) => reviewIdOfTask(t.linkPath)).filter((id): id is string => !!id))];
  const cycleFacts = await withPerformanceTenant(ctx, async (tx) => {
    const panels = await tx.select({ id: onehrPanel.requestId, submitted: sql<boolean>`${onehrPanel.submittedAt} is not null` }).from(onehrPanel)
      .where(and(isNull(onehrPanel.archivedAt),
        sql`app.onehr_feedback_card(${onehrPanel.requestId})->>'cycleId' = ${own.cycleId}`,
        sql`exists(select 1 from employment e where e.id=${onehrPanel.peerEmploymentId} and app.is_self_person(e.person_id))`));
    const team = await tx.select({ reviewId: onehrReview.reviewId, managerPerformance: onehrReview.managerPerformance }).from(onehrReview)
      .where(and(eq(onehrReview.cycleId, own.cycleId), ne(onehrReview.reviewId, own.reviewId), sql`app.onehr_effective_reviewer(${onehrReview.reviewId})`, sql`app.assessment_review_participates(${onehrReview.reviewId})`,
        sql`not exists(select 1 from employment e where e.id=${onehrReview.employmentId} and app.is_self_person(e.person_id))`));
    // Named-reviewer sessions in THIS cycle (explicit or live seat holder), by hasCalibrationAssignment's predicates (no per-session work read).
    const sessions = await tx.select({ id: onehrCalibration.id, lockedAt: onehrCalibration.lockedAt }).from(onehrCalibration)
      .where(and(eq(onehrCalibration.cycleId, own.cycleId), ne(onehrCalibration.tier, 'final'),
        sql`app.onehr_calibration_reviewer(${onehrCalibration.id}, app.current_user_id())`, sql`app.onehr_calibration_access(${onehrCalibration.id})`));
    const inCycle = linkedReviewIds.length ? await tx.select({ id: onehrReview.reviewId }).from(onehrReview)
      .where(and(eq(onehrReview.cycleId, own.cycleId), inArray(onehrReview.reviewId, linkedReviewIds))) : [];
    return { panels, team, sessions, inCycle: new Set(inCycle.map((r) => r.id)) };
  });
  const thisCycle = new Set(cycleFacts.panels.map((p) => p.id));
  return deriveHomeBlock({
    own, review, tasks, now, inCycle: cycleFacts.inCycle, team: cycleFacts.team, sessions: cycleFacts.sessions,
    feedbackOpen: feedbackTasks.filter((f) => thisCycle.has(requestIdOfTask(f.linkPath) ?? '')),
    feedbackSubmitted: cycleFacts.panels.filter((p) => p.submitted).length,
  });
}

type Review = NonNullable<Awaited<ReturnType<typeof getOnehrReview>>>;

/** Pure composition over the owners' answers (exported for tests). */
export function deriveHomeBlock(input: {
  own: { reviewId: string; cycleId: string; cycleName: string; periodEnd: string };
  review: Pick<Review, 'policy' | 'kpis' | 'competencies' | 'competencyStatus' | 'resultsSubmitted' | 'managerPerformance' | 'plans' | 'planYear' | 'drafts' | 'result' | 'careerProfile'>;
  tasks: readonly PackTaskItem[];
  feedbackOpen: readonly { linkPath: string }[];
  feedbackSubmitted: number;
  team: readonly { reviewId: string; managerPerformance: string | null }[];
  sessions: readonly { id: string; lockedAt: Date | null }[];
  inCycle: ReadonlySet<string>;
  now: Date;
  /** DQ-1. Tests pass both values; every caller in the app takes the default. */
  standingRule?: WhereYouStandRule;
}): PerformanceHomeBlock {
  const { own, review, tasks, feedbackOpen, team, sessions, inCycle, now } = input;
  const standingRule = input.standingRule ?? WHERE_YOU_STAND_RULE;
  const policy = review.policy;
  const plan = review.plans.find((p) => p.planYear === review.planYear);
  const parts = reviewWorkspaceParts(policy, {
    kpis: review.kpis, competenciesAssigned: review.competencies.length > 0, competencyStatus: review.competencyStatus,
    resultsSubmitted: review.resultsSubmitted, managerPerformance: review.managerPerformance, planStatus: plan?.status ?? null,
  }, { self: true, manager: false, employmentIds: [] });
  const part = (m: ReviewWorkPart['module']) => parts.find((p) => p.module === m);
  const pm = part('pm'), tm = part('tm'), idp = part('idp');
  const steps: HomeStep[] = [];
  if (pm) steps.push(ownPartStep(pm, policy, now));
  if (feedbackOpen.length) steps.push({ key: 'feedback360', state: 'yourTurn', count: feedbackOpen.length });
  else if (input.feedbackSubmitted) steps.push({ key: 'feedback360', state: 'done' });
  if (tm) steps.push(ownPartStep(tm, policy, now));
  else if (policy.modules.tm && review.competencies.length === 0) steps.push({ key: 'competency', state: 'notRequired' });
  if (idp) steps.push(ownPartStep(idp, policy, now));
  const teamWaiting = tasks.filter((t) => TEAM_KINDS.includes(t.kind) && inCycle.has(reviewIdOfTask(t.linkPath) ?? '')).length;
  if (team.length || teamWaiting) {
    steps.push(teamWaiting ? { key: 'teamReview', state: 'waiting', count: teamWaiting }
      : { key: 'teamReview', state: team.every((r) => r.managerPerformance) ? 'done' : 'inProgress' });
  }
  if (sessions.length) {
    const ids = new Set(sessions.map((s) => s.id));
    const n = tasks.filter((t) => t.kind === 'calibration' && ids.has(sessionIdOfTask(t.linkPath) ?? '')).length;
    steps.push(n ? { key: 'calibration', state: 'waiting', count: n }
      : { key: 'calibration', state: sessions.every((s) => s.lockedAt) ? 'done' : 'inProgress' });
  }
  // The own-person projection: these flags and `result.performance` are what the employee's own page shows.
  const released = !!(review.result?.performanceReleased || review.result?.potentialReleased);
  steps.push({ key: 'results', state: released ? 'released' : 'locked' });

  const workspace = (module: 'pm' | 'tm' | 'idp') => `/performance/workspace?${new URLSearchParams({ cycle: own.cycleId, view: 'mine', module })}`;
  const due = (cell: WindowCell) => { const at = policy.windows[cell]?.closesAt; return at ? klDate(at) : null; };
  const results = review.drafts.map((d) => d.payload).find((p) => p.kind === 'results');
  const answers = review.drafts.map((d) => d.payload).find((p) => p.kind === 'competency_self');
  const mine = review.kpis.filter((k) => !k.hrOwned);
  let next: HomeNextStep | null = null;
  for (const step of steps) {
    if (next || step.state !== 'yourTurn') continue;
    if (step.key === 'feedback360') next = { kind: 'feedback360', colleagues: feedbackOpen.length, dueOn: due('f360'), href: feedbackOpen[0]!.linkPath };
    else if (step.key === 'kpi' && pm) {
      const filled = policy.kind === 'quarterly' ? mine.filter((k) => !!k.checkIn).length
        : mine.filter((k) => k.actual != null || (results?.kind === 'results' && results.lines.some((l) => l.id === k.id && l.actual != null))).length;
      next = { kind: 'kpi', done: filled, total: mine.length, dueOn: due(pm.cell), href: workspace('pm') };
    } else if (step.key === 'kpiSetting' && pm) {
      next = { kind: 'kpiSetting', done: mine.filter((k) => k.setting === 'proposed' || k.setting === 'approved').length, total: mine.length, dueOn: due(pm.cell), href: workspace('pm') };
    } else if (step.key === 'competency' && tm) {
      const answered = review.competencies.filter((c) => !!c.self || (answers?.kind === 'competency_self' && !!answers.answers[c.id]?.answer)).length;
      next = { kind: 'competency', done: answered, total: review.competencies.length, dueOn: due(tm.cell), href: workspace('tm') };
    } else if (step.key === 'careerPlan' && idp) {
      next = { kind: 'careerPlan', done: plan?.goals.length ?? 0, total: policy.idpMinGoals, dueOn: due(idp.cell), href: workspace('idp') };
    }
  }
  if (!next) {
    const opens = parts.filter((p) => p.state !== 'done').map((p) => policy.windows[p.cell]?.opensAt)
      .filter((at): at is string => !!at && Date.parse(at) > now.getTime()).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    next = { kind: 'none', nextDate: opens ? { kind: 'opens', on: klDate(opens) } : own.periodEnd >= todayInKualaLumpur(now) ? { kind: 'closes', on: own.periodEnd } : null };
  }

  const teamRow: HomeTeam | null = team.length || sessions.length || tasks.length
    ? { total: tasks.length, chips: teamChips(tasks), href: `/performance/workspace?${new URLSearchParams({ cycle: own.cycleId, view: 'team' })}` }
    : null;

  // `result.performance` is null in the own-person projection until the band is released to this person.
  const band = review.result?.performance ?? null;
  const profileId = review.careerProfile?.career.targetProfileId ?? null;
  const target = profileId ? policy.profiles.find((p) => p.id === profileId) : undefined;
  const standing: HomeStanding = {
    performance: !policy.modules.pm ? null : standingPerformance(standingRule, { released: band, managerPerformance: review.managerPerformance }),
    competency: !policy.modules.tm || review.competencies.length === 0 ? null
      : review.competencyStatus === 'reviewed' ? 'reviewed' : review.competencyStatus === 'submitted' ? 'withManager' : 'notSubmitted',
    ...(policy.modules.tm && review.competencies.length > 0 && review.competencyStatus === 'reviewed'
      ? { competencyDemonstrated: { done: review.competencies.filter((c) => c.manager === 'yes').length, total: review.competencies.length } } : {}),
    feedback360: review.result?.feedbackReleased ? 'released' : 'notReleased',
    careerTarget: target ? { state: 'set', title: target.jobTitle || target.name } : { state: 'notSet' },
  };
  return { cycle: { id: own.cycleId, name: own.cycleName, closesOn: own.periodEnd }, steps, ...stripProgress(steps), next, team: teamRow, standing, detailsHref: '/me/performance' };
}

/**
 * D-P1-32 PT-X3: the rail of a viewer who leads in the cycle but has no participating own review there (a leader
 * outside their own review, a BG CEO). Only what the worklist (performanceWorkspaceTx items of that cycle)
 * derives: the 360 they owe, the team review and their calibration work, in the strip's order. No own step and no
 * results step: neither is derivable for them, and a step that cannot be derived is omitted, never guessed.
 */
export function leaderRailSteps(items: readonly { id: string; kind: 'review' | 'feedback' | 'calibration'; view: string; state: 'open' | 'waiting' | 'done' | 'later' }[]): HomeStep[] {
  const steps: HomeStep[] = [];
  const owed = items.filter((i) => i.kind === 'feedback');
  const owedOpen = owed.filter((i) => i.state === 'open').length;
  if (owed.length) steps.push(owedOpen ? { key: 'feedback360', state: 'yourTurn', count: owedOpen } : { key: 'feedback360', state: 'done' });
  const team = items.filter((i) => i.kind === 'review' && i.view === 'team');
  const teamOpen = new Set(team.filter((i) => i.state === 'open').map((i) => i.id)).size;
  if (team.length) steps.push(teamOpen ? { key: 'teamReview', state: 'waiting', count: teamOpen } : { key: 'teamReview', state: team.every((i) => i.state === 'done') ? 'done' : 'inProgress' });
  const lead = items.filter((i) => i.kind === 'calibration');
  const leadOpen = lead.filter((i) => i.state === 'open').length;
  if (lead.length) steps.push(leadOpen ? { key: 'calibration', state: 'waiting', count: leadOpen } : { key: 'calibration', state: lead.every((i) => i.state === 'done') ? 'done' : 'inProgress' });
  return steps;
}

/** D-P1-03: has the viewer any performance work assigned — the bell's own projection, nothing wider? */
export async function hasAssignedPerformanceWork(ctx: SessionContext, scopeIds: string[] | undefined): Promise<boolean> {
  if (!isModuleEnabled(ctx, 'performance')) return false;
  return (await pendingPerformanceTasks(ctx, scopeIds)).length > 0;
}
