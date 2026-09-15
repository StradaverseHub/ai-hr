/**
 * feedback 686dc512 (r288) — THE LEAVE TYPE EDITOR'S "this can never accrue" WARNING, RENDERED.
 *
 * WHAT THE ITEM IS. `accrueEarnedLeave` filters `code IN STANDING_LEAVE_CODES` (ANNUAL · SICK ·
 * HOSPITALIZATION) BEFORE it reads a single employment, so a leave type carrying any other code never
 * accrues, whatever its earning method, entitlement tables or their dates say. Nothing under app/ or
 * messages/ referenced that constant before this round, so the leave type editor accepted the
 * combination in silence — which is how the reporting account came to hold a second leave type called
 * "*Annual Leave" that looked correctly configured and could never produce a day. The reporter was then
 * given the WRONG reason for it (the entitlement tables' start dates), and this warning is the durable
 * half of that correction.
 *
 * ⚠️ WHY THIS FILE RENDERS RATHER THAN GREPS. The warning is a live function of a `useState` dropdown
 * inside a client island. Its condition is never in the SSR output for a type that is currently set to
 * *None*, so a curl of the page proves nothing; and a key that exists in no catalogue satisfies tsc,
 * `next build` and every source scan while next-intl paints `MISSING_MESSAGE` in the browser. So the
 * real component is driven against the SHIPPING catalogues, in all six locales.
 *
 * ⚠️ THE SECOND ARM IS THE ONE THAT MATTERS. A warning that renders unconditionally would pass every
 * "the warning is shown" assertion in this file. §B and §C are the arms a vacuous guard would hide in:
 * a STANDING code with the same earned method shows NOTHING, and a non-earned method on the same
 * non-standing code shows NOTHING.
 *
 * ⚠️ AND IT MUST NOT BLOCK THE SAVE (§E). The plan commits to warning rather than refusing — a tenant
 * may legitimately keep such a type for a non-accruing purpose, and a hard validation would be an
 * unrequested behaviour change on every existing row. §E pins that the form posts a byte-identical
 * FormData with the warning on screen as it does with the warning absent, and that the submit still
 * reaches the action.
 *
 * NOTHING ABOUT THE ENGINE IS ASSERTED HERE. Which codes the sweep covers is core/leave.ts's business
 * and test/earned-accrual*.test.ts's; which of these facts the SERVER derives is
 * test/r288-earned-sweep-warning.test.ts's. This file pins only what the editor does with the facts it
 * is handed — including that it prints THE TENANT'S OWN type names and never a hardcoded English one.
 */
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider, useTranslations } from 'next-intl';

// The SHIPPING catalogues, not fixtures: a half-translated round is the failure §F exists to catch.
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
 * ⚠️ THE ENGINE'S TWO CONSTANTS, WRITTEN OUT RATHER THAN IMPORTED — AND THAT IS NOT A SHORTCUT.
 *
 * `core/leave.ts` opens the database connection at module load (`db/client.ts` throws "DATABASE_URL is
 * not set" on import), and the `dom` vitest project deliberately has no env bootstrap and no database.
 * A jsdom file can import that module's TYPES, which are erased, but not its VALUES — this was tried and
 * the suite failed to collect.
 *
 * So these are a COPY, and an unpinned copy is precisely the drift this whole round exists to end.
 * test/r288-earned-sweep-warning.test.ts runs in the node project, CAN import the engine, and reads
 * these two literals back out of THIS FILE'S SOURCE to assert they still equal `EARNED_METHODS` and
 * `STANDING_LEAVE_CODES`. Change the engine's family without changing the two lines below and that node
 * test goes red. Keep the names and the single-line array shape — it is what the regex there matches.
 */
const ENGINE_EARNED_METHODS_COPY = ['earned_monthly', 'earned_quarterly', 'earned_daily'];
const ENGINE_STANDING_CODES_COPY = ['ANNUAL', 'SICK', 'HOSPITALIZATION'];

const LOCALES = [
  ['en', en],
  ['ms', ms],
  ['ta', ta],
  ['th', th],
  ['vi', vi_],
  ['zh', zh],
] as const;

/**
 * ⚠️ THE TENANT'S OWN NAMES, AND DELIBERATELY NOT THE ENGLISH DEFAULTS. The three standing CODES are
 * fixed; the names against them are whatever the tenant typed. "Annual Leave is not accrued here" is a
 * riddle on an account that has two leave types both called some variant of Annual Leave — which is
 * exactly the account that raised this — so these fixtures share no word with the defaults and §D
 * asserts the defaults never appear.
 */
const TENANT_SWEPT_NAMES = ['Cuti Tahunan', 'MC', 'Ward Leave'];
const ENGLISH_DEFAULTS = ['Annual Leave', 'Medical Leave', 'Hospitalization Leave', 'Sick Leave'];

const sweep = (over: Partial<EarnedSweepFacts> = {}): EarnedSweepFacts => ({
  codeIsSwept: false,
  earnedMethods: [...ENGINE_EARNED_METHODS_COPY],
  sweptTypeNames: TENANT_SWEPT_NAMES,
  ...over,
});

/** A leave type set to earn monthly — the production shape of the defect. */
const EARNED_MONTHLY: LeaveTypeRules = { accrualMethod: 'earned_monthly', accrualDay: 1 };
/** The lump-sum path. `grant_on_hire_prorated` is what the *None* choice stores. */
const NOT_EARNED: LeaveTypeRules = { accrualMethod: 'grant_on_hire_prorated' };

/**
 * The form takes its translator as a prop (the tabs hand it `useTranslations('admin.leave')`), so the
 * mount below reproduces that call site exactly rather than inventing a second one.
 */
function Mount({ rules, facts }: { rules: LeaveTypeRules; facts: EarnedSweepFacts }) {
  const t = useTranslations('admin.leave');
  return <EarningMethodForm t={t} rules={rules} action={() => {}} leaveTypeId="lt-1" sweep={facts} />;
}

const wrap = (locale: string, messages: Record<string, unknown>, ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const mount = (
  rules: LeaveTypeRules,
  facts: EarnedSweepFacts = sweep(),
  locale = 'en',
  messages: Record<string, unknown> = en,
) => wrap(locale, messages, <Mount rules={rules} facts={facts} />);

/** The warning, or null when it is absent. Found by role+testid, never by matching its own text. */
const warning = () => screen.queryByTestId('earning-not-swept');

describe('§A · an earned method on a code the sweep can never reach WARNS', () => {
  it('names the three types the sweep does cover, in the tenant’s own words', () => {
    mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }));
    const w = warning();
    expect(w).not.toBeNull();
    for (const name of TENANT_SWEPT_NAMES) expect(w).toHaveTextContent(name);
    // Not a placeholder left unfilled, and not a bare list with no sentence around it.
    expect(w!.textContent).not.toContain('{swept}');
    expect(w!.textContent!.length).toBeGreaterThan(TENANT_SWEPT_NAMES.join(', ').length + 40);
  });

  it('warns on DAILY accrual too — the family is the engine’s, not one chosen option', () => {
    mount({ accrualMethod: 'earned_daily' }, sweep({ codeIsSwept: false }));
    expect(warning()).not.toBeNull();
  });

  it('warns on a LEGACY stored method the dropdown no longer offers', () => {
    // `earned_quarterly` renders on the read-only branch and is re-posted verbatim. It is just as
    // unreachable on a non-standing code as earned_monthly is, and a check written against the two
    // options this select happens to render would have quietly exempted it.
    expect(ENGINE_EARNED_METHODS_COPY).toContain('earned_quarterly');
    mount({ accrualMethod: 'earned_quarterly' }, sweep({ codeIsSwept: false }));
    expect(warning()).not.toBeNull();
  });

  it('appears the moment the method is CHANGED, before anything is saved', async () => {
    // The whole point of the item: the mismatch is visible while the administrator is still editing,
    // not three days later through a run that comes back empty on a different screen.
    const user = userEvent.setup();
    mount(NOT_EARNED, sweep({ codeIsSwept: false }));
    expect(warning()).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: en.admin.leave.subStep.earningMethodLabel }), 'monthly');
    expect(warning()).not.toBeNull();
  });
});

describe('§B · THE ARM A VACUOUS GUARD WOULD HIDE IN — a STANDING code shows NOTHING', () => {
  it('the same earned method on a swept code renders no warning at all', () => {
    mount(EARNED_MONTHLY, sweep({ codeIsSwept: true }));
    expect(warning()).toBeNull();
  });

  it('…and that holds for every earned method in the engine’s family', () => {
    for (const method of ENGINE_EARNED_METHODS_COPY) {
      const view = mount({ accrualMethod: method }, sweep({ codeIsSwept: true }));
      expect(within(view.container).queryByTestId('earning-not-swept'), method).toBeNull();
      view.unmount();
    }
  });

  it('switching a SWEPT type to monthly still shows nothing', async () => {
    const user = userEvent.setup();
    mount(NOT_EARNED, sweep({ codeIsSwept: true }));
    await user.selectOptions(screen.getByRole('combobox', { name: en.admin.leave.subStep.earningMethodLabel }), 'monthly');
    expect(warning()).toBeNull();
  });
});

describe('§C · a NON-earned method shows nothing, whatever the code', () => {
  it('the lump-sum path on a non-standing code renders no warning', () => {
    mount(NOT_EARNED, sweep({ codeIsSwept: false }));
    expect(warning()).toBeNull();
  });

  it('a type whose method has never been configured renders no warning', () => {
    // `accrualUnconfigured` is its own amber note ("not configured yet"); adding a second amber
    // paragraph to a type nobody has set up is noise, not a finding.
    mount({ accrualMethod: null, accrualUnconfigured: '2026-01-01T00:00:00.000Z' }, sweep({ codeIsSwept: false }));
    expect(warning()).toBeNull();
  });

  it('switching AWAY from an earned method clears the warning again', async () => {
    const user = userEvent.setup();
    mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }));
    expect(warning()).not.toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: en.admin.leave.subStep.earningMethodLabel }), 'none');
    expect(warning()).toBeNull();
  });
});

describe('§D · the names are the TENANT’S, never the English defaults', () => {
  it('prints no default leave-type name when the tenant has renamed all three', () => {
    mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }));
    const text = warning()!.textContent!;
    for (const d of ENGLISH_DEFAULTS) expect(text, `leaked default name: ${d}`).not.toContain(d);
  });

  it('the catalogue strings themselves carry no leave-type name in any locale', () => {
    // The strongest form of the rule: a future edit cannot satisfy §D by moving the hardcoded name into
    // the message. The names arrive only through the {swept} placeholder.
    for (const [loc, m] of LOCALES) {
      const sub = (m as typeof en).admin.leave.subStep;
      for (const key of ['earningNotSwept', 'earningNotSweptNoneActive'] as const) {
        for (const d of ENGLISH_DEFAULTS) {
          expect(sub[key], `${loc}.${key} hardcodes ${d}`).not.toContain(d);
        }
      }
      // And the engine's codes are not printed at an administrator either.
      for (const code of ENGINE_STANDING_CODES_COPY) {
        expect(sub.earningNotSwept, `${loc} prints the raw code ${code}`).not.toContain(code);
      }
    }
  });

  it('when the tenant has archived all three, it says so instead of printing an empty list', () => {
    // THE REPORTING ACCOUNT'S ACTUAL STATE: its real Annual Leave is archived, so the swept set is
    // empty. "covers only these leave types: ." would be worse than the flat sentence.
    mount(EARNED_MONTHLY, sweep({ codeIsSwept: false, sweptTypeNames: [] }));
    const w = warning();
    expect(w).not.toBeNull();
    expect(w).toHaveTextContent(en.admin.leave.subStep.earningNotSweptNoneActive);
    expect(w!.textContent).not.toContain('{swept}');
    for (const name of TENANT_SWEPT_NAMES) expect(w!.textContent).not.toContain(name);
  });
});

describe('§E · WARN, DO NOT REFUSE — the save is untouched', () => {
  /** Everything the form would post, as a sorted list of name=value pairs. */
  const posted = (form: HTMLFormElement) =>
    [...new FormData(form).entries()].map(([k, v]) => `${k}=${String(v)}`).sort();

  it('posts a byte-identical FormData with the warning showing as without it', () => {
    const warned = mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }));
    const warnedForm = warned.container.querySelector('form') as HTMLFormElement;
    expect(within(warned.container).queryByTestId('earning-not-swept')).not.toBeNull();
    const withWarning = posted(warnedForm);
    warned.unmount();

    const quiet = mount(EARNED_MONTHLY, sweep({ codeIsSwept: true }));
    const quietForm = quiet.container.querySelector('form') as HTMLFormElement;
    expect(within(quiet.container).queryByTestId('earning-not-swept')).toBeNull();

    expect(withWarning).toEqual(posted(quietForm));
    // …and it is the real row, not an empty form: the method and both tri-state markers are in it.
    expect(withWarning).toContain('method=earned_monthly');
    expect(withWarning).toContain('earningRendered=1');
    expect(withWarning).toContain('roundingMethodRendered=1');
  });

  it('the Save button is enabled and the submit reaches the action', async () => {
    const user = userEvent.setup();
    const seen: FormData[] = [];
    wrap(
      'en',
      en,
      <Mount rules={EARNED_MONTHLY} facts={sweep({ codeIsSwept: false })} />,
    ).unmount();
    // Rendered again with a real action so the submit can be observed end to end.
    function Submitting() {
      const t = useTranslations('admin.leave');
      return (
        <EarningMethodForm
          t={t}
          rules={EARNED_MONTHLY}
          action={(fd) => {
            seen.push(fd);
          }}
          leaveTypeId="lt-1"
          sweep={sweep({ codeIsSwept: false })}
        />
      );
    }
    wrap('en', en, <Submitting />);
    expect(warning()).not.toBeNull();
    const save = screen.getByRole('button', { name: en.admin.leave.save });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(seen.length, 'the warning blocked the save').toBe(1);
    expect(seen[0].get('method')).toBe('earned_monthly');
    // The warning is still on screen afterwards — it is advice, not a transient validation message.
    expect(warning()).not.toBeNull();
  });

  it('renders no destructive-styled text and no disabled control', () => {
    const view = mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }));
    const w = view.container.querySelector('[data-testid="earning-not-swept"]') as HTMLElement;
    // Amber, like the Daily-Accrual rounding warning beside it — the repo's colour for "advice".
    expect(w.className).toContain('text-amber-600');
    expect(w.className).not.toContain('text-destructive');
    expect(view.container.querySelectorAll('[disabled]').length).toBe(0);
  });
});

describe('§F · all six catalogues render a real sentence', () => {
  it.each(LOCALES.map(([loc, m]) => [loc, m] as const))(
    '%s — the swept-name variant is translated and complete',
    (loc, messages) => {
      const view = mount(EARNED_MONTHLY, sweep({ codeIsSwept: false }), loc, messages as Record<string, unknown>);
      const w = within(view.container).queryByTestId('earning-not-swept');
      expect(w, `${loc}: no warning rendered`).not.toBeNull();
      expect(w!.textContent, `${loc}: MISSING_MESSAGE`).not.toContain('MISSING_MESSAGE');
      expect(w!.textContent, `${loc}: unfilled placeholder`).not.toContain('{swept}');
      for (const name of TENANT_SWEPT_NAMES) expect(w!.textContent, `${loc}: lost a name`).toContain(name);
      view.unmount();
    },
  );

  it.each(LOCALES.map(([loc, m]) => [loc, m] as const))(
    '%s — the none-active variant is translated and complete',
    (loc, messages) => {
      const view = mount(
        EARNED_MONTHLY,
        sweep({ codeIsSwept: false, sweptTypeNames: [] }),
        loc,
        messages as Record<string, unknown>,
      );
      const w = within(view.container).queryByTestId('earning-not-swept');
      expect(w, `${loc}: no warning rendered`).not.toBeNull();
      expect(w!.textContent, `${loc}: MISSING_MESSAGE`).not.toContain('MISSING_MESSAGE');
      expect(w!.textContent!.trim().length, `${loc}: empty string`).toBeGreaterThan(20);
      view.unmount();
    },
  );
});
