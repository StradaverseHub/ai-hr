/**
 * r301 (board 83511d3b) · CANCEL APPROVED LEAVE — the screens, the words, and the contract between the card and
 * the action.
 *
 *   · every refusal says exactly why: localizeLeaveError (shared by app/me/actions.ts and app/leave/actions.ts)
 *     maps each refusal to its OWN sentence, read through a real translator over the English catalogue — no
 *     refusal the service raises falls back to the old one-size "This leave date can't be cancelled.";
 *   · the card posts its marker and the fields the action reads, is hidden for Emergency Leave, and the action
 *     forwards the three settings ONLY while the switch is ticked (a setting the card did not render is never
 *     read as "off");
 *   · /leave and the Team Leave Tracker take the button from the ONE server predicate; /approvals shows the
 *     current level; the employee's record shows Pending Cancellation with its progress;
 *   · every new key ships in all six locales, with the placeholders its caller passes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import en from '../messages/en.json';

// app/me/actions.ts's framework edges, faked the way test/r299-leave-credit-cancel.test.ts fakes them, so each
// refusal is read as the SENTENCE the employee sees. MISSING_MESSAGE / FORMATTING_ERROR throw, as next-intl does.
vi.mock('../lib/session', () => ({ getSession: vi.fn(async () => null) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'ms',
  getTranslations: async (ns: string) => (key: string, vals?: Record<string, unknown>) => {
    const node = `${ns}.${key}`
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en);
    if (typeof node !== 'string') throw new Error(`MISSING_MESSAGE: ${ns}.${key}`);
    return node.replace(/\{(\w+)\}/g, (_, name) => {
      if (!vals || !(name in vals)) throw new Error(`FORMATTING_ERROR: ${ns}.${key} needs {${name}}`);
      return String(vals[name]);
    });
  },
}));

import { localizeLeaveError } from '../app/me/actions';
import {
  LeaveCancellationNotAllowedError,
  LeaveCancellationTooCloseError,
  type LeaveCancellationRefusal,
} from '../core/leave';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

const ALL_REFUSALS: LeaveCancellationRefusal[] = [
  'not_yours',
  'not_approved',
  'not_full_day',
  'grouped',
  'type_off',
  'unpaid_days',
  'already_pending',
  'no_longer_cancellable',
  'admin_only',
  'admin_own_leave',
  'already_final',
  'already_approved',
];

describe('EVERY REFUSAL SAYS EXACTLY WHY', () => {
  it('each refusal the service can raise maps to its own sentence, never the generic one', async () => {
    const generic = en.leave.errors.cancellationNotAllowed;
    const sentences = new Map<string, string>();
    for (const code of ALL_REFUSALS) {
      const msg = await localizeLeaveError(new LeaveCancellationNotAllowedError('x', code, 'Annual Leave', null));
      expect(msg, code).not.toBe(generic);
      sentences.set(code, msg);
    }
    expect(new Set(sentences.values()).size, 'two refusals share one sentence').toBe(ALL_REFUSALS.length);
    expect(sentences.get('type_off')).toBe(
      "Annual Leave can't be cancelled by employees once it has been approved. Ask HR if it needs to be cancelled.",
    );
    expect(sentences.get('unpaid_days')).toContain('unpaid days');
    // A refusal nobody has named yet still reads as the generic sentence, as every refusal did before.
    expect(await localizeLeaveError(new LeaveCancellationNotAllowedError('x'))).toBe(generic);
  });

  it('too close names the date, the type (in the reader’s language when HR gave one) and the notice period', async () => {
    const msg = await localizeLeaveError(
      new LeaveCancellationTooCloseError('2026-10-08', 3, 'Annual Leave', { ms: { name: 'Cuti Tahunan' } }),
    );
    expect(msg).toBe('2026-10-08 is too close to cancel. Cuti Tahunan can be cancelled up to 3 day(s) before each leave day.');
  });

  it('every refusal the service raises carries a code — no refusal is left generic in core/leave.ts', () => {
    const src = read('core/leave.ts');
    const raised = [...src.matchAll(/new LeaveCancellationNotAllowedError\(([\s\S]*?)\)\s*;/g)].map((m) => m[1]);
    expect(raised.length, 'refusal sites found').toBeGreaterThanOrEqual(15);
    for (const args of raised) {
      expect(new RegExp(`'(${ALL_REFUSALS.join('|')})'`).test(args), args).toBe(true);
    }
  });
});

describe('THE CARD AND ITS ACTION', () => {
  const tabs = read('app/admin/leave-config/types/leave-type-tabs.tsx');
  const actions = read('app/admin/actions.ts');

  it('is hidden for Emergency Leave (role first, code fallback) and sits on the "How it is applied for" tab', () => {
    const markerAt = tabs.indexOf('<input type="hidden" name="cancelApproved" value="1" />');
    const applicationTab = tabs.indexOf("{activeTab === 'application' && (");
    const approversTab = tabs.indexOf("{activeTab === 'approvers' && (");
    expect(markerAt).toBeGreaterThan(applicationTab);
    expect(markerAt).toBeLessThan(approversTab);
    const guardAt = tabs.lastIndexOf('{!isEmergencyType && (', markerAt);
    expect(guardAt).toBeGreaterThan(applicationTab);
    expect(tabs).toContain("const isEmergencyType = role ? role === 'emergency' : code === 'EMERGENCY';");
    // The three settings render only while the switch is ticked; off shows the note the mockup shows.
    const card = tabs.slice(markerAt, tabs.indexOf('</form>', markerAt));
    expect(card).toContain('{cancelApprovedOn ? (');
    expect(card.indexOf('name="cancelNoticeDays"')).toBeGreaterThan(card.indexOf('{cancelApprovedOn ? ('));
    expect(card).toContain("t('cancelApprovedOffNote')");
    // Replacement Leave is never offered automatic approval (the service refuses it).
    expect(card).toContain('{!isReplacementType && <option value="auto">');
  });

  it('the action forwards the three settings ONLY while the switch is ticked', () => {
    const block = actions.slice(actions.indexOf("const touchCancelApproved = fd.get('cancelApproved') === '1';"));
    const expr = block.slice(0, block.indexOf('const leaveTypeId'));
    expect(expr).toContain(": { employeeCancelApproved: false };");
    // The sub-fields are read inside the switch-on branch, never on the off branch.
    const onBranch = expr.slice(expr.indexOf('? {'), expr.indexOf(': { employeeCancelApproved: false }'));
    for (const f of ["fd.get('cancelApproval')", "fd.get('cancelNotify')", 'cancelNoticeRaw']) {
      expect(onBranch, f).toContain(f);
    }
    expect(actions).toContain('...cancelApprovedFields,');
  });
});

describe('THE BUTTON, THE STATUS AND THE LEVEL — on the server, through one predicate', () => {
  it('/leave renders the Cancel dates button only for a non-null server offer', () => {
    const page = read('app/leave/page.tsx');
    expect(page).toContain('const cancelOffers = await employeeCancelOffers(session, selfHistory, today);');
    expect(page).toContain(') : (cancelOffers.get(r.id) ?? null) !== null ? (');
    expect(page).toContain('candidateDates={cancelOffers.get(r.id) ?? []}');
    // The old local "strictly after today" filter is gone — the notice period lives in the shared predicate.
    expect(page).not.toContain('(workingDates ?? []).filter((d) => d > today)');
    // Pending Cancellation as the record's status, with its progress (levels only).
    expect(page).toContain("t('pendingCancellationStatus')");
    expect(page).toContain("t('cancelProgress.levelWaiting', { level: i + 1 })");
  });

  it('the Team Leave Tracker’s candidate dates come from the same predicate', () => {
    const readSrc = read('core/read.ts');
    const planned = readSrc.slice(readSrc.indexOf('export function plannedAbsences('), readSrc.indexOf('export function awayTodayCount('));
    expect(planned.match(/employeeCancellableDates\(/g)?.length).toBe(2);
    expect(planned).not.toContain('working.filter((d) => d > today)');
    const offers = readSrc.slice(readSrc.indexOf('export function employeeCancelOffers('));
    expect(offers).toContain('employeeCancellableDates(r, working, setting, today)');
  });

  it('/approvals shows the level a cancellation is waiting at, and Pending Cancellation', () => {
    const page = read('app/approvals/page.tsx');
    const section = page.slice(page.indexOf('APPROVAL_SECTION_ID.leaveCancellation'));
    expect(section).toContain("{tLeave('pendingCancellationStatus')}");
    expect(section).toContain("t('stepOfN', { n: (c.currentStepIndex ?? 0) + 1, total: c.stepCount })");
  });
});

describe('SIX LOCALES', () => {
  const NEW_KEYS: { path: string; placeholders: string[] }[] = [
    ...[
      ['cancellationTooClose', ['date', 'typeName', 'days']],
      ['cancellationTypeOff', ['typeName']],
      ['cancellationNotYours', []],
      ['cancellationNotApproved', []],
      ['cancellationNotFullDay', []],
      ['cancellationGrouped', []],
      ['cancellationUnpaidDays', []],
      ['cancellationAlreadyPending', []],
      ['cancellationNoLongerCancellable', []],
      ['cancellationAdminOnly', []],
      ['cancellationAdminOwnLeave', []],
      ['cancellationAlreadyFinal', []],
      ['cancellationAlreadyApproved', []],
    ].map(([k, ph]) => ({ path: `leave.errors.${k}`, placeholders: ph as string[] })),
    { path: 'leave.pendingCancellationStatus', placeholders: [] },
    { path: 'leave.cancelAutoApprovedToast', placeholders: [] },
    { path: 'leave.cancelRequestedToast', placeholders: [] },
    { path: 'leave.cancelDatesHint', placeholders: [] },
    { path: 'leave.cancelProgress.requested', placeholders: ['date'] },
    { path: 'leave.cancelProgress.waiting', placeholders: [] },
    { path: 'leave.cancelProgress.levelApproved', placeholders: ['level'] },
    { path: 'leave.cancelProgress.levelWaiting', placeholders: ['level'] },
    { path: 'leave.cancelProgress.levelUpcoming', placeholders: ['level'] },
    { path: 'leave.cancelProgress.cancelled', placeholders: [] },
    { path: 'leave.cancelProgress.dates', placeholders: ['dates'] },
    { path: 'leave.cancelProgress.sameChainNote', placeholders: [] },
    ...[
      'cancelApprovedSectionTitle',
      'cancelApprovedSectionHelp',
      'cancelApprovedAllowLabel',
      'cancelApprovedOffNote',
      'cancelApprovedNoticeBefore',
      'cancelApprovedNoticeAfter',
      'cancelApprovedNoticeHelp',
      'cancelApprovedApprovalLabel',
      'cancelApprovedApprovalReapprove',
      'cancelApprovedApprovalAuto',
      'cancelApprovedApprovalHelp',
      'cancelApprovedReplacementNote',
      'cancelApprovedNotifyLabel',
      'cancelApprovedNotifyHelp',
    ].map((k) => ({ path: `admin.leave.${k}`, placeholders: [] })),
  ];

  it.each(LOCALES)('%s carries every new key with real text and exactly the placeholders its caller passes', (loc) => {
    const messages = JSON.parse(read(`messages/${loc}.json`)) as Record<string, unknown>;
    for (const { path, placeholders } of NEW_KEYS) {
      const value = path
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages);
      expect(typeof value, `${loc} · ${path}`).toBe('string');
      expect((value as string).trim().length, `${loc} · ${path} is blank`).toBeGreaterThan(0);
      const used = [...(value as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(used, `${loc} · ${path} placeholders`).toEqual([...placeholders].sort());
    }
  });

  it('the English card copy is the mockup’s', () => {
    expect(en.admin.leave.cancelApprovedSectionTitle).toBe('Cancel Approved Leave');
    expect(en.admin.leave.cancelApprovedAllowLabel).toBe('Allow employees to cancel this approved leave');
    expect(en.admin.leave.cancelApprovedApprovalReapprove).toBe("Requires the approver's re-approval");
    expect(en.admin.leave.cancelApprovedApprovalAuto).toBe('Approved automatically');
    expect(en.admin.leave.cancelApprovedNotifyLabel).toBe('Notify the approver and HR when a cancellation is requested');
    expect(en.leave.pendingCancellationStatus).toBe('Pending Cancellation');
  });
});
