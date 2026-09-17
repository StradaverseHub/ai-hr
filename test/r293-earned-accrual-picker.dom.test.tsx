/**
 * r293 — RUN EARNED ACCRUAL MARKS THE LEAVE TYPES IT CAN NEVER ACCRUE, RENDERED.
 * r299 (3de1453a) — UPDATED, NOT DELETED. r293 pinned "MARK, DO NOT REMOVE AND DO NOT DISABLE". The
 * reporter's explicit rule — "Only Annual Leave (*Annual Leave) is subject to the Earned Accrual concept. All
 * other leave types are managed based on entitlement and should not be included in the Earned Accrual
 * process." — REVERSES the "do not disable" half. This file now pins the new decision:
 *
 *   §A  every non-Annual type is LISTED, DISABLED (cannot be ticked) and tagged Entitlement-based;
 *   §B  THE SECOND ARM — Annual Leave is enabled and tagged Earned accrual; the other pickers carry nothing;
 *   §C  Select all never ticks a disabled row; the scope the card posts can hold only Annual Leave ids;
 *   §D  the reporter's sentence with THE TENANT'S OWN Annual Leave name(s) — never an English default;
 *   §E  the none-active sentence, naming the switch;
 *   §F  all six locales.
 *
 * ⚠️ WHY THIS FILE RENDERS RATHER THAN GREPS (r293's reason, still true). The option rows exist only while
 * the popover is OPEN, inside a client island — never in SSR output — so a curl proves nothing and a
 * missing key paints MISSING_MESSAGE only in the browser. The real component, the SHIPPING catalogues.
 *
 * NOTHING ABOUT THE ENGINE IS ASSERTED HERE. test/r299-earned-accrual-annual-only.test.ts and
 * test/r293-earned-accrual-picker.test.ts §4 own that, against a real database; this file pins only what the
 * picker does with the booleans the server hands it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// The SHIPPING catalogues, not fixtures: a half-translated round is the failure §F exists to catch.
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import { EarnedAccrualCard, type EarnedLeaveTypeOption } from '../components/earned-accrual-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Both action modules are server modules; in jsdom they would drag the database in. The PREVIEW records the
// scope it is handed, so §C can prove what the card would post.
const previewScopes: { leaveTypeIds: string[] }[] = [];
vi.mock('@/app/admin/actions', () => ({ runEarnedAccrualAction: async () => ({ granted: 0, forfeits: 0 }) }));
vi.mock('@/app/admin/leave-config/earned-accrual/actions', () => ({
  previewEarnedAccrualWithReasonAction: async (scope: { leaveTypeIds: string[] }) => {
    previewScopes.push(scope);
    return { rows: [], asOf: '2026-09-15', emptyReason: null, archivedHint: [], earnedToDateTotal: 0 };
  },
}));

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/**
 * ⚠️ THE TENANT'S OWN NAMES, DELIBERATELY NOT THE ENGLISH DEFAULTS. The reporter's sentence puts THEIR name
 * in the brackets, asterisk and all; these fixtures share no word with the defaults, and §D asserts the
 * defaults never leak into a row or a name slot.
 *
 * ⚠️ EACH ROW IS ANNOTATED WITH THE (role, code) IT STANDS FOR. core/leave.ts cannot be imported here (it
 * opens the database at load), so test/r293-earned-accrual-picker.test.ts reads these comments back and asks
 * the REAL `isEarnedAccrualType` whether `swept` is right for each row. Keep one row per line, in this shape.
 */
const ANNUAL_BY_ROLE = '*Cuti Tahunan';
const OLD_ANNUAL_BY_NAME = 'Cuti Tahunan (lama)';
const FESTIVE = 'Hari Raya Day';
const SICK = 'MC';
const HOSP = 'Ward Leave';
const ENGLISH_DEFAULTS = ['Annual Leave', 'Medical Leave', 'Hospitalization Leave', 'Sick Leave'];

/** The reporter's tenant in miniature, after they switch "*Annual Leave" on. */
const MIXED: EarnedLeaveTypeOption[] = [
  { id: 'lt-al', name: ANNUAL_BY_ROLE, swept: true }, // role=annual code=AL
  { id: 'lt-fest', name: FESTIVE, swept: false }, // role= code=FEST
  { id: 'lt-sick', name: SICK, swept: false }, // role= code=SICK
  { id: 'lt-hosp', name: HOSP, swept: false }, // role=hospitalization code=HOSPITALIZATION
  { id: 'lt-old', name: OLD_ANNUAL_BY_NAME, swept: false }, // role= code=AL_OLD
];
const ANNUAL_NAMES_OF = (types: EarnedLeaveTypeOption[]) =>
  types
    .filter((o) => o.swept)
    .map((o) => o.name)
    .sort((a, b) => a.localeCompare(b));

const CARD_PROPS = {
  companies: [{ id: 'c1', name: 'Acme Sdn Bhd' }],
  grades: [{ id: 'g1', name: 'Executive' }],
  leaveYears: [{ year: 2026, status: 'draft' }],
  defaultYear: 2026,
};

const mount = (
  leaveTypes: EarnedLeaveTypeOption[],
  sweptLeaveTypeNames: string[],
  locale = 'en',
  messages: Record<string, unknown> = en as never,
) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <EarnedAccrualCard {...CARD_PROPS} leaveTypes={leaveTypes} sweptLeaveTypeNames={sweptLeaveTypeNames} />
    </NextIntlClientProvider>,
  );

const captions = (messages: typeof en) => ({
  type: messages.admin.leave.earnedScopeLeaveType,
  company: messages.admin.leave.earnedScopeCompany,
  grade: messages.admin.leave.earnedScopeGrade,
});

const openPicker = async (caption: string) => userEvent.click(screen.getByRole('button', { name: caption }));

/** One option row: its checkbox, its tag text and tone, and whether it is marked disabled. */
const row = (name: string) => {
  const label = screen.getByText(name).closest('label')!;
  const note = label.querySelector('[data-testid="multi-select-option-note"]');
  return {
    box: label.querySelector('input') as HTMLInputElement,
    tag: note?.textContent ?? null,
    tone: note?.getAttribute('data-tone') ?? null,
    disabled: label.getAttribute('data-disabled') === 'true',
  };
};

describe('§A every type that is not Annual Leave is LISTED, DISABLED and tagged Entitlement-based', () => {
  it('the rows stay in the list, cannot be ticked, and say why', async () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    for (const name of [FESTIVE, SICK, HOSP, OLD_ANNUAL_BY_NAME]) {
      const r = row(name);
      expect(r.box, name).toBeDisabled();
      expect(r.disabled, name).toBe(true);
      expect(r.tag, name).toBe(en.admin.leave.earnedTypeEntitlementTag);
      expect(r.tone, name).toBe('neutral');
      // Clicking the label or the box ticks nothing.
      await userEvent.click(screen.getByText(name));
      expect(r.box, `${name} was ticked`).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: captions(en).type }).textContent).toContain(
      en.admin.leave.earnedAllTypes,
    );
  });

  it('the decision is the SERVER’S boolean, not the name — a near-twin of the Annual Leave name stays disabled', async () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    expect(OLD_ANNUAL_BY_NAME.startsWith(ANNUAL_BY_ROLE.slice(1))).toBe(true);
    expect(row(OLD_ANNUAL_BY_NAME).box).toBeDisabled();
    expect(row(ANNUAL_BY_ROLE).box).toBeEnabled();
  });
});

describe('§B the second arm — Annual Leave is enabled and tagged Earned accrual', () => {
  it('is selectable, carries the positive tag, and the scope reports it', async () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    const r = row(ANNUAL_BY_ROLE);
    // ⚠️ THE VACUOUS-GUARD ARM. A picker that disabled every row passes §A in full and fails here.
    expect(r.box).toBeEnabled();
    expect(r.disabled).toBe(false);
    expect(r.tag).toBe(en.admin.leave.earnedTypeEarnedTag);
    expect(r.tone).toBe('positive');
    await userEvent.click(r.box);
    expect(r.box).toBeChecked();
    expect(screen.getByRole('button', { name: captions(en).type }).textContent).toContain(
      en.admin.leave.multiSelectSelectedCount.replace('{count}', '1'),
    );
  });

  it('the company and grade pickers are untouched — no tag, nothing disabled', async () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    for (const caption of [captions(en).company, captions(en).grade]) {
      await openPicker(caption);
      expect(screen.queryAllByTestId('multi-select-option-note')).toHaveLength(0);
      expect(document.querySelectorAll('label[data-disabled="true"]')).toHaveLength(0);
      await openPicker(caption); // close again
    }
  });
});

describe('§C Select all never ticks a disabled row — the posted scope holds Annual Leave only', () => {
  it('Select all selects the one enabled row, and Preview posts exactly that id', async () => {
    previewScopes.length = 0;
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    await userEvent.click(screen.getByRole('button', { name: en.admin.leave.multiSelectSelectAll }));
    expect(row(ANNUAL_BY_ROLE).box).toBeChecked();
    for (const name of [FESTIVE, SICK, HOSP, OLD_ANNUAL_BY_NAME]) expect(row(name).box, name).not.toBeChecked();
    await openPicker(captions(en).type); // close
    await userEvent.click(screen.getByRole('button', { name: en.admin.leave.earnedPreviewButton }));
    expect(previewScopes.map((s) => s.leaveTypeIds)).toEqual([['lt-al']]);
  });
});

describe('§D the reporter’s sentence, with the TENANT’S own Annual Leave name — never a default', () => {
  it('is drawn whatever is selected, word for word, with the name in the brackets', () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    expect(screen.getByTestId('earned-annual-only').textContent).toBe(
      'Earned Accrual applies only to Annual Leave (*Cuti Tahunan). Other leave types are entitlement-based ' +
        'and are excluded from this process.',
    );
  });

  it('the name slot and every row print what the server sent, never an English default name', async () => {
    mount(MIXED, ANNUAL_NAMES_OF(MIXED));
    await openPicker(captions(en).type);
    // The sentence's CONCEPT is Annual Leave (the reporter's words); the NAME in brackets is the tenant's.
    const bracket = /\(([^)]*)\)/.exec(screen.getByTestId('earned-annual-only').textContent ?? '')?.[1];
    expect(bracket).toBe(ANNUAL_BY_ROLE);
    for (const label of document.querySelectorAll('label')) {
      const name = label.querySelector('span')?.textContent ?? '';
      for (const d of ENGLISH_DEFAULTS) expect(name, `a row printed "${d}"`).not.toBe(d);
    }
  });

  it('two Annual Leave names are joined the reader’s way', () => {
    const two: EarnedLeaveTypeOption[] = [
      { id: 'a', name: 'Cuti A', swept: true },
      { id: 'b', name: 'Cuti B', swept: true },
    ];
    mount(two, ANNUAL_NAMES_OF(two));
    expect(screen.getByTestId('earned-annual-only').textContent).toContain('(Cuti A and Cuti B)');
  });
});

describe('§E no active Annual Leave — the sentence says so and names the switch', () => {
  it('replaces the bracketed sentence rather than printing empty brackets', () => {
    const none = MIXED.filter((o) => !o.swept);
    mount(none, []);
    const text = screen.getByTestId('earned-annual-only').textContent ?? '';
    expect(text).toBe(en.admin.leave.earnedAnnualOnlyNoneActive);
    expect(text).toContain('This is our Annual Leave');
    expect(text).not.toContain('()');
  });
});

describe('§F all six locales — a tag that paints MISSING_MESSAGE is not a tag', () => {
  for (const [locale, messages] of LOCALES) {
    it(`${locale} renders both tags and the sentence, with the tenant's name`, async () => {
      const m = messages as unknown as typeof en;
      mount(MIXED, ANNUAL_NAMES_OF(MIXED), locale, messages as never);

      const para = screen.getByTestId('earned-annual-only').textContent ?? '';
      expect(para, `${locale}: sentence`).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
      expect(para, `${locale}: lost the tenant's name`).toContain(ANNUAL_BY_ROLE);
      expect(para, `${locale}: unformatted placeholder`).not.toMatch(/\{names\}/);

      await openPicker(captions(m).type);
      const tags = screen.queryAllByTestId('multi-select-option-note');
      expect(tags, `${locale}: every row carries a tag`).toHaveLength(MIXED.length);
      expect(tags.filter((t) => t.textContent === m.admin.leave.earnedTypeEarnedTag)).toHaveLength(1);
      expect(tags.filter((t) => t.textContent === m.admin.leave.earnedTypeEntitlementTag)).toHaveLength(4);
      for (const t of tags) expect(t.textContent, `${locale}: tag`).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR/);
      expect(m.admin.leave.earnedAnnualOnlyNoneActive, `${locale}: none-active sentence`).toBeTruthy();
    });
  }
});
