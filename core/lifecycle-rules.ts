/**
 * Lifecycle rules (ADR-0095) — PURE functions: which steps apply, which are locked, when a case is
 * complete, and the approval chain. No database, no session: everything here is decided from the values
 * passed in, so the same answer is available to the service, the screens and the tests.
 */
import type { CaseKind, StepRule } from './lifecycle-defaults';

export type StepDef = { key: string; phase: number; label: string; ownerTeam: string; hrms: boolean; rule: StepRule; sort: number };
export type CaseFacts = {
  kind: CaseKind;
  status: 'in_progress' | 'completed' | 'cancelled';
  laptopRequired: boolean;
  carparkRequired: boolean;
  outcome: 'pending' | 'accepted' | 'rejected';
};
export type StepRecord = { key: string; done: boolean };

/**
 * 'applicable' — can be worked; 'na' — does not apply to this case (shown as N/A, cannot be ticked);
 * 'pending_outcome' — an offboarding processing step before the outcome is recorded (locked, not N/A).
 */
export type StepApplicability = 'applicable' | 'na' | 'pending_outcome';

export function stepApplicability(def: Pick<StepDef, 'rule'>, c: CaseFacts): StepApplicability {
  switch (def.rule) {
    case 'carpark':
      return c.carparkRequired ? 'applicable' : 'na';
    case 'laptop':
      return c.laptopRequired ? 'applicable' : 'na';
    case 'outcome_rejected':
      // Retention steps: workable while the outcome is undecided or retained; not applicable once accepted.
      return c.outcome === 'accepted' ? 'na' : 'applicable';
    case 'outcome_accepted':
      if (c.outcome === 'accepted') return 'applicable';
      return c.outcome === 'rejected' ? 'na' : 'pending_outcome';
    default:
      return 'applicable';
  }
}

export type StepView = StepDef & {
  applicability: StepApplicability;
  done: boolean;
  /** Why this step cannot be ticked right now; null when it can. */
  blocked: null | 'cancelled' | 'not_applicable' | 'outcome_pending' | 'phase_locked' | 'already_done';
};

/** Phase lock: a step in phase p needs every APPLICABLE step of phase p-1 done (onboarding only). */
export function phaseUnlocked(phase: number, steps: Pick<StepView, 'phase' | 'applicability' | 'done'>[]): boolean {
  if (phase <= 0) return true;
  return steps.filter((x) => x.phase === phase - 1 && x.applicability === 'applicable').every((x) => x.done);
}

export function buildStepViews(defs: StepDef[], records: StepRecord[], c: CaseFacts): StepView[] {
  const done = new Map(records.map((r) => [r.key, r.done]));
  const ordered = [...defs].sort((a, b) => a.phase - b.phase || a.sort - b.sort || a.key.localeCompare(b.key));
  const base = ordered.map((d) => ({
    ...d,
    applicability: stepApplicability(d, c),
    done: done.get(d.key) === true,
    blocked: null as StepView['blocked'],
  }));
  for (const st of base) {
    if (c.status === 'cancelled') st.blocked = 'cancelled';
    else if (st.applicability === 'na') st.blocked = 'not_applicable';
    else if (st.applicability === 'pending_outcome') st.blocked = 'outcome_pending';
    else if (st.done) st.blocked = 'already_done';
    else if (c.kind === 'onboarding' && !phaseUnlocked(st.phase, base)) st.blocked = 'phase_locked';
  }
  return base;
}

/**
 * A case is complete when every APPLICABLE step is done. An offboarding case with the outcome still
 * pending is never complete: its processing phase has not been decided yet.
 */
export function isCaseComplete(steps: Pick<StepView, 'applicability' | 'done'>[], c: Pick<CaseFacts, 'kind' | 'outcome'>): boolean {
  if (c.kind === 'offboarding' && c.outcome === 'pending') return false;
  const applicable = steps.filter((x) => x.applicability === 'applicable');
  return applicable.length > 0 && applicable.every((x) => x.done);
}

export function progressOf(steps: Pick<StepView, 'applicability' | 'done'>[]): { done: number; total: number; percent: number } {
  const applicable = steps.filter((x) => x.applicability === 'applicable');
  const done = applicable.filter((x) => x.done).length;
  const total = applicable.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

// ── approval chain (IT requisitions and asset requests) ───────────────────────────────────────────────
export type ApprovalState = {
  levels: number;
  l1Action: string | null;
  l2Action: string | null;
  l1By: string | null;
};
export type ApprovalStatus = 'pending' | 'pending_l2' | 'approved' | 'rejected';

/** Initial approval status: 0 levels means no approval is needed, so the record counts as approved. */
export const initialApprovalStatus = (levels: number): ApprovalStatus => (levels === 0 ? 'approved' : 'pending');

/**
 * The next approval status for a decision, or an error code. The chain cannot be skipped: a two-level
 * record needs L1 first and then L2, by a DIFFERENT person, and nobody decides their own request.
 */
export function nextApproval(
  s: ApprovalState & { status: ApprovalStatus },
  decision: 'approve' | 'reject',
  approverId: string,
  ownerId: string | null,
): { ok: true; level: 1 | 2; status: ApprovalStatus } | { ok: false; error: 'no_approval_needed' | 'already_decided' | 'self_approval' | 'same_approver' } {
  if (s.levels === 0) return { ok: false, error: 'no_approval_needed' };
  if (s.status === 'approved' || s.status === 'rejected') return { ok: false, error: 'already_decided' };
  if (ownerId && approverId === ownerId) return { ok: false, error: 'self_approval' };
  const level: 1 | 2 = s.status === 'pending_l2' ? 2 : 1;
  if (level === 2 && s.l1By && s.l1By === approverId) return { ok: false, error: 'same_approver' };
  if (decision === 'reject') return { ok: true, level, status: 'rejected' };
  if (level === 1 && s.levels === 2) return { ok: true, level, status: 'pending_l2' };
  return { ok: true, level, status: 'approved' };
}

// ── asset request fulfilment ──────────────────────────────────────────────────────────────────────────
/** Forward-only fulfilment path, and only after approval. */
export const FULFILMENT_ORDER = ['approved', 'procured', 'tagged', 'assigned', 'completed'] as const;
export function canAdvanceRequest(current: string, next: string): boolean {
  const i = FULFILMENT_ORDER.indexOf(current as (typeof FULFILMENT_ORDER)[number]);
  const j = FULFILMENT_ORDER.indexOf(next as (typeof FULFILMENT_ORDER)[number]);
  return i >= 0 && j === i + 1;
}

// ── dates ─────────────────────────────────────────────────────────────────────────────────────────────
/** Whole days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/** Mask an identity number to its last 4 characters, for exports. */
export function maskId(v: string | null | undefined): string {
  const x = String(v ?? '').trim();
  if (!x) return '';
  return x.length <= 4 ? '****' : `${'*'.repeat(x.length - 4)}${x.slice(-4)}`;
}
