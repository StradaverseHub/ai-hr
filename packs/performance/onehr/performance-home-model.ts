/**
 * D-P1-32 PT-X3: the Performance & Talent home (/performance/home). PURE composition over facts the owners already
 * decide; nothing here reads the database, decides a band or widens what a viewer may see.
 *
 * Owners (read by performance-home-service.ts):
 *   Cycle rail, Your next step, Where you stand  getPerformanceHomeBlock (home-cards.ts): the WP-A2 block, the one
 *                                                owner of the own steps, the next step and the released-only row
 *                                                (DQ-1: WHERE_YOU_STAND_RULE).
 *   Team and lead rows                           performanceWorkspaceTx items (the same items the tab gates read).
 *   Leader cards                                 getLeaderStatus (0666): highest live seat; HOD gets none.
 *   Not in this cycle's review                   the own review's participation (app.assessment_review_participates)
 *                                                and, for the D-P1-22 unit rule, app.onehr_reviewer_unit_out.
 *   Between cycles, history                      getAssessmentPersonalRecord (released results only) and the
 *                                                existing record AI read component (no new model call).
 *   Your tools                                   the tab registry (tab-model.ts): only tabs whose gate is open.
 *
 * Card order and conditions follow the source dashboard (D-P1-32 X0 §6, P1-05 §1.2 items 1-7). The leader card,
 * the not-in card and Where you stand are ONE slot, in that precedence, as in the source. Learning is not drawn
 * (D6). The between-cycles Talent Box card is DEFERRED (DQ-6): see `talentBox` below.
 *
 * Runtime imports are pure modules only (tab registry, participation model), so the page component can import
 * the layout without pulling server code.
 */
import { serviceBeyondYear } from './participation-model';
import { performanceAreaStrip, performanceAreaStrips, performanceAreaTab, type PerformanceAreaFacts, type PerformanceAreaStrip, type PerformanceTabId } from './tab-model';
import type { HomeNextStep, HomeStanding, HomeStep, HomeStepKey, HomeTeam, PerformanceHomeBlock } from './home-cards';
import type { LeaderStatus } from './leader-status-service';
import type { PerformanceWorkspaceItem } from './service';

export type RunningLeaderStatus = Extract<LeaderStatus, { mode: 'running' }>;
export type RecordLeaderStatus = Extract<LeaderStatus, { mode: 'record' }>;
export type HomeWorkItem = Pick<PerformanceWorkspaceItem, 'id' | 'kind' | 'cycleId' | 'view' | 'module' | 'stage' | 'state' | 'title' | 'axis'>;

/**
 * Why the viewer is not in their own review this cycle, from what the viewer may read about themselves. The unit
 * rule (D-P1-22) first, as in participation precedence (ADR-0150); then the source's date reasons. A per-person
 * removal by HR is not readable by the person, so it reads as the plain 'notPart'.
 */
export type NotInReason = 'unitOut' | 'joinedAfterOpen' | 'confirmedAfterOpen' | 'probation' | 'notPart';
export function notInReason(f: { unitOut: boolean; hiredOn: string | null; confirmationDate: string | null; openedOn: string | null }): NotInReason {
  if (f.unitOut) return 'unitOut';
  if (!f.openedOn || !f.hiredOn) return 'notPart';
  if (f.hiredOn > f.openedOn) return 'joinedAfterOpen';
  if (f.confirmationDate && f.confirmationDate.slice(0, 10) > f.openedOn) return 'confirmedAfterOpen';
  if (!f.confirmationDate && !serviceBeyondYear(f.hiredOn, f.openedOn)) return 'probation';
  return 'notPart';
}

/** The source's team tally for a leader outside their own review: people, waiting on you, still writing theirs, done. */
export type TeamCounts = { people: number; turn: number; wait: number; done: number };
export function teamCounts(items: readonly Pick<HomeWorkItem, 'id' | 'kind' | 'view' | 'state'>[]): TeamCounts | null {
  const team = items.filter((i) => i.kind === 'review' && i.view === 'team');
  if (!team.length) return null;
  const people = new Set(team.map((i) => i.id)).size;
  const turn = new Set(team.filter((i) => i.state === 'open').map((i) => i.id));
  const wait = new Set(team.filter((i) => !turn.has(i.id) && (i.state === 'waiting' || i.state === 'later')).map((i) => i.id));
  return { people, turn: turn.size, wait: wait.size, done: people - turn.size - wait.size };
}

export type LeadTab = Extract<PerformanceTabId, 'calibration.performance' | 'calibration.potential' | 'calibration.talentBox'>;
/** One row of "Your next step" after the first item. Every row is a link or an outline button, never solid. */
export type HomeRow =
  | { kind: 'team'; total: number; chips: HomeTeam['chips']; href: string }
  | { kind: 'lead'; key: string; title: string; tab: LeadTab; href: string }
  | { kind: 'feedback'; count: number; href: string };
export type HomeOwnNext = Exclude<HomeNextStep, { kind: 'none' }>;
export type HomeNext = {
  /** The one item with the page's one solid button. Null: "Nothing needs you right now". */
  primary: { kind: 'own'; next: HomeOwnNext } | { kind: 'row'; row: HomeRow } | null;
  rows: HomeRow[];
  /** When nothing needs the viewer: the next date the block knows (a part opens, or the cycle closes). */
  nextDate: Extract<HomeNextStep, { kind: 'none' }>['nextDate'];
};

const leadTab = (item: Pick<HomeWorkItem, 'stage' | 'axis'>): LeadTab =>
  item.stage === 'talent_box' ? 'calibration.talentBox' : item.axis === 'potential' ? 'calibration.potential' : 'calibration.performance';
const needsYou = (row: HomeRow) => (row.kind === 'team' ? row.total > 0 : row.kind === 'feedback' ? row.count > 0 : true);

/** Your next step: the block's own next step first; otherwise the first row that needs the viewer takes the button. */
export function homeNext(block: PerformanceHomeBlock | null, items: readonly HomeWorkItem[], cycleId: string): HomeNext {
  const inCycle = items.filter((i) => i.cycleId === cycleId);
  const rows: HomeRow[] = [];
  if (block?.team) rows.push({ kind: 'team', total: block.team.total, chips: block.team.chips, href: block.team.href });
  else {
    const team = teamCounts(inCycle);
    if (team) rows.push({ kind: 'team', total: team.turn, chips: [], href: `/performance/workspace?${new URLSearchParams({ cycle: cycleId, view: 'team' })}` });
  }
  for (const item of inCycle) {
    if (item.kind === 'calibration' && item.state === 'open') {
      rows.push({ kind: 'lead', key: `${item.id}.${item.stage}`, title: item.title, tab: leadTab(item), href: `/performance/assessment/calibration/${item.id}` });
    }
  }
  if (!block) {
    // With an own block, the 360 the viewer owes is already its next step (home-cards.ts reads the bell's feedback task).
    const owed = inCycle.filter((i) => i.kind === 'feedback' && i.state === 'open');
    if (owed.length) rows.push({ kind: 'feedback', count: owed.length, href: `/performance/assessment/feedback/${owed[0]!.id}` });
  }
  const own: HomeOwnNext | null = block && block.next.kind !== 'none' ? block.next : null;
  if (own) return { primary: { kind: 'own', next: own }, rows, nextDate: null };
  const first = rows.findIndex(needsYou);
  if (first >= 0) return { primary: { kind: 'row', row: rows[first]! }, rows: rows.filter((_, i) => i !== first), nextDate: null };
  return { primary: null, rows, nextDate: block && block.next.kind === 'none' ? block.next.nextDate : null };
}

export type HomeRail = { cycleId: string; cycleName: string; closesOn: string | null; steps: HomeStep[]; done: number; total: number };
export type HomeSlot =
  | { kind: 'leader'; status: RunningLeaderStatus }
  | { kind: 'notIn'; cycleName: string; reason: NotInReason; team: TeamCounts | null; leads: boolean }
  | { kind: 'stand'; standing: HomeStanding; detailsHref: string };

/** The one slot after Your next step, in the source's precedence: the leader card, else not-in, else Where you stand. */
export function homeSlot(input: {
  block: PerformanceHomeBlock | null;
  leader: LeaderStatus | null;
  notIn: { cycleName: string; reason: NotInReason } | null;
  items: readonly HomeWorkItem[];
  cycleId: string;
}): HomeSlot | null {
  const { block, leader, notIn } = input;
  if (leader && leader.mode === 'running') return { kind: 'leader', status: leader };
  if (!block && notIn) {
    const inCycle = input.items.filter((i) => i.cycleId === input.cycleId);
    return { kind: 'notIn', cycleName: notIn.cycleName, reason: notIn.reason, team: teamCounts(inCycle), leads: inCycle.some((i) => i.view !== 'mine') };
  }
  if (block) return { kind: 'stand', standing: block.standing, detailsHref: block.detailsHref };
  return null;
}

/**
 * The last cycle's journey (between cycles): the own steps of that cycle as the WP-A2 strip derives them for its
 * closed review, each done (Done or Released) or closed (anything else). Steps not required of the viewer drop out.
 */
export function pastJourney(steps: readonly HomeStep[]): { key: HomeStepKey; done: boolean }[] {
  return steps.filter((s) => s.state !== 'notRequired').map((s) => ({ key: s.key, done: s.state === 'done' || s.state === 'released' }));
}

export type HomeHistoryRow = { id: string; name: string; performance: string | null; potential: string | null; talent: string | null };
export type HomeResults = HomeHistoryRow & { recordHref: string; reportHref: string | null };
export type HomePlan = { year: number; status: 'draft' | 'shared' | 'closed'; goals: { id: string; area: string; status: string }[]; href: string };
export type HomeToolGroup = { strip: PerformanceAreaStrip; tabs: { id: PerformanceTabId; labelKey: string; href: string }[] };

/** Your tools: a door to each tab the viewer holds (gate 'open'), grouped by strip, the Dashboard itself excluded. */
export function toolDoors(facts: PerformanceAreaFacts): HomeToolGroup[] {
  const out: HomeToolGroup[] = [];
  for (const strip of performanceAreaStrips) {
    if (strip === 'home') continue;
    const tabs = performanceAreaStrip(facts, strip).filter((v) => v.state === 'open').flatMap((v) => {
      const entry = performanceAreaTab(v.id);
      return entry ? [{ id: v.id, labelKey: entry.labelKey, href: entry.href }] : [];
    });
    if (tabs.length) out.push({ strip, tabs });
  }
  return out;
}

export type PerformanceHomeView = {
  mode: 'running' | 'record';
  facts: PerformanceAreaFacts;
  /** Running: the cycle's rail. */
  rail: HomeRail | null;
  next: HomeNext | null;
  slot: HomeSlot | null;
  /** Between cycles: the last cycle's journey, each own step done or closed. */
  past: { cycleName: string; steps: { key: HomeStepKey; done: boolean }[] } | null;
  /** Between cycles: the viewer's own last record. Every value is null until it is released to them. */
  results: HomeResults | null;
  /** Between cycles: what a leader led (aggregate tallies over released people only, from getLeaderStatus). */
  led: RecordLeaderStatus | null;
  plan: HomePlan | null;
  /**
   * DQ-6 HOOK, DEFERRED: the between-cycles Talent Box card (the source's per-unit 9-box counts for BU CEO, BG CEO
   * and Group Chief) needs a new aggregate read that does not exist yet. Always null until that read is approved and
   * built; the page draws nothing for it (no placeholder).
   */
  talentBox: null;
  history: { rows: HomeHistoryRow[]; fullHref: string | null };
  tools: HomeToolGroup[];
  /**
   * DQ-11: Your tools' door to the legacy /performance page (manager check-ins and "awaiting you"), or null. Set only
   * when the viewer has manager check-ins or pending manager reviews there (check-ins-door.ts).
   */
  checkIns: string | null;
};

export type PerformanceHomeCardId = 'rail' | 'past' | 'next' | 'leader' | 'notIn' | 'stand' | 'results' | 'led' | 'plan' | 'history' | 'tools';
export type PerformanceHomeLayout = { top: PerformanceHomeCardId[]; main: PerformanceHomeCardId[]; side: PerformanceHomeCardId[]; bottom: PerformanceHomeCardId[] };
/**
 * Where each card goes, per the owner-approved layout: the rail across the top; a main column (Your next step / You
 * are here, then the leader or not-in card); a right column (Where you stand, then Your tools); Your history below.
 * Between cycles: the results (or, for a leader with no own record, What you led) in the main column; the plan (or
 * What you led beside an own record) and Your tools on the right. The columns stack on a narrow screen.
 */
export function performanceHomeLayout(view: PerformanceHomeView): PerformanceHomeLayout {
  if (view.mode === 'running') {
    const slot = view.slot?.kind;
    return {
      top: view.rail ? ['rail'] : [],
      main: slot === 'leader' || slot === 'notIn' ? ['next', slot] : ['next'],
      side: slot === 'stand' ? ['stand', 'tools'] : ['tools'],
      bottom: ['history'],
    };
  }
  const first: PerformanceHomeCardId = !view.results && view.led ? 'led' : 'results';
  const second: PerformanceHomeCardId[] = view.results && view.led ? ['led'] : view.plan ? ['plan'] : [];
  return { top: view.past ? ['past'] : [], main: [first], side: [...second, 'tools'], bottom: ['history'] };
}
