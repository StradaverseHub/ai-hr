/**
 * r301 (board 83511d3b) · CANCEL APPROVED LEAVE — THE CARD AND THE PENDING CANCELLATION, RENDERED.
 *
 * Both are CLIENT state: the "How it is applied for" tab only renders after an administrator selects it, and the
 * Pending Cancellation progress only inside the record's slide-out panel. A server render and a curl of the page
 * see neither, so a MISSING_MESSAGE or FORMATTING_ERROR in them would pass tsc, the suite, `next build` and a
 * dev-server log. This file mounts the real components under the SHIPPING catalogues, in all six locales, with
 * next-intl's onError turned into a thrown failure — and clicks.
 *
 *   · the card, switched OFF: one checkbox and the "HR can still cancel" note; no notice / approval / notify;
 *   · ticking it reveals the three settings the mockup shows; switched ON it renders the stored values;
 *   · Emergency Leave has no card; Replacement Leave is never offered "Approved automatically";
 *   · a record with a cancellation waiting reads "Pending Cancellation" on its card, and its panel shows the
 *     levels — requested, level 1 approved, level 2 waiting, cancelled — without repeating the pill.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import { LeaveTypeTabs, type LeaveTypeTabsData } from '../app/admin/leave-config/types/leave-type-tabs';
import { LeaveHistoryCards, type LeaveHistoryEntry } from '../components/leave/leave-history-cards';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];
const adminLeave = (loc: Locale) =>
  (CATALOGUES[loc] as unknown as { admin: { leave: Record<string, string> } }).admin.leave;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const noop = () => {};

function typeData(over: Partial<LeaveTypeTabsData> = {}): LeaveTypeTabsData {
  return {
    id: 'lt-annual',
    name: 'Annual Leave',
    code: 'ANNUAL',
    description: null,
    paid: true,
    archived: false,
    inUse: false,
    cascadeApprovalRules: [],
    cascadeBalanceSourceOf: [],
    eligibility: null,
    durations: null,
    requiresDocument: false,
    mandatoryAfterDays: null,
    allowedMimeTypes: null,
    maxDocBytes: 10 * 1024 * 1024,
    employeeRemarkRequired: false,
    hrRemarkRequired: false,
    backdatingLimitDays: null,
    maxDaysPerLeaveYear: null,
    maxDaysPeriod: null,
    maxConsecutiveDays: null,
    maxConsecutiveUnit: null,
    minAdvanceDays: null,
    minAdvanceDayType: null,
    customMessages: null,
    essViewConfig: null,
    formulaExplanations: null,
    dayTypeInclusion: null,
    color: null,
    icon: null,
    leaveUnit: 'day',
    yearCycleOverride: null,
    probationEligibility: null,
    visibleToEmployee: null,
    employeeCanApply: null,
    essPlacement: null,
    role: 'annual',
    counting: 'working_days',
    perDateApproval: false,
    duplicateApplicationPolicy: 'allow',
    overrideRules: null,
    allowNegativeBalance: false,
    maxNegativeBalance: null,
    balanceSourceTypeId: null,
    allowUnpaidLeave: false,
    employeeCancelApproved: false,
    cancelNoticeDays: 0,
    cancelAutoApprove: false,
    cancelNotify: false,
    sendToPayroll: false,
    rules: {},
    ...over,
  };
}

function mountTabs(loc: Locale, data: LeaveTypeTabsData) {
  const errors: string[] = [];
  const view = render(
    <NextIntlClientProvider
      locale={loc}
      messages={CATALOGUES[loc]}
      onError={(e) => {
        errors.push(String((e as Error).message ?? e));
      }}
    >
      <LeaveTypeTabs
        type={data}
        sweep={{ leaveTypeName: data.name, annualSwitch: 'on', otherAnnualLeaveTypeNames: [], earnedMethods: [] }}
        orgAssignmentOptions={{}}
        balanceSourceOptions={[]}
        formulaTemplate={null}
        openTab="application"
        updateTypeAction={noop}
        archiveTypeAction={noop}
        deleteTypeAction={noop}
        setTypeRulesAction={noop}
      />
    </NextIntlClientProvider>,
  );
  return { view, errors };
}

/** The Cancel Approved Leave card: the rounded box whose heading is the card title. */
const cardFor = (loc: Locale) => {
  const title = screen.getByText(adminLeave(loc).cancelApprovedSectionTitle);
  return title.closest('div.break-inside-avoid') as HTMLElement;
};

describe('THE CARD on "How it is applied for", in every locale', () => {
  it.each(LOCALES)('%s — off, then ticked: the three settings appear; no message is missing', async (loc) => {
    const { errors, view } = mountTabs(loc, typeData());
    const card = cardFor(loc);
    const L = adminLeave(loc);
    const allow = within(card).getByRole('checkbox', { name: L.cancelApprovedAllowLabel });
    expect((allow as HTMLInputElement).checked).toBe(false);
    expect(within(card).getByText(L.cancelApprovedOffNote)).toBeTruthy();
    expect(card.querySelector('input[name="cancelNoticeDays"]')).toBeNull();
    expect(card.querySelector('select[name="cancelApproval"]')).toBeNull();
    expect(card.querySelector('input[name="cancelNotify"]')).toBeNull();
    // Its own form, with the marker, the id and the name it must never lose.
    const form = card.querySelector('form')!;
    expect(form.querySelector('input[name="cancelApproved"][value="1"]')).not.toBeNull();
    expect((form.querySelector('input[name="id"]') as HTMLInputElement).value).toBe('lt-annual');
    expect((form.querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Annual Leave');

    await userEvent.click(allow);
    expect(card.querySelector('input[name="cancelNoticeDays"]')).not.toBeNull();
    const select = card.querySelector('select[name="cancelApproval"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([L.cancelApprovedApprovalReapprove, L.cancelApprovedApprovalAuto]);
    expect(within(card).getByRole('checkbox', { name: L.cancelApprovedNotifyLabel })).toBeTruthy();
    // "Allow cancellation up to [ ] day(s) before each leave day" — one label around the number box.
    const noticeLabel = card.querySelector('input[name="cancelNoticeDays"]')!.closest('label')!;
    expect(noticeLabel.textContent).toContain(L.cancelApprovedNoticeBefore);
    expect(noticeLabel.textContent).toContain(L.cancelApprovedNoticeAfter);
    expect(within(card).queryByText(L.cancelApprovedOffNote)).toBeNull();
    // No MISSING_MESSAGE / FORMATTING_ERROR anywhere on the tab.
    expect(errors, errors.join('\n')).toEqual([]);
    view.unmount();
  });

  it('switched on, it renders what is stored', () => {
    mountTabs('en', typeData({ employeeCancelApproved: true, cancelNoticeDays: 3, cancelAutoApprove: true, cancelNotify: true }));
    const card = cardFor('en');
    expect((card.querySelector('input[name="employeeCancelApproved"]') as HTMLInputElement).checked).toBe(true);
    expect((card.querySelector('input[name="cancelNoticeDays"]') as HTMLInputElement).value).toBe('3');
    expect((card.querySelector('select[name="cancelApproval"]') as HTMLSelectElement).value).toBe('auto');
    expect((card.querySelector('input[name="cancelNotify"]') as HTMLInputElement).checked).toBe(true);
  });

  it('Emergency Leave has no card; Replacement Leave is never offered automatic approval', () => {
    const { view } = mountTabs('en', typeData({ id: 'lt-el', name: 'Emergency Leave', code: 'EL', role: 'emergency' }));
    expect(screen.queryByText(en.admin.leave.cancelApprovedSectionTitle)).toBeNull();
    // …while the rest of the tab is still there.
    expect(screen.getByText(en.admin.leave.applyNoticeSectionTitle)).toBeTruthy();
    view.unmount();

    mountTabs('en', typeData({ id: 'lt-rl', name: 'Replacement Leave', code: 'RL', role: 'replacement', employeeCancelApproved: true, cancelAutoApprove: true }));
    const card = cardFor('en');
    const select = card.querySelector('select[name="cancelApproval"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['reapproval']);
    expect(select.value).toBe('reapproval');
    expect(within(card).getByText(en.admin.leave.cancelApprovedReplacementNote)).toBeTruthy();
  });
});

describe('PENDING CANCELLATION on the employee’s own record, in every locale', () => {
  it.each(LOCALES)('%s — the card says Pending Cancellation; the panel shows the levels, not the pill', async (loc) => {
    const leave = (CATALOGUES[loc] as unknown as { leave: Record<string, unknown> }).leave as {
      pendingCancellationStatus: string;
      cancelPendingBadge: string;
      viewDetails: string;
    };
    const entry: LeaveHistoryEntry = {
      id: 'lr-1',
      leaveType: 'Annual Leave',
      groupLabel: null,
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      days: 3,
      splitRows: null,
      sessionSuffix: null,
      sessionLabel: 'Full day',
      statusKey: 'pendingCancellation',
      statusLabel: leave.pendingCancellationStatus,
      stageLabel: null,
      approverName: null,
      approverPersonId: null,
      cancelPendingLabel: leave.cancelPendingBadge,
      cancelProgress: {
        steps: [
          { label: 'Cancellation requested · 2026-09-17', state: 'done' },
          { label: 'Level 1 · approved', state: 'done' },
          { label: 'Level 2 · waiting for approval', state: 'current' },
          { label: 'Cancelled · days returned to your balance', state: 'upcoming' },
        ],
        dates: 'Days to cancel: 2026-10-13',
        note: 'The same approval levels, in the same order, as the original leave request.',
      },
      documentHref: null,
      documentLabel: null,
      actions: null,
      dateOutcome: null,
    };
    const errors: string[] = [];
    render(
      <NextIntlClientProvider locale={loc} messages={CATALOGUES[loc]} onError={(e) => errors.push(String((e as Error).message ?? e))}>
        <LeaveHistoryCards entries={[entry]} locale={loc} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(leave.pendingCancellationStatus)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: leave.viewDetails }));
    const panel = screen.getByRole('dialog');
    for (const s of entry.cancelProgress!.steps) expect(within(panel).getByText(s.label)).toBeTruthy();
    expect(within(panel).getByText('Days to cancel: 2026-10-13')).toBeTruthy();
    // The status badge already says it; the old pill does not repeat it. (In ta, th and vi the two strings are
    // the same words, so this counts the text rather than looking for the pill's absence.)
    const pendingTexts = new Set([leave.pendingCancellationStatus, leave.cancelPendingBadge]);
    const shown = [...pendingTexts].flatMap((txt) => within(panel).queryAllByText(txt));
    expect(shown.length).toBe(1);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
