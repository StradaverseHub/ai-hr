/**
 * 74d00fd2 — the parts of Select all / Deselect all a source scan cannot prove, RENDERED.
 *
 * Everything asserted here is behaviour of a client island: what the closed trigger says at each count,
 * whether the same sentence is printed twice, and — the one that matters — what `new FormData(form)` still
 * carries after the operator types a filter and presses Deselect all. A dev-server log can never see any of
 * it, and test/eligibility-bulk-select.ts can only see the shapes that produce it.
 *
 * The BEHAVIOUR blocks render the control directly rather than through EligibilityRuleForm: the form needs
 * two server actions and 26 catalogues, none of which changes what this item changed, and the props below
 * are exactly the ones the eligibility call site passes. The LAST block renders the real form, because the
 * question there is about the real t() calls in all six catalogues.
 *
 * Scope note: jsdom applies no CSS, so nothing here says anything about how the popover sits over the
 * section. What it pins is the posted FormData and the text on the control.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

import { ChipMultiSelect } from '../components/ui/chip-multi-select';
import { EligibilityRuleForm } from '../components/leave/eligibility-rule-form';
import type { CriteriaSection } from '../core/org-criteria-form';
// The SHIPPING catalogues, not fixtures — the whole point of the last block is that these six files are
// what a missing or unformattable key would be missing from. (jsdom gives import.meta.url an http URL, so
// readFileSync off it is not available here; static imports are how the other DOM tests load messages.)
import enMessages from '../messages/en.json';
import msMessages from '../messages/ms.json';
import zhMessages from '../messages/zh.json';
import taMessages from '../messages/ta.json';
import thMessages from '../messages/th.json';
import viMessages from '../messages/vi.json';

/** Seven values, deliberately including two that share the "ind" substring the plan's example filters on. */
const NATIONALITIES = [
  { value: 'my', label: 'Malaysian' },
  { value: 'sg', label: 'Singaporean' },
  { value: 'id', label: 'Indonesian' },
  { value: 'in', label: 'Indian' },
  { value: 'th', label: 'Thai' },
  { value: 'vn', label: 'Vietnamese' },
  { value: 'ph', label: 'Filipino' },
];

/** The eligibility call site's props, verbatim in shape. summaryThreshold stays at its default of 4. */
function renderPicker(options = NATIONALITIES, defaultSelected: string[] = []) {
  const view = render(
    <form>
      <ChipMultiSelect
        name="nationalities"
        label="Nationality"
        options={options}
        defaultSelected={defaultSelected}
        addPlaceholder="Add…"
        removeLabelFor={(label) => `Remove ${label}`}
        searchPlaceholder="Search…"
        selectAllLabel="Select all"
        clearAllLabel="Deselect all"
        triggerSummaryFor={(n, allSelected) => (allSelected ? 'All selected' : `${n} selected`)}
      />
    </form>,
  );
  const form = view.container.querySelector('form') as HTMLFormElement;
  const trigger = () => screen.getByRole('button', { name: 'Nationality' });
  const posted = () => new FormData(form).getAll('nationalities').map(String);
  return { ...view, form, trigger, posted };
}

const openPanel = (user: ReturnType<typeof userEvent.setup>, trigger: () => HTMLElement) => user.click(trigger());

describe('74d00fd2 · the count on the closed control', () => {
  it('an untouched field still reads the placeholder and posts nothing', () => {
    const { trigger, posted } = renderPicker();
    expect(trigger()).toHaveTextContent('Add…');
    expect(posted()).toEqual([]);
  });

  it('reads "{n} selected" at ANY count — including below the four-chip threshold', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    await openPanel(user, trigger);

    await user.click(screen.getByRole('checkbox', { name: 'Malaysian' }));
    expect(trigger(), 'one value must not still read like an empty field').toHaveTextContent('1 selected');

    await user.click(screen.getByRole('checkbox', { name: 'Thai' }));
    await user.click(screen.getByRole('checkbox', { name: 'Indian' }));
    // Three values is exactly the case the reporter named: it used to look identical to an empty field.
    expect(trigger()).toHaveTextContent('3 selected');
    expect(trigger()).not.toHaveTextContent('Add…');
  });

  it('reads "All selected" once every value is picked, and says it exactly once', async () => {
    const user = userEvent.setup();
    const { trigger, container, posted } = renderPicker();
    await openPanel(user, trigger);
    await user.click(screen.getByRole('button', { name: 'Select all' }));

    expect(trigger()).toHaveTextContent('All selected');
    expect(posted()).toHaveLength(NATIONALITIES.length);
    // The below-control summary line is suppressed while the trigger owns the summary.
    expect(container.textContent?.match(/All selected/g) ?? []).toHaveLength(1);
  });

  it('keeps the removable chips up to four, and stops printing them past it', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker();
    await openPanel(user, trigger);

    for (const name of ['Malaysian', 'Singaporean', 'Thai', 'Indian']) {
      await user.click(screen.getByRole('checkbox', { name }));
    }
    // Four picked: the chips and their per-value remove buttons are exactly as they were.
    expect(screen.getByRole('button', { name: 'Remove Malaysian' })).toBeInTheDocument();
    expect(trigger()).toHaveTextContent('4 selected');

    await user.click(screen.getByRole('checkbox', { name: 'Vietnamese' }));
    // Five: the count is already on the control, so no chip strip and no duplicated count line.
    expect(screen.queryByRole('button', { name: 'Remove Malaysian' })).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent('5 selected');
  });

  it('a SHORT field that happens to be fully picked keeps its remove buttons', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPicker([
      { value: 'male', label: 'Male' },
      { value: 'female', label: 'Female' },
    ]);
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Select all' }));

    expect(trigger()).toHaveTextContent('All selected');
    // Without the suppression this collapsed to an "All selected" line and lost per-value removal.
    expect(screen.getByRole('button', { name: 'Remove Male' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Female' })).toBeInTheDocument();
  });
});

describe('74d00fd2 · Select all / Deselect all act on what the search box is showing', () => {
  it('Deselect all with a filter typed clears ONLY the visible values — the plan’s "ind" example', async () => {
    const user = userEvent.setup();
    const { trigger, posted } = renderPicker();
    await openPanel(user, trigger);
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(posted()).toHaveLength(7);

    await user.type(screen.getByRole('searchbox', { name: 'Search…' }), 'ind');
    // "ind" shows Indonesian and Indian; the other five are hidden.
    expect(screen.getByRole('checkbox', { name: 'Indonesian' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Thai' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    // THE REGRESSION THIS FILE EXISTS FOR: the five the filter was hiding must still be posted.
    expect(posted().sort()).toEqual(['my', 'ph', 'sg', 'th', 'vn']);
    expect(posted()).not.toContain('id');
    expect(posted()).not.toContain('in');
  });

  it('Deselect all with NO filter still clears the whole field (every other caller is unaffected)', async () => {
    const user = userEvent.setup();
    const { trigger, posted } = renderPicker();
    await openPanel(user, trigger);
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(posted()).toHaveLength(7);

    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(posted()).toEqual([]);
    expect(trigger()).toHaveTextContent('Add…');
  });

  it('Select all with a filter typed adds only the visible values to what is already picked', async () => {
    const user = userEvent.setup();
    const { trigger, posted } = renderPicker();
    await openPanel(user, trigger);
    await user.click(screen.getByRole('checkbox', { name: 'Thai' }));

    await user.type(screen.getByRole('searchbox', { name: 'Search…' }), 'ind');
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    // Not the whole catalogue — Thai plus the two the filter is showing.
    expect(posted().sort()).toEqual(['id', 'in', 'th']);
  });
});

describe('74d00fd2 · what was already true stays true', () => {
  it('individual values still toggle one at a time, in both directions', async () => {
    const user = userEvent.setup();
    const { trigger, posted } = renderPicker();
    await openPanel(user, trigger);

    await user.click(screen.getByRole('checkbox', { name: 'Malaysian' }));
    await user.click(screen.getByRole('checkbox', { name: 'Thai' }));
    expect(posted()).toEqual(['my', 'th']);
    expect(screen.getByRole('checkbox', { name: 'Malaysian' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('checkbox', { name: 'Malaysian' }));
    expect(posted()).toEqual(['th']);
    expect(screen.getByRole('checkbox', { name: 'Malaysian' })).toHaveAttribute('aria-checked', 'false');
  });

  it('the selection survives closing and reopening the list, and the filter does not', async () => {
    const user = userEvent.setup();
    const { trigger, posted, container } = renderPicker();
    await openPanel(user, trigger);
    await user.click(screen.getByRole('checkbox', { name: 'Malaysian' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search…' }), 'ind');

    await user.click(trigger());
    // Closed: the hidden inputs live outside the open guard, so the posted values are still there.
    expect(posted()).toEqual(['my']);
    expect(container.querySelector('input[name="nationalities"][type="hidden"]')).toBeInTheDocument();

    await user.click(trigger());
    // Reopened: ticks intact, filter cleared — a filter is a way of looking, not part of the selection.
    expect(screen.getByRole('checkbox', { name: 'Malaysian' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search…' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Thai' })).toBeInTheDocument();
  });

  it('a stored value the catalogue no longer offers survives a reopen — the reason withStored exists', async () => {
    const user = userEvent.setup();
    // WITHOUT the union, this is what a deactivated nationality looks like on an existing rule: the control
    // drops any defaultSelected value absent from options, so a plain Save would silently WIDEN the rule.
    const { posted: bare } = renderPicker(NATIONALITIES, ['my', 'retired-code']);
    expect(bare(), 'the control drops values it was not offered — this is the defect').toEqual(['my']);
    cleanup();

    // WITH it — what EligibilityRuleForm now hands the control: the active options plus the stored value,
    // labelled with its raw string, still ticked and still removable.
    const { posted, trigger } = renderPicker(
      [...NATIONALITIES, { value: 'retired-code', label: 'retired-code' }],
      ['my', 'retired-code'],
    );
    expect(posted()).toEqual(['my', 'retired-code']);
    expect(trigger()).toHaveTextContent('2 selected');
    await user.click(screen.getByRole('button', { name: 'Remove retired-code' }));
    expect(posted()).toEqual(['my']);
  });
});

/**
 * THE RENDER CHECK FOR A CLIENT ISLAND. `EligibilityRuleForm` is mounted behind LeaveTypePanel's
 * Entitlement step, which is client-side `activeStep` state seeded from localStorage — so a plain GET of
 * /admin/leave/entitlements never SSRs it, and the dev-server log is silent about it however many locales
 * are curled. (Verified: the page returns 200 in all six and the form's markup is simply not in the HTML.)
 * A missing or unformattable key here would therefore surface only in a browser console.
 *
 * So the six real catalogues are loaded and the form is rendered against each, merged over English exactly
 * the way i18n/request.ts merges them. `onError` is wired to a collector: next-intl reports MISSING_MESSAGE
 * and FORMATTING_ERROR through it rather than throwing, which is precisely why a broken key can hide behind
 * a 200. Anything arriving there fails this test.
 *
 * `triggerSummaryFor` matters here beyond the others: it is a CLOSURE, so its two t() lookups do not run at
 * render time like the other props' do — they run only once something is selected. The test selects.
 */
type Dict = Record<string, unknown>;
const CATALOGUES: Record<string, Dict> = {
  en: enMessages as Dict,
  ms: msMessages as Dict,
  zh: zhMessages as Dict,
  ta: taMessages as Dict,
  th: thMessages as Dict,
  vi: viMessages as Dict,
};

/** i18n/request.ts's deep merge over the English base, so a locale is exercised exactly as it ships. */
function withFallback(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = withFallback(b as Dict, v as Dict);
    } else if (v != null && v !== '') out[k] = v;
  }
  return out;
}

/** One multi field and one range field — both branches of the section renderer. */
const SECTIONS: CriteriaSection[] = [
  {
    key: 'employee',
    title: 'Employee Information',
    fields: [
      { name: 'nationalities', label: 'Nationality', kind: 'multi', options: NATIONALITIES },
      { name: 'hiredFrom', label: 'Hired on or after', kind: 'date' },
    ],
    note: 'Job title, employee group and employee class are not held in this system.',
  },
];

describe('74d00fd2 · the eligibility form renders in all six catalogues without an IntlError', () => {
  for (const loc of ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const) {
    it(`${loc}: every key the form asks for resolves and formats`, async () => {
      const user = userEvent.setup();
      const errors: string[] = [];
      const messages = loc === 'en' ? CATALOGUES.en : withFallback(CATALOGUES.en, CATALOGUES[loc]);

      render(
        <NextIntlClientProvider locale={loc} messages={messages} onError={(e) => errors.push(String(e))}>
          <EligibilityRuleForm
            action={async () => {}}
            countAction={async () => 0}
            templates={[{ value: 't1', label: 'Standard annual leave' }]}
            criteriaSections={SECTIONS}
            today="2026-08-11"
            submitLabel="Create"
          />
        </NextIntlClientProvider>,
      );

      // searchPlaceholder / selectAllLabel / clearAllLabel are evaluated eagerly as props at render, so
      // opening one picker has already exercised three of the four new keys in this locale.
      const et = (messages.admin as Dict).entitlementTemplates as Record<string, string>;
      await user.click(screen.getByRole('button', { name: 'Nationality' }));
      expect(screen.getByRole('searchbox', { name: et.chipSearchPlaceholder })).toBeInTheDocument();

      // The fourth is inside triggerSummaryFor, which only runs once something is picked. Both of its
      // branches are walked: every value (chipAllSelected), then one fewer (chipCountLabel, with {count}).
      await user.click(screen.getByRole('button', { name: et.chipSelectAll }));
      expect(screen.getByRole('button', { name: 'Nationality' })).toHaveTextContent(et.chipAllSelected);
      await user.click(screen.getByRole('checkbox', { name: 'Malaysian' }));
      expect(screen.getByRole('button', { name: 'Nationality' })).not.toHaveTextContent(et.chipAllSelected);

      // Deselect all, still with no filter typed, must empty the field on every locale's copy too.
      await user.click(screen.getByRole('button', { name: et.chipDeselectAll }));
      expect(screen.getByRole('button', { name: 'Nationality' })).toHaveTextContent(et.chipAddPlaceholder);

      // MISSING_MESSAGE and FORMATTING_ERROR arrive here rather than throwing — which is exactly how a
      // broken key hides behind a 200 in production.
      expect(errors, `[${loc}] next-intl reported: ${errors.join(' | ')}`).toEqual([]);
      cleanup();
    });
  }
});
