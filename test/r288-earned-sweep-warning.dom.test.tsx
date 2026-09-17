/**
 * feedback 686dc512 (r288) — THE LEAVE TYPE EDITOR'S EARNED-ACCRUAL FACTS, RENDERED.
 * r299 (3de1453a) — UPDATED, NOT DELETED. r288 rendered a WARNING and pinned "WARN, DO NOT REFUSE — the save
 * is untouched". The reporter's rule — "Only Annual Leave (*Annual Leave) is subject to the Earned Accrual
 * concept. All other leave types are managed based on entitlement and should not be included in the Earned
 * Accrual process." — reverses that, and this file pins what replaced it on the Earning Method form:
 *
 *   §A  "This is our Annual Leave" — its five states, what each says, and what it posts;
 *   §B  THE ARM A VACUOUS GUARD WOULD HIDE IN — Monthly/Daily are ENABLED on Annual Leave, and switching the
 *       switch on enables them live, before anything is saved (one save);
 *   §C  on every other type Monthly/Daily are LISTED BUT DISABLED, with the reporter's entitlement sentence;
 *   §D  a STRANDED earned method (stored before the rule) is shown with its note and re-posted VERBATIM — and,
 *       since the r299 fix pass, a LEGACY one (`earned_quarterly`) on a type that is not Annual Leave can be
 *       replaced by None on the select, while Annual Leave on a legacy method keeps the read-only branch;
 *   §E  the switch is held on where the save would be refused, and posts nothing where it is locked;
 *   §F  all six catalogues.
 *
 * ⚠️ WHY THIS FILE RENDERS RATHER THAN GREPS (r288's reason, still true). Every one of these is a live
 * function of `useState` inside a client island; a curl proves nothing and a missing key paints
 * MISSING_MESSAGE only in the browser. The real component, the SHIPPING catalogues.
 *
 * NOTHING ABOUT THE SERVICE IS ASSERTED HERE — test/r299-earned-accrual-annual-only.test.ts §3 and
 * test/r288-earned-sweep-warning.test.ts §3 refuse and accept against a real database.
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, useTranslations } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  EarningMethodForm,
  type EarnedSweepFacts,
  type LeaveTypeRules,
} from '../app/admin/leave-config/types/leave-type-sub-forms';

/**
 * ⚠️ THE ENGINE'S EARNED FAMILY, WRITTEN OUT RATHER THAN IMPORTED — core/leave.ts opens the database at
 * module load and the `dom` project has no env bootstrap. test/r288-earned-sweep-warning.test.ts reads this
 * literal back out of THIS FILE and asserts it still equals `EARNED_METHODS`. Keep the name and the
 * single-line array shape.
 */
const ENGINE_EARNED_METHODS_COPY = ['earned_monthly', 'earned_quarterly', 'earned_daily'];

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/** The tenant's own names — no English default, as r288 insisted. */
const THIS_TYPE = 'MC';
const THEIR_ANNUAL = '*Cuti Tahunan';

const facts = (over: Partial<EarnedSweepFacts> = {}): EarnedSweepFacts => ({
  leaveTypeName: THIS_TYPE,
  annualSwitch: 'off',
  otherAnnualLeaveTypeNames: [],
  earnedMethods: [...ENGINE_EARNED_METHODS_COPY],
  ...over,
});

const EARNED_MONTHLY: LeaveTypeRules = { accrualMethod: 'earned_monthly', accrualDay: 1 };
/** The lump-sum path. `grant_on_hire_prorated` is what the *None* choice stores. */
const NOT_EARNED: LeaveTypeRules = { accrualMethod: 'grant_on_hire_prorated' };

function Mount({ rules, sweep, action }: { rules: LeaveTypeRules; sweep: EarnedSweepFacts; action?: (fd: FormData) => void }) {
  const t = useTranslations('admin.leave');
  return <EarningMethodForm t={t} rules={rules} action={action ?? (() => {})} leaveTypeId="lt-1" sweep={sweep} />;
}

const wrap = (locale: string, messages: Record<string, unknown>, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const mount = (rules: LeaveTypeRules, sweep: EarnedSweepFacts = facts(), locale = 'en', messages: Record<string, unknown> = en) =>
  wrap(locale, messages, <Mount rules={rules} sweep={sweep} />);

const S = en.admin.leave.subStep;
const theSwitch = () => screen.getByRole('switch', { name: S.annualLeaveSwitchLabel });
const methodSelect = () => screen.getByRole('combobox', { name: S.earningMethodLabel }) as HTMLSelectElement;
const optionOf = (value: string) => methodSelect().querySelector(`option[value="${value}"]`) as HTMLOptionElement;
const posted = (container: HTMLElement) =>
  [...new FormData(container.querySelector('form') as HTMLFormElement).entries()].map(([k, v]) => `${k}=${String(v)}`).sort();

describe('§A "This is our Annual Leave" — five states, each says what is true', () => {
  it('ON (recorded as Annual Leave): checked, editable, posts its marker and 1', () => {
    const view = mount(NOT_EARNED, facts({ annualSwitch: 'on' }));
    expect(theSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(theSwitch()).toBeEnabled();
    expect(screen.getByTestId('annual-leave-switch')).toHaveTextContent(S.annualLeaveSwitchOnHelp);
    expect(posted(view.container)).toEqual(expect.arrayContaining(['annualLeaveRendered=1', 'isAnnualLeave=1']));
  });

  it('OFF with no Annual Leave anywhere: unchecked, editable, posts 0', () => {
    const view = mount(NOT_EARNED, facts());
    expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(theSwitch()).toBeEnabled();
    expect(screen.getByTestId('annual-leave-switch')).toHaveTextContent(S.annualLeaveSwitchOffHelp);
    expect(posted(view.container)).toEqual(expect.arrayContaining(['annualLeaveRendered=1', 'isAnnualLeave=0']));
  });

  it('OFF while another type IS Annual Leave: locked, names it (the mockup’s sentence), posts NO marker', () => {
    const view = mount(NOT_EARNED, facts({ otherAnnualLeaveTypeNames: [THEIR_ANNUAL] }));
    expect(theSwitch()).toBeDisabled();
    expect(screen.getByTestId('annual-leave-switch')).toHaveTextContent(`Your Annual Leave is ${THEIR_ANNUAL}.`);
    expect(posted(view.container).some((p) => p.startsWith('annualLeaveRendered') || p.startsWith('isAnnualLeave'))).toBe(false);
  });

  it('BY CODE (unclassified, the seeded code): shown on, locked, no marker', () => {
    const view = mount(EARNED_MONTHLY, facts({ annualSwitch: 'by_code' }));
    expect(theSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(theSwitch()).toBeDisabled();
    expect(screen.getByTestId('annual-leave-switch')).toHaveTextContent(S.annualLeaveSwitchByCodeHelp);
    expect(posted(view.container).some((p) => p.startsWith('annualLeaveRendered'))).toBe(false);
    // Annual Leave by code may earn: nothing about the method is locked.
    expect(optionOf('monthly').disabled).toBe(false);
  });

  it('OTHER ROLE (Sick, Maternity…): shown off, locked, no marker', () => {
    const view = mount(NOT_EARNED, facts({ annualSwitch: 'other_role' }));
    expect(theSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(theSwitch()).toBeDisabled();
    expect(screen.getByTestId('annual-leave-switch')).toHaveTextContent(S.annualLeaveSwitchOtherRoleHelp);
    expect(posted(view.container).some((p) => p.startsWith('annualLeaveRendered'))).toBe(false);
  });
});

describe('§B THE ARM A VACUOUS GUARD WOULD HIDE IN — Annual Leave may earn, and the switch unlocks it live', () => {
  it('on Annual Leave Monthly and Daily are enabled, and no entitlement note is drawn', () => {
    mount(EARNED_MONTHLY, facts({ annualSwitch: 'on' }));
    expect(optionOf('monthly').disabled).toBe(false);
    expect(optionOf('daily').disabled).toBe(false);
    expect(screen.queryByTestId('earning-entitlement-based')).toBeNull();
    expect(screen.queryByTestId('earning-stranded')).toBeNull();
  });

  it('switching ON enables Monthly Accrual immediately, and ONE submit carries the switch and the method', async () => {
    const user = userEvent.setup();
    const seen: FormData[] = [];
    wrap('en', en, <Mount rules={NOT_EARNED} sweep={facts()} action={(fd) => void seen.push(fd)} />);
    expect(optionOf('monthly').disabled).toBe(true);
    await user.click(theSwitch());
    expect(theSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(optionOf('monthly').disabled).toBe(false);
    await user.selectOptions(methodSelect(), 'monthly');
    await user.type(screen.getByRole('spinbutton', { name: S.accrualDayLabel }), '1');
    await user.click(screen.getByRole('button', { name: en.admin.leave.save }));
    expect(seen).toHaveLength(1);
    expect(seen[0].get('annualLeaveRendered')).toBe('1');
    expect(seen[0].get('isAnnualLeave')).toBe('1');
    expect(seen[0].get('method')).toBe('earned_monthly');
  });
});

describe('§C every other type — Monthly and Daily LISTED BUT DISABLED, with the reporter’s sentence', () => {
  it('None is offered; Monthly and Daily are greyed; the note names this type', () => {
    mount(NOT_EARNED, facts({ otherAnnualLeaveTypeNames: [THEIR_ANNUAL] }));
    expect(optionOf('none').disabled).toBe(false);
    expect(optionOf('monthly').disabled).toBe(true);
    expect(optionOf('daily').disabled).toBe(true);
    expect(screen.getByTestId('earning-entitlement-based').textContent).toBe(
      'MC is entitlement-based. Only Annual Leave can be earned through Earned Accrual.',
    );
  });

  it('a type never configured keeps its Not configured placeholder, and still may not earn', () => {
    mount({ accrualMethod: null, accrualUnconfigured: '2026-01-01T00:00:00.000Z' }, facts({ annualSwitch: 'other_role' }));
    expect(methodSelect().value).toBe('');
    expect(optionOf('monthly').disabled).toBe(true);
    expect(screen.getByTestId('earning-entitlement-based')).toBeInTheDocument();
  });
});

describe('§D a STRANDED earned method is shown, noted, and re-posted VERBATIM — never rewritten', () => {
  it('Monthly Accrual stored on a type that is not Annual Leave', () => {
    const view = mount(EARNED_MONTHLY, facts({ annualSwitch: 'other_role' }));
    expect(methodSelect().value).toBe('monthly');
    expect(screen.getByTestId('earning-stranded').textContent).toBe(
      'MC is still set to earn its days through Earned Accrual, but Earned Accrual applies only to Annual Leave, ' +
        'so no run adds days to it. The setting is kept exactly as it is when you save. To fix it, change the ' +
        'earning method to None (granted up front).',
    );
    expect(screen.queryByTestId('earning-entitlement-based')).toBeNull();
    expect(posted(view.container)).toContain('method=earned_monthly');
  });

  // r299 fix pass (3de1453a) — THIS CASE USED TO READ "a LEGACY stored method on the READ-ONLY branch is stranded
  // too", and the read-only branch was the defect: the stranded note tells HR to change the method to None, and
  // a type stored on `earned_quarterly` rendered a span with nothing to change it with. It now renders on the
  // select — still stranded, still re-posted verbatim until HR chooses, and now replaceable.
  it.each(['other_role', 'off'] as const)(
    'a LEGACY stored earned method (%s) is stranded, named, re-posted verbatim — and replaceable by None',
    async (annualSwitch) => {
      const user = userEvent.setup();
      const view = mount({ accrualMethod: 'earned_quarterly' }, facts({ annualSwitch }));
      expect(screen.getByTestId('earning-stranded')).toBeInTheDocument();
      expect(posted(view.container)).toContain('method=earned_quarterly');
      // The select, not the read-only span, and not the legacy note that says "shown here read-only".
      expect(methodSelect().value).toBe('legacy');
      expect(optionOf('legacy').textContent).toBe(en.admin.leave.earnedMethodQuarterly);
      expect(view.container.textContent).not.toContain(S.earningLegacyMethodNote);
      // WHAT THIS TYPE MAY USE: None. The stored earned method and the other two are listed but not choosable,
      // and Not configured stays a placeholder for a type that IS unconfigured (the known branch's rule).
      const offered = [...methodSelect().options].map((o) => [o.value, o.disabled]);
      expect(offered).toEqual([
        ['legacy', true],
        ['none', false],
        ['monthly', true],
        ['daily', true],
      ]);
      // THE FIX THE NOTE NAMES, APPLIED.
      await user.selectOptions(methodSelect(), 'none');
      expect(screen.queryByTestId('earning-stranded')).toBeNull();
      expect(screen.getByTestId('earning-entitlement-based')).toBeInTheDocument();
      expect(posted(view.container)).toContain('method=grant_on_hire_prorated');
      expect(posted(view.container)).not.toContain('method=earned_quarterly');
    },
  );

  it('an UNCONFIGURED type holding a legacy earned method offers Not configured, selected, beside None', () => {
    const view = mount(
      { accrualMethod: 'earned_quarterly', accrualUnconfigured: '2026-01-01T00:00:00.000Z' },
      facts({ annualSwitch: 'other_role' }),
    );
    expect(methodSelect().value).toBe('');
    expect([...methodSelect().options].map((o) => [o.value, o.disabled])).toEqual([
      ['', false],
      ['legacy', true],
      ['none', false],
      ['monthly', true],
      ['daily', true],
    ]);
    // Exactly what the known branch posts on its placeholder: the method field empty, the marker untouched.
    expect(posted(view.container)).toContain('method=');
  });

  it.each(['on', 'by_code'] as const)(
    'ANNUAL LEAVE (%s) on a legacy method keeps the read-only branch exactly as before',
    (annualSwitch) => {
      const view = mount({ accrualMethod: 'earned_quarterly' }, facts({ annualSwitch }));
      expect(screen.queryByRole('combobox', { name: S.earningMethodLabel })).toBeNull();
      expect(view.container.textContent).toContain('earned_quarterly');
      expect(view.container.textContent).toContain(S.earningLegacyMethodNote);
      expect(posted(view.container)).toContain('method=earned_quarterly');
      expect(screen.queryByTestId('earning-stranded')).toBeNull();
    },
  );

  it('an unknown stored value that is NOT an earned method stays read-only on any type', () => {
    const view = mount({ accrualMethod: 'hand_crafted_value' }, facts({ annualSwitch: 'other_role' }));
    expect(screen.queryByRole('combobox', { name: S.earningMethodLabel })).toBeNull();
    expect(view.container.textContent).toContain(S.earningLegacyMethodNote);
    expect(posted(view.container)).toContain('method=hand_crafted_value');
  });

  it('choosing None clears the stranded note and posts the change', async () => {
    const user = userEvent.setup();
    const view = mount(EARNED_MONTHLY, facts({ annualSwitch: 'other_role' }));
    await user.selectOptions(methodSelect(), 'none');
    expect(screen.queryByTestId('earning-stranded')).toBeNull();
    expect(screen.getByTestId('earning-entitlement-based')).toBeInTheDocument();
    expect(posted(view.container)).toContain('method=grant_on_hire_prorated');
  });
});

describe('§E the switch is HELD where the save would be refused', () => {
  it('Annual Leave with an earned method: the switch cannot be turned off until the method is None', async () => {
    const user = userEvent.setup();
    const view = mount(EARNED_MONTHLY, facts({ annualSwitch: 'on' }));
    expect(theSwitch()).toBeDisabled();
    expect(screen.getByTestId('annual-leave-switch-held').textContent).toBe(
      'To switch this off, first change the earning method to None — only Annual Leave can use Monthly Accrual or Daily Accrual.',
    );
    // Still POSTED as on — a disabled control must not read as OFF.
    expect(posted(view.container)).toContain('isAnnualLeave=1');
    await user.selectOptions(methodSelect(), 'none');
    expect(theSwitch()).toBeEnabled();
    await user.click(theSwitch());
    expect(posted(view.container)).toEqual(expect.arrayContaining(['isAnnualLeave=0', 'method=grant_on_hire_prorated']));
  });

  it('a stranded method re-posted unchanged does NOT hold the switch — switching on is the other fix', async () => {
    const user = userEvent.setup();
    mount(EARNED_MONTHLY, facts());
    await user.click(theSwitch());
    expect(theSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(theSwitch()).toBeEnabled();
    expect(screen.queryByTestId('earning-stranded')).toBeNull();
  });
});

describe('§F all six catalogues render real sentences', () => {
  it.each(LOCALES.map(([loc, m]) => [loc, m] as const))('%s — switch, entitlement note and stranded note', (loc, messages) => {
    const views = [
      mount(NOT_EARNED, facts({ otherAnnualLeaveTypeNames: [THEIR_ANNUAL] }), loc, messages as Record<string, unknown>),
      mount(EARNED_MONTHLY, facts({ annualSwitch: 'other_role' }), loc, messages as Record<string, unknown>),
      mount(EARNED_MONTHLY, facts({ annualSwitch: 'on' }), loc, messages as Record<string, unknown>),
    ];
    const [other, stranded, held] = views.map((v) => v.container);
    for (const [where, text] of [
      ['switch', within(other).getByTestId('annual-leave-switch').textContent],
      ['entitlement note', within(other).getByTestId('earning-entitlement-based').textContent],
      ['stranded note', within(stranded).getByTestId('earning-stranded').textContent],
      ['held note', within(held).getByTestId('annual-leave-switch-held').textContent],
    ] as const) {
      expect(text, `${loc}: ${where}`).not.toMatch(/MISSING_MESSAGE|FORMATTING_ERROR|\{(names|type|none|monthly|daily)\}/);
      expect((text ?? '').trim().length, `${loc}: ${where} empty`).toBeGreaterThan(10);
    }
    expect(within(other).getByTestId('annual-leave-switch').textContent, `${loc}: lost the tenant's name`).toContain(THEIR_ANNUAL);
    expect(within(stranded).getByTestId('earning-stranded').textContent, `${loc}: lost this type's name`).toContain(THIS_TYPE);
    for (const v of views) v.unmount();
    // r299 fix pass — the replaceable LEGACY method names itself from the catalogue, never as a raw key path.
    const legacy = mount({ accrualMethod: 'earned_quarterly' }, facts({ annualSwitch: 'other_role' }), loc, messages as Record<string, unknown>);
    const legacyLabel = (messages as unknown as { admin: { leave: { earnedMethodQuarterly: string } } }).admin.leave.earnedMethodQuarterly;
    expect(legacy.container.querySelector('option[value="legacy"]')?.textContent, `${loc}: legacy option`).toBe(legacyLabel);
    expect(legacyLabel, `${loc}: legacy label`).not.toMatch(/MISSING_MESSAGE|admin\.leave/);
    legacy.unmount();
  });
});
