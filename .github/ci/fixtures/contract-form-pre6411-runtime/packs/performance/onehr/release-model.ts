/**
 * WP-E (CF-08) — pure rules of the two-step result release and the leader read. The release service applies
 * them to rows it has locked; the screens apply the board and summary rules to rows the service returns.
 *
 * Step 1 ("leaders") releases performance, potential and talent to the person's line manager, HOD and business
 * unit CEO. Step 2 ("employees") releases a component to the person, and only once it is with their leaders.
 * "both" is the per-person panel's single action: it releases (or revokes) both steps at once. The 360 report
 * is single-step to the person.
 */
export const releaseComponents = ['performance', 'potential', 'talent', 'feedback'] as const;
export type ReleaseComponent = (typeof releaseComponents)[number];
export const leaderComponents = ['performance', 'potential', 'talent'] as const;
export type LeaderComponent = (typeof leaderComponents)[number];
export const releaseSteps = ['leaders', 'employees', 'both'] as const;
export type ReleaseStep = (typeof releaseSteps)[number];
export const releaseResults = ['three', 'performance', 'potential', 'talent', 'feedback'] as const;
export type ReleaseResult = (typeof releaseResults)[number];
export type ReleaseAction = 'release' | 'revoke';
export type ReleaseOutcome = 'done' | 'unchanged' | 'no-result' | 'leaders-first' | 'still-with-employee';
export const releaseStatuses = ['pending', 'released', 'ready', 'with_leaders', 'to_emp', 'notfinal'] as const;
export type ReleaseStatus = (typeof releaseStatuses)[number];

/** The components one request names. 'three' is performance, potential and talent, or performance alone when
 * the cycle has no potential axis. Release 1 never carries the 360 report. */
export function requestedComponents(result: ReleaseResult, step: ReleaseStep, tm: boolean): ReleaseComponent[] {
  const picked: ReleaseComponent[] = result === 'three' ? (tm ? ['performance', 'potential', 'talent'] : ['performance']) : [result];
  return step === 'leaders' ? picked.filter((c) => c !== 'feedback') : picked;
}

export type ReleaseRow = { employee: Date | null; leader: Date | null };

/**
 * One component's decision from the row as locked. A release requires a result that resolves (`resolvable`);
 * a re-release keeps the first timestamp. Step 2 requires step 1; revoking step 1 is refused while step 2
 * stands. The 360 report has no leader step.
 */
export function decideRelease(component: ReleaseComponent, row: ReleaseRow, step: ReleaseStep, action: ReleaseAction, resolvable: boolean, now: Date): { outcome: ReleaseOutcome; next: ReleaseRow } {
  const single = component === 'feedback';
  if (single && step === 'leaders') throw Error('The 360 report goes to the person only.');
  const result = (next: ReleaseRow): { outcome: ReleaseOutcome; next: ReleaseRow } =>
    ({ outcome: next.employee?.getTime() !== row.employee?.getTime() || next.leader?.getTime() !== row.leader?.getTime() ? 'done' : 'unchanged', next });
  if (action === 'release') {
    if (!resolvable) return { outcome: 'no-result', next: row };
    if (single) return result({ ...row, employee: row.employee ?? now });
    if (step === 'employees') return row.leader ? result({ ...row, employee: row.employee ?? now }) : { outcome: 'leaders-first', next: row };
    if (step === 'leaders') return result({ ...row, leader: row.leader ?? now });
    return result({ leader: row.leader ?? now, employee: row.employee ?? now });
  }
  if (single || step === 'employees') return result({ ...row, employee: null });
  if (step === 'both') return result({ leader: null, employee: null });
  return row.employee ? { outcome: 'still-with-employee', next: row } : result({ ...row, leader: null });
}

export type BoardCell = { band: string | null; final: boolean; leaderAt: string | null; employeeAt: string | null };
export type BoardState = { ready: boolean; leadOpen: boolean; withLeaders: boolean; toEmp: boolean; leadAll: boolean; notFinal: boolean };
/** Where a person stands across the components that have a result (the source's row state). */
export function releaseRowState(cells: readonly BoardCell[]): BoardState {
  const ks = cells.filter((c) => c.band);
  return {
    ready: ks.some((x) => x.final && !x.leaderAt),
    leadOpen: ks.some((x) => !x.leaderAt),
    withLeaders: ks.some((x) => x.leaderAt && !x.employeeAt),
    toEmp: ks.length > 0 && ks.every((x) => x.employeeAt),
    leadAll: ks.length > 0 && ks.every((x) => x.leaderAt),
    notFinal: ks.some((x) => !x.final),
  };
}
/** The Show filter, applied after the counts are taken. 'pending' is anything with a result not yet released to the person. */
export function matchesReleaseStatus(status: ReleaseStatus | undefined, cells: readonly BoardCell[], s: BoardState): boolean {
  if (!status) return true;
  const pending = cells.some((c) => c.band && !c.employeeAt);
  if (status === 'pending') return pending;
  if (status === 'released') return !pending;
  return status === 'ready' ? s.ready : status === 'with_leaders' ? s.withLeaders : status === 'to_emp' ? s.toEmp : s.notFinal;
}

// ── The leader read ─────────────────────────────────────────────────────────────────────────────────────
export const leaderRoles = ['bg', 'group', 'bu', 'hod', 'lm'] as const;
export type LeaderRole = (typeof leaderRoles)[number];
export const chainTiers = ['self', 'lm', 'hod', 'bu', 'bg', 'group', 'final'] as const;
export type ChainTier = (typeof chainTiers)[number];
export type ChainStep = { tier: ChainTier; band: string | null; state: 'set' | 'kept' | 'moved' | 'none' | 'hidden'; why: string };
export type ChainAxis = { axis: 'performance' | 'potential'; steps: ChainStep[]; final: string | null; full: boolean; hasResult: boolean };
/** app.onehr_leader_result's shape (0665): the database has already cut the chain at the leader's step. */
export type LeaderChain = { role: LeaderRole; midYear: boolean; frozen: boolean; axes: ChainAxis[]; talent: string | null };
/** BG CEOs and group chiefs decided the result, so they read it at once. */
export const seesAtOnce = (role: LeaderRole) => role === 'bg' || role === 'group';
export const ledTabs = ['direct', 'dept', 'bu', 'group', 'bg'] as const;
export type LedTab = (typeof ledTabs)[number];

const RANK: Record<'performance' | 'potential', string[]> = { performance: ['UA', 'BE', 'ME', 'AE', 'OU'], potential: ['Low', 'Mid', 'High'] };
/** Each visible step with the direction of its move and whether it is the viewer's own step. */
export function chainSteps(axis: ChainAxis, role: LeaderRole) {
  let before: string | null = null;
  return axis.steps.map((s) => {
    const dir = s.state === 'moved' && before && s.band ? (RANK[axis.axis].indexOf(s.band) > RANK[axis.axis].indexOf(before) ? 'up' : 'down') : null;
    before = s.band ?? before;
    return { ...s, dir: dir as 'up' | 'down' | null, you: s.tier === role };
  });
}

export type LedSummary = { performance: string | null; potential: string | null; talent: string | null; full: boolean; moves: number; you: ('performance' | 'potential')[]; none: boolean };
/** One list row: what this leader may read of the person's results now (the source's summary). */
export function ledSummary(chain: LeaderChain | null): LedSummary {
  const have = (chain?.axes ?? []).filter((a) => a.hasResult);
  const out: LedSummary = { performance: null, potential: null, talent: null, full: false, moves: 0, you: [], none: have.length === 0 };
  if (!chain || out.none) return out;
  let fullAll = true;
  for (const a of have) {
    const visible = a.steps.filter((s) => s.state !== 'hidden');
    if (a.full) out[a.axis] = a.final;
    else { fullAll = false; out[a.axis] = [...visible].reverse().find((s) => s.band)?.band ?? null; }
    out.moves += visible.filter((s) => s.state === 'moved').length;
    if (visible.some((s) => s.tier === chain.role && s.state === 'moved')) out.you.push(a.axis);
  }
  out.full = fullAll;
  out.talent = chain.talent;
  return out;
}

export type LedRelease = { key: 'releasedToThem' | 'withLeadersSince' | 'notReleasedYet' | 'withYouSince' | 'notReleasedToThem' | 'noResult' | 'withHod' | 'inCalibration'; at: string | null; tone: 'ok' | 'you' | 'none' };
/** Where the release stands for one led person, from the viewer's side. */
export function ledRelease(role: LeaderRole, summary: LedSummary, midYear: boolean, leadersAt: string | null, releasedAt: string | null): LedRelease {
  if (releasedAt) return { key: 'releasedToThem', at: releasedAt, tone: 'ok' };
  if (seesAtOnce(role)) return leadersAt ? { key: 'withLeadersSince', at: leadersAt, tone: 'you' } : { key: 'notReleasedYet', at: null, tone: 'none' };
  if (summary.full && leadersAt) return { key: 'withYouSince', at: leadersAt, tone: 'you' };
  if (summary.full) return { key: 'notReleasedToThem', at: null, tone: 'you' };
  if (summary.none) return { key: 'noResult', at: null, tone: 'none' };
  return { key: midYear ? 'withHod' : 'inCalibration', at: null, tone: 'none' };
}
