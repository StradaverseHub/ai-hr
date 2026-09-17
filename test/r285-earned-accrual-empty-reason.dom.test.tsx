/**
 * feedback cf9dcb98 (r285) — THE EMPTY EARNED-ACCRUAL PREVIEW, RENDERED.
 *
 * ⚠️ WHY THIS FILE RENDERS RATHER THAN GREPS, and it is the same argument r281's archived-filter test
 * made. Every reason string the engine can now return is reached only AFTER a client button press and a
 * server-action round trip: the card is server-rendered with `rows === null`, so the branch that draws
 * these sentences is never in the SSR output and never in the HTML a curl sees. tsc, `next build` and a
 * source scan are all satisfied by a key that does not exist in any catalogue — next-intl paints
 * `MISSING_MESSAGE` at runtime, in the browser, on the one screen state nobody looks at twice.
 *
 * So the whole reason set is driven through the real component, against the SHIPPING catalogues, in all
 * six locales. §F is the one that would have caught a half-translated round; §A is the production case.
 *
 * NOTHING ABOUT THE ENGINE IS ASSERTED HERE — which reason is correct for which data is
 * test/r285-earned-accrual-empty-reason.test.ts's job, against a real database. This file pins only that
 * each reason the engine can hand over arrives on screen as a sentence that NAMES ITS SUBJECT, and that
 * the card adds no reasoning of its own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { EarnedAccrualCard } from '../components/earned-accrual-card';
import type { ArchivedLeaveTypeHint, EarnedAccrualEmptyReason, EarnedAccrualGroup } from '../core/leave';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Both action modules are server modules; in jsdom they would drag the database in. The COMMIT is stubbed
// to a no-op (nothing here runs an accrual); the PREVIEW returns whatever the test under way set up.
vi.mock('@/app/admin/actions', () => ({ runEarnedAccrualAction: async () => ({ granted: 0, forfeits: 0 }) }));
let preview: {
  rows: EarnedAccrualGroup[];
  asOf: string;
  emptyReason: EarnedAccrualEmptyReason | null;
  archivedHint: ArchivedLeaveTypeHint[];
  earnedToDateTotal: number;
};
vi.mock('@/app/admin/leave-config/earned-accrual/actions', () => ({
  previewEarnedAccrualWithReasonAction: async () => preview,
}));

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

const CARD_PROPS = {
  companies: [{ id: 'c1', name: 'Acme Sdn Bhd' }],
  grades: [{ id: 'g1', name: 'Executive' }],
  // r293 — the leave-type option gained `swept` (required) and the card gained `sweptLeaveTypeNames`.
  // `*Annual Leave` is the production row this file was written around: an ACTIVE `AL` not yet switched on
  // as Annual Leave (r299), so `swept: false` is its real value and the picker disables it. Nothing this
  // file asserts lives in the picker — every assertion below reads the preview's own paragraphs — so the
  // two props only keep it type-correct. test/r293-earned-accrual-picker.dom.test.tsx owns the picker.
  leaveTypes: [{ id: 'lt1', name: '*Annual Leave', swept: false }],
  sweptLeaveTypeNames: [] as string[],
  leaveYears: [{ year: 2026, status: 'draft' }],
  defaultYear: 2026,
};

const wrap = (locale: string, messages: Record<string, unknown>, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

/** The Preview button carries a TRANSLATED label, so it is found by the locale's own string. */
const previewLabel = (messages: typeof en) => messages.admin.leave.earnedPreviewButton;

/** Render, press Preview, and hand back the text of the reason paragraph the engine's answer produced. */
const previewText = async (answer: Partial<typeof preview>, locale = 'en', messages: typeof en = en) => {
  preview = {
    rows: [],
    asOf: '2026-09-15',
    emptyReason: null,
    archivedHint: [],
    earnedToDateTotal: 0,
    ...answer,
  };
  wrap(locale, messages as never, <EarnedAccrualCard {...CARD_PROPS} />);
  await userEvent.click(screen.getByRole('button', { name: previewLabel(messages) }));
  return screen.getByTestId('earned-empty-reason').textContent ?? '';
};

const REASONS: { label: string; reason: EarnedAccrualEmptyReason; mustName: string[] }[] = [
  {
    label: 'type_not_swept',
    reason: {
      kind: 'type_not_swept',
      leaveTypeNames: ['*Annual Leave'],
      sweptLeaveTypeNames: ['Annual Leave', 'Hospitalization Leave', 'Medical Leave'],
    },
    mustName: ['*Annual Leave', 'Hospitalization Leave'],
  },
  {
    label: 'type_not_swept with nothing covered active',
    reason: { kind: 'type_not_swept', leaveTypeNames: ['*Annual Leave'], sweptLeaveTypeNames: [] },
    mustName: ['*Annual Leave'],
  },
  {
    label: 'type_archived',
    reason: { kind: 'type_archived', leaveTypeNames: ['Annual Leave'] },
    mustName: ['Annual Leave'],
  },
  {
    label: 'table_not_yet_in_force',
    reason: {
      kind: 'table_not_yet_in_force',
      leaveTypeName: 'Annual Leave',
      validFrom: '2026-09-14',
      asOf: '2025-12-31',
    },
    mustName: ['Annual Leave', '2026-09-14', '2025-12-31'],
  },
  {
    label: 'no_entitlement_table',
    reason: { kind: 'no_entitlement_table', leaveTypeNames: ['Annual Leave'], asOf: '2026-09-15' },
    mustName: ['Annual Leave', '2026-09-15'],
  },
  {
    label: 'type_not_earned',
    reason: { kind: 'type_not_earned', leaveTypeNames: ['Medical Leave'] },
    mustName: ['Medical Leave'],
  },
  {
    label: 'no_employment_in_scope',
    reason: { kind: 'no_employment_in_scope', asOf: '2026-09-15', scopeNames: ['Director'] },
    mustName: ['Director', '2026-09-15'],
  },
  {
    label: 'no_employment_in_scope, unscoped',
    reason: { kind: 'no_employment_in_scope', asOf: '2026-09-15', scopeNames: [] },
    mustName: ['2026-09-15'],
  },
  {
    label: 'no_eligibility_match',
    reason: { kind: 'no_eligibility_match', leaveTypeNames: ['Annual Leave'] },
    mustName: ['Annual Leave'],
  },
  {
    label: 'country_pack_inactive',
    reason: { kind: 'country_pack_inactive', countries: ['ZZ'] },
    mustName: ['ZZ'],
  },
  {
    label: 'balance_frozen',
    reason: { kind: 'balance_frozen', leaveTypeNames: ['Annual Leave'] },
    mustName: ['Annual Leave'],
  },
];

describe('§A every reason NAMES its subject, and none of them paints MISSING_MESSAGE', () => {
  for (const { label, reason, mustName } of REASONS) {
    it(`${label} — names ${mustName.join(', ')}`, async () => {
      const text = await previewText({ emptyReason: reason });
      // The defect this whole item exists to end: a sentence that is true and says nothing.
      expect(text).not.toBe(en.admin.leave.earnedPreviewEmpty);
      expect(text).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
      for (const name of mustName) expect(text).toContain(name);
    });
  }
});

describe('§A2 the production sentence, pinned whole', () => {
  it('reads as the answer to the question that cost a day', async () => {
    // ⚠️ THE REASON OBJECT BELOW IS THE PRODUCTION SHAPE. r285 pinned the engine's answer for an active `AL`
    // "*Annual Leave" beside an archived `ANNUAL`. r299 (3de1453a) — UPDATED, NOT DELETED: the engine now
    // covers Annual Leave only, so on that account, before the reporter switches "*Annual Leave" on, the
    // Annual Leave list is EMPTY and the sentence names the switch. Pinning the WHOLE sentence rather than a
    // substring is still the point: only a full-string assertion notices when a reason becomes a riddle.
    const text = await previewText({
      emptyReason: {
        kind: 'type_not_swept',
        leaveTypeNames: ['*Annual Leave'],
        sweptLeaveTypeNames: [],
      },
      archivedHint: [{ id: 'eb16fd15', code: 'ANNUAL', name: 'Annual Leave' }],
    });
    expect(text).toBe(
      'Not Annual Leave: *Annual Leave. Earned Accrual applies only to Annual Leave, and no active leave type ' +
        'is marked as your Annual Leave — switch on “This is our Annual Leave” on it under Leave config → ' +
        'Entitlements → Leave types.',
    );
    expect(screen.getByTestId('earned-archived-hint').textContent).toBe(
      'Also worth knowing: the leave type Annual Leave is archived. Archived types are hidden from every ' +
        'picker on this screen and are never accrued — unarchive under Leave Config → Leave Types.',
    );
  });
});

describe('§A3 r299 — once Annual Leave is switched on, a non-Annual pick names it in brackets', () => {
  it('reads as the reporter’s rule, with the tenant’s Annual Leave name', async () => {
    const text = await previewText({
      emptyReason: { kind: 'type_not_swept', leaveTypeNames: ['Medical Leave'], sweptLeaveTypeNames: ['*Annual Leave'] },
    });
    expect(text).toBe(
      'Not Annual Leave: Medical Leave. Earned Accrual applies only to Annual Leave (*Annual Leave); other ' +
        'leave types are entitlement-based, so this run had nothing to examine.',
    );
  });
});

describe('§B the fallback is kept for the one case the engine cannot name', () => {
  it('a null reason still renders the original sentence rather than an empty box', async () => {
    const text = await previewText({ emptyReason: null });
    expect(text).toBe(en.admin.leave.earnedPreviewEmpty);
  });
});

describe('§C the archived twin rides ALONGSIDE the reason, never instead of it', () => {
  it('draws both sentences — the production account is both things at once', async () => {
    await previewText({
      emptyReason: {
        kind: 'type_not_swept',
        leaveTypeNames: ['*Annual Leave'],
        sweptLeaveTypeNames: ['Annual Leave'],
      },
      archivedHint: [{ id: 'a1', code: 'ANNUAL', name: 'Annual Leave' }],
    });
    expect(screen.getByTestId('earned-empty-reason').textContent).toContain('*Annual Leave');
    const hint = screen.getByTestId('earned-archived-hint').textContent ?? '';
    expect(hint).toContain('Annual Leave');
    expect(hint).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('is absent when there is no archived type to name', async () => {
    await previewText({ emptyReason: { kind: 'type_not_earned', leaveTypeNames: ['Medical Leave'] } });
    expect(screen.queryByTestId('earned-archived-hint')).toBeNull();
  });
});

describe('§D reason (c) — a table of zeroes explains itself too', () => {
  const ROW: EarnedAccrualGroup = {
    companyId: 'c1',
    companyName: 'Acme Sdn Bhd',
    gradeId: 'g1',
    gradeName: 'Executive',
    leaveTypeId: 'lt1',
    leaveTypeCode: 'ANNUAL',
    leaveTypeName: 'Annual Leave',
    employeeCount: 3,
    accrualPeriod: 2026,
    method: 'earned_monthly',
    entitlementGenerated: 0,
  };

  it('already posted: says so, and names the days and the date', async () => {
    preview = {
      rows: [ROW],
      asOf: '2026-09-15',
      emptyReason: null,
      archivedHint: [],
      earnedToDateTotal: 27,
    };
    wrap('en', en as never, <EarnedAccrualCard {...CARD_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /Preview/i }));
    const note = screen.getByTestId('earned-nothing-outstanding').textContent ?? '';
    expect(note).toContain('27');
    expect(note).toContain('2026-09-15');
    expect(note).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('nothing earned yet: a DIFFERENT sentence, because it wants a different action', async () => {
    preview = { rows: [ROW], asOf: '2026-09-15', emptyReason: null, archivedHint: [], earnedToDateTotal: 0 };
    wrap('en', en as never, <EarnedAccrualCard {...CARD_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /Preview/i }));
    const note = screen.getByTestId('earned-nothing-outstanding').textContent ?? '';
    expect(note).not.toContain('27');
    expect(note).toContain('2026-09-15');
    expect(note).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
  });

  it('a preview with something to post draws no such note', async () => {
    preview = {
      rows: [{ ...ROW, entitlementGenerated: 9 }],
      asOf: '2026-09-15',
      emptyReason: null,
      archivedHint: [],
      earnedToDateTotal: 27,
    };
    wrap('en', en as never, <EarnedAccrualCard {...CARD_PROPS} />);
    await userEvent.click(screen.getByRole('button', { name: /Preview/i }));
    expect(screen.queryByTestId('earned-nothing-outstanding')).toBeNull();
  });
});

describe('§E cancelling clears the explanation with the preview', () => {
  it('a stale reason cannot outlive the result it explained', async () => {
    await previewText({ emptyReason: { kind: 'type_not_earned', leaveTypeNames: ['Medical Leave'] } });
    expect(screen.getByTestId('earned-empty-reason')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByTestId('earned-empty-reason')).toBeNull();
  });
});

describe('§F all six locales — a reason that paints MISSING_MESSAGE is not a reason', () => {
  for (const [locale, messages] of LOCALES) {
    it(`${locale} renders every variant with its subject named`, async () => {
      for (const { reason, mustName } of REASONS) {
        const text = await previewText({ emptyReason: reason }, locale, messages as never);
        const where = `${locale} / ${reason.kind}`;
        expect(text, where).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
        expect(text.length, where).toBeGreaterThan(10);
        // The NAMES are DATA, not translation — they must survive into every language unchanged.
        for (const name of mustName) expect(text, where).toContain(name);
        // Unmount between variants: dom-setup only cleans between TESTS, and a second card in the same
        // document turns every getByTestId into "found multiple elements" for unrelated reasons.
        cleanup();
      }
    });
  }
});
