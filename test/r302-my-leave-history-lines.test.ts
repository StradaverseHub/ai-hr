/**
 * r302 (board 6c9802c9) · MY LEAVE HISTORY — THE LINES THE SERVER ASSEMBLES, AGAINST THE SHIPPING CATALOGUES.
 *
 * "For a pending request the row says who it is waiting for and at which approval level." and "approval steps
 * other than the direct manager are labelled 'HR review' even when they are not" — the row's Approver cell and
 * the View panel's progress are built on the SERVER (app/leave/page.tsx → lib/my-leave-history.ts), so no DOM
 * test sees them and a FORMATTING_ERROR in one would pass tsc, the suite and `next build`. They are run here
 * through next-intl's own `createTranslator` in all six locales with onError collected, and their English
 * wording is pinned for the arms the plan names.
 */
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';
import { LEVEL_KINDS } from '../lib/leave-approval-kinds';
import {
  APPROVER_KIND_LABEL_KEY,
  approvalProgress,
  approverKindLabelKey,
  approverLine,
  cancellationLines,
  pendingApprovalLine,
  resolveHistoryTab,
  type ApprovalTrailFull,
  type HistoryLineDeps,
} from '../lib/my-leave-history';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

function deps(loc: Locale, errors: string[]): HistoryLineDeps {
  const onError = (e: unknown) => errors.push(`${loc}: ${String((e as Error).message ?? e)}`);
  const t = createTranslator({ locale: loc, messages: CATALOGUES[loc], namespace: 'leave', onError });
  const ta = createTranslator({ locale: loc, messages: CATALOGUES[loc], namespace: 'leaveApproval', onError });
  return {
    t: (key, values) => (t as unknown as (k: string, v?: Record<string, string | number>) => string)(key, values),
    kindLabel: (kind) => {
      const k = approverKindLabelKey(kind);
      return k ? (ta as unknown as (k: string) => string)(k) : null;
    },
    fmtInstant: (d) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : null),
    listNames: (names) => names.join(' / '),
  };
}

const at = (iso: string) => new Date(`${iso}:00Z`);
const step = (over: Partial<ApprovalTrailFull['steps'][number]>) => ({
  stepIndex: 0,
  kind: 'direct_manager',
  approverName: null,
  alternateNames: [],
  status: 'pending',
  decidedByName: null,
  decidedAt: null,
  ...over,
});
const trail = (over: Partial<ApprovalTrailFull>): ApprovalTrailFull => ({
  status: 'pending',
  decidedByName: null,
  decidedAt: null,
  singleLevelApproverName: null,
  steps: [],
  ...over,
});
const pendingRow = { status: 'pending', appliedOn: at('2026-09-01T09:00'), decidedAt: null };

describe('the stage label comes from the step KIND — never "HR review" for a step that is not HR', () => {
  it('every approver kind has a label, in every catalogue', () => {
    for (const kind of LEVEL_KINDS) {
      const key = APPROVER_KIND_LABEL_KEY[kind];
      for (const loc of LOCALES) {
        const v = (CATALOGUES[loc] as unknown as { leaveApproval: Record<string, unknown> }).leaveApproval[key];
        expect(typeof v === 'string' && v.length > 0, `${loc} leaveApproval.${key} for ${kind}`).toBe(true);
      }
    }
    expect(approverKindLabelKey('not_a_kind')).toBeNull();
  });

  it('en: a department head, a manager’s manager and payroll read as themselves', () => {
    const d = deps('en', []);
    expect(d.kindLabel('department_head')).toBe('Department Head');
    expect(d.kindLabel('manager_manager')).toBe("Manager's Manager");
    expect(d.kindLabel('payroll')).toBe('Payroll');
    for (const kind of LEVEL_KINDS.filter((k) => k !== 'hr_admin')) expect(d.kindLabel(kind)).not.toBe(en.me.stageHr);
  });
});

describe('the Approver cell: who it is waiting for, and at which level', () => {
  const d = () => deps('en', []);
  it('names the person a level is routed to', () => {
    const tr = trail({
      steps: [
        step({ stepIndex: 0, status: 'approved', decidedByName: 'Marcus Manager' }),
        step({ stepIndex: 1, kind: 'department_head', approverName: 'Dora Head' }),
      ],
    });
    expect(pendingApprovalLine(tr)).toEqual({ level: 2, of: 2, kind: 'department_head', names: ['Dora Head'] });
    expect(approverLine(pendingRow, tr, null, d())).toBe('Waiting for Dora Head · Level 2 of 2');
  });
  it('a role level is named by its label; alternates join the named person', () => {
    const role = trail({ steps: [step({ status: 'approved' }), step({ stepIndex: 1, kind: 'hr_admin' })] });
    expect(approverLine(pendingRow, role, null, d())).toBe('Waiting for HR · Level 2 of 2');
    const anyOne = trail({ steps: [step({ kind: 'specific_employee', approverName: 'Dora Head', alternateNames: ['Bella Boss'] })] });
    expect(approverLine(pendingRow, anyOne, null, d())).toBe('Waiting for Dora Head / Bella Boss · Level 1 of 1');
  });
  it('a single-level request (no step rows) waits for the direct manager — or for approval when there is none', () => {
    expect(approverLine(pendingRow, trail({ singleLevelApproverName: 'Marcus Manager' }), null, d())).toBe('Waiting for Marcus Manager · Level 1 of 1');
    expect(approverLine(pendingRow, trail({}), null, d())).toBe('Waiting for approval · Level 1 of 1');
  });
  it('decided and cancelled rows say who', () => {
    const decided = trail({ status: 'approved', decidedByName: 'Hana HR' });
    expect(approverLine({ ...pendingRow, status: 'approved' }, decided, null, d())).toBe('Approved by Hana HR');
    expect(approverLine({ ...pendingRow, status: 'rejected' }, { ...decided, status: 'rejected' }, null, d())).toBe('Rejected by Hana HR');
    const c = { cancelledAt: at('2026-09-03T11:00'), cancelledByName: 'Hana HR', automatic: false, requestedAt: null, reason: null };
    expect(approverLine({ ...pendingRow, status: 'cancelled' }, trail({ status: 'cancelled' }), c, d())).toBe('Cancelled by Hana HR');
    expect(approverLine({ ...pendingRow, status: 'cancelled' }, trail({ status: 'cancelled' }), { ...c, cancelledByName: null, automatic: true }, d())).toBe(
      'Cancellation approved automatically',
    );
    // Nothing known ⇒ nothing printed (the cell shows an em dash), never an invented name.
    expect(approverLine({ ...pendingRow, status: 'approved' }, trail({ status: 'approved' }), null, d())).toBeNull();
  });
});

describe('the View panel: approval progress step by step, the current level highlighted', () => {
  it('Submitted → decided level → current level → not reached → outcome', () => {
    const tr = trail({
      steps: [
        step({ stepIndex: 0, status: 'approved', decidedByName: 'Marcus Manager', decidedAt: at('2026-09-02T10:00') }),
        step({ stepIndex: 1, kind: 'department_head', approverName: 'Dora Head' }),
        step({ stepIndex: 2, kind: 'hr_admin' }),
      ],
    });
    const p = approvalProgress(pendingRow, tr, null, deps('en', []));
    expect(p.map((s) => s.state)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    expect(p.map((s) => s.label)).toEqual([
      'Submitted',
      'Level 1 · Direct manager · Marcus Manager',
      'Level 2 · Department Head · Dora Head',
      'Level 3 · HR',
      'Approved',
    ]);
    expect(p[1].detail).toBe('Approved 2026-09-02 10:00');
    expect(p[2].detail).toBe('Waiting for approval');
    expect(p[3].detail).toBe('Not reached yet');
  });

  it('a rejection ends at the rejecting level; a cancellation shows who and when', () => {
    const rejected = trail({
      status: 'rejected',
      steps: [step({ status: 'rejected', decidedByName: 'Marcus Manager', decidedAt: at('2026-09-02T10:00') }), step({ stepIndex: 1, kind: 'hr_admin' })],
    });
    const row = { status: 'rejected', appliedOn: at('2026-09-01T09:00'), decidedAt: at('2026-09-02T10:00') };
    expect(approvalProgress(row, rejected, null, deps('en', [])).map((s) => s.state)).toEqual(['done', 'rejected', 'upcoming', 'rejected']);

    const c = { cancelledAt: at('2026-09-03T11:00'), cancelledByName: 'Hana HR', automatic: false, requestedAt: at('2026-09-02T08:00'), reason: 'Trip moved' };
    const cancelled = { status: 'cancelled', appliedOn: at('2026-09-01T09:00'), decidedAt: at('2026-09-01T12:00') };
    expect(cancellationLines(cancelled, c, deps('en', []))).toEqual({
      lines: ['Cancelled by Hana HR · 2026-09-03 11:00', 'Cancellation requested 2026-09-02 08:00'],
      reason: 'Trip moved',
    });
    expect(cancellationLines({ status: 'approved' }, c, deps('en', []))).toBeNull();
    const single = approvalProgress(cancelled, trail({ status: 'cancelled', decidedByName: 'Marcus Manager', decidedAt: at('2026-09-01T12:00') }), c, deps('en', []));
    expect(single.map((s) => s.label)).toEqual(['Submitted', 'Level 1 · Marcus Manager', 'Cancelled']);
    expect(single[2].detail).toBe('2026-09-03 11:00');
  });
});

describe('every line formats in every locale (no MISSING_MESSAGE, no FORMATTING_ERROR)', () => {
  it.each(LOCALES)('%s', (loc) => {
    const errors: string[] = [];
    const d = deps(loc, errors);
    const c = { cancelledAt: at('2026-09-03T11:00'), cancelledByName: 'Hana HR', automatic: false, requestedAt: at('2026-09-02T08:00'), reason: 'r' };
    const trails: ApprovalTrailFull[] = [
      trail({ singleLevelApproverName: 'Marcus' }),
      trail({}),
      trail({ steps: [step({ status: 'approved', decidedByName: 'M', decidedAt: at('2026-09-02T10:00') }), step({ stepIndex: 1, kind: 'payroll' }), step({ stepIndex: 2, kind: 'weird_kind' })] }),
    ];
    const lines: (string | null)[] = [];
    for (const tr of trails) {
      lines.push(approverLine(pendingRow, tr, null, d));
      lines.push(...approvalProgress(pendingRow, tr, null, d).flatMap((s) => [s.label, s.detail]));
    }
    for (const status of ['approved', 'rejected', 'cancelled'] as const) {
      const row = { status, appliedOn: at('2026-09-01T09:00'), decidedAt: at('2026-09-02T10:00') };
      const tr = trail({ status, decidedByName: 'Hana', decidedAt: at('2026-09-02T10:00') });
      lines.push(approverLine(row, tr, c, d), approverLine(row, tr, { ...c, automatic: true }, d));
      lines.push(...approvalProgress(row, tr, c, d).flatMap((s) => [s.label, s.detail]));
      lines.push(...(cancellationLines(row, c, d)?.lines ?? []), ...(cancellationLines(row, { ...c, automatic: true }, d)?.lines ?? []));
      lines.push(...(cancellationLines(row, { ...c, cancelledByName: null }, d)?.lines ?? []));
    }
    expect(errors, errors.join('\n')).toEqual([]);
    for (const l of lines) if (l != null) expect(l, 'no raw key path printed').not.toMatch(/^leave\.|myLeave\./);
    expect(lines.filter((l) => l != null).length).toBeGreaterThan(20);
  });
});

describe('the tab a visit opens on', () => {
  it('an explicit valid tab wins; otherwise Pending when anything is pending, else the first with records', () => {
    const counts = { pending: 0, approved: 3, rejected: 1, cancelled: 0 };
    expect(resolveHistoryTab('rejected', counts)).toBe('rejected');
    expect(resolveHistoryTab(undefined, counts)).toBe('approved');
    expect(resolveHistoryTab('bogus', { ...counts, pending: 2 })).toBe('pending');
    expect(resolveHistoryTab(undefined, { pending: 0, approved: 0, rejected: 0, cancelled: 0 })).toBe('pending');
  });
});
