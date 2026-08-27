/**
 * r224 — THE SAVE BUTTON, THE NOTE AND THE DATE BOX, RENDERED, IN ALL SIX LOCALES.
 *
 * ⚠️ WHY THIS FILE IS A RENDER TEST AND NOT AN ASSERTION ABOUT messages/en.json.
 *
 * The defect r224 fixes was invisible to every static check in this repository. Both editors pre-filled
 * the Effective from box with TODAY when opening a version already in force; `entitlementEditMode` returns
 * 'in-place' only when `newValidFrom === openValidFrom`, so an operator who changed a day figure and
 * pressed Save superseded the version without ever touching a date. The screen even said so — the button
 * read "Save as a new version" — and it was RIGHT, which is why nobody read it as a fault. tsc was happy,
 * `next build` was happy, and test/r219-entitlement-effective-date.test.ts proved end to end that in-place
 * saving worked, against a service the screen could not ask for it. AGENTS rule 6, in its purest form: the
 * only thing that can see this is something that renders the form and reads the date box.
 *
 * WHAT IS PINNED HERE:
 *
 *  §A THE PRE-FILL — the box opens on the version's OWN start date, for a version already in force. This
 *    is the whole fix; everything else in r224 exists because this line changes what an unchanged Save
 *    does.
 *
 *  §B THE LABEL AND THE NOTE FOLLOW THE BOX. Typing a later date turns the button into "save as a new
 *    version"; typing an earlier one says the service will refuse. Asserted by CHANGING the input and
 *    re-reading the button, because the point is that the label tracks the field rather than the render.
 *
 *  §C ALL SIX LOCALES, and the three modes must render three DIFFERENT strings in each. A missing key
 *    paints `MISSING_MESSAGE`/the key path and still returns 200 — and a locale that resolved all three
 *    to one string would be a screen that has stopped saying which write it is about to make.
 *
 *  §D THE ELIGIBILITY RULE FORM CARRIES THE SAME NOTE, which it has never had at all. Its label used to
 *    be computed on the server from `ruleNotStarted` and passed in; it is now resolved from the same
 *    function over its own date box, so the two editors cannot describe one write two ways.
 *
 * ⚠️ THE EXPECTED STRINGS FOR `en` ARE WRITTEN OUT, not read from the catalogue. Reading en.json here
 * would make this file assert `t(k) === messages[k]`, which is a test of next-intl. The other five
 * locales are asserted structurally (resolved, distinct, non-empty) because their wording is not this
 * file's business.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

import {
  EntitlementEffectiveFromField,
  EntitlementSaveModeNote,
  EntitlementSaveModeProvider,
  EntitlementSaveModeSubmit,
} from '../components/leave/entitlement-save-mode';
import { EligibilityRuleForm } from '../components/leave/eligibility-rule-form';
import { entitlementEditMode } from '../lib/entitlement-edit-mode';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

/** The clock every case is written against, as in the r219 file: the rule is a comparison with the
 *  calendar day, so a fixture dated relative to nothing changes meaning as the wall clock passes it. */
const TODAY = '2026-06-30';
/** A version that has been in force for months — the reporter's Annual Leave tables. */
const IN_FORCE = '2026-01-01';
/** …and one that has not started yet. */
const FUTURE = '2026-12-01';

/** next-intl paints the key path when a key does not resolve; either shape is an unresolved string. */
const looksUnresolved = (text: string) =>
  /MISSING_MESSAGE/.test(text) || /entitlementTemplates\./.test(text) || text.trim() === '';

function renderTemplateForm(locale: Locale, openValidFrom: string | null) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      <EntitlementSaveModeProvider openValidFrom={openValidFrom} today={TODAY}>
        <EntitlementEffectiveFromField />
        <EntitlementSaveModeNote />
        <EntitlementSaveModeSubmit createLabel="CREATE-LABEL" />
      </EntitlementSaveModeProvider>
    </NextIntlClientProvider>,
  );
  const input = view.container.querySelector('input[name="validFrom"]') as HTMLInputElement;
  return {
    ...view,
    input,
    button: () => screen.getByRole('button'),
    /** Every caption the form is currently showing, joined — note and warning both count as "what it says". */
    caption: () => [...view.container.querySelectorAll('p')].map((p) => p.textContent ?? '').join(' | '),
    type: (date: string) => fireEvent.change(input, { target: { value: date } }),
  };
}

// ── §A the pre-fill, which is the fix ────────────────────────────────────────────────────────────────

describe('§A r224 · the Effective from box opens on the version being edited, not on today', () => {
  it('a version IN FORCE opens on its own start date — the defect, in one assertion', () => {
    const f = renderTemplateForm('en', IN_FORCE);
    expect(f.input.value).toBe(IN_FORCE);
    // …and therefore an untouched Save is an in-place update, which is what the operator expects and
    // what the service has always been able to do.
    expect(entitlementEditMode({ openValidFrom: IN_FORCE, newValidFrom: f.input.value, today: TODAY })).toBe(
      'in-place',
    );
  });

  it('a version that has NOT started opens on its own date too', () => {
    const f = renderTemplateForm('en', FUTURE);
    expect(f.input.value).toBe(FUTURE);
  });

  it('the CREATE form opens on today — there is no running version to inherit a date from', () => {
    const f = renderTemplateForm('en', null);
    expect(f.input.value).toBe(TODAY);
    expect(f.button()).toHaveTextContent('CREATE-LABEL');
    // Nothing is promised about closing a version that does not exist.
    expect(f.caption()).toBe('');
  });
});

// ── §B the label and the note follow the box ─────────────────────────────────────────────────────────

describe('§B r224 · the button says which write it is about to make', () => {
  it('unchanged date on an in-force version ⇒ Save changes, and the past-changing warning is shown', () => {
    const f = renderTemplateForm('en', IN_FORCE);
    expect(f.button()).toHaveTextContent('Save changes');
    // The note is the in-place one, and the warning names the date the version has been in force from.
    expect(f.caption()).toMatch(/date has not changed/i);
    expect(f.caption()).toMatch(/closed leave years/i);
    expect(f.caption()).toContain(IN_FORCE);
  });

  it('a LATER date turns the same form into a supersede, live', () => {
    const f = renderTemplateForm('en', IN_FORCE);
    f.type('2027-01-01');
    expect(f.button()).toHaveTextContent('Save as a new version');
    expect(f.caption()).toMatch(/already in force/i);
    // The warning belongs to the in-place save only — nothing that has been resolved moves here.
    expect(f.caption()).not.toMatch(/closed leave years/i);
  });

  it('an EARLIER date says the service will refuse it, before the operator presses anything', () => {
    const f = renderTemplateForm('en', IN_FORCE);
    f.type('2025-06-01');
    expect(f.button()).toHaveTextContent(/refused/i);
    expect(f.caption()).toMatch(/cannot be moved earlier/i);
    // The screen and the service agree about which arm this is.
    expect(entitlementEditMode({ openValidFrom: IN_FORCE, newValidFrom: '2025-06-01', today: TODAY })).toBe(
      'refuse',
    );
  });

  it('a version that has not started is edited in place whichever way the date moves, and is NOT warned about', () => {
    const f = renderTemplateForm('en', FUTURE);
    expect(f.button()).toHaveTextContent('Save changes');
    expect(f.caption()).toMatch(/has not started yet/i);
    expect(f.caption()).not.toMatch(/closed leave years/i);
    // Pulled back to a date in the past: still the same version, still in place (r219 §A).
    f.type('2026-02-01');
    expect(f.button()).toHaveTextContent('Save changes');
    expect(f.caption()).not.toMatch(/closed leave years/i);
  });

  it('an EMPTY box is read as "the date has not changed", not as an earlier date', () => {
    // A `type=date` input is momentarily empty while it is being retyped. Reading that as a date move
    // would flap the button through "will be refused" between keystrokes.
    const f = renderTemplateForm('en', IN_FORCE);
    f.type('');
    expect(f.button()).toHaveTextContent('Save changes');
  });
});

// ── §C every locale, three distinct strings ──────────────────────────────────────────────────────────

describe('§C r224 · all six locales resolve, and the three modes stay distinguishable', () => {
  for (const locale of LOCALES) {
    it(`[${locale}] in-place / supersede / refuse render three different labels and captions`, () => {
      const seenLabels: string[] = [];
      const seenCaptions: string[] = [];
      for (const date of [IN_FORCE, '2027-01-01', '2025-06-01']) {
        const f = renderTemplateForm(locale, IN_FORCE);
        f.type(date);
        const label = f.button().textContent ?? '';
        const caption = f.caption();
        expect(looksUnresolved(label), `${locale} label for ${date}: ${label}`).toBe(false);
        expect(looksUnresolved(caption), `${locale} caption for ${date}: ${caption}`).toBe(false);
        seenLabels.push(label);
        seenCaptions.push(caption);
        f.unmount();
      }
      expect(new Set(seenLabels).size, `${locale} labels: ${seenLabels.join(' / ')}`).toBe(3);
      expect(new Set(seenCaptions).size, `${locale} captions`).toBe(3);
    });

    it(`[${locale}] the past-changing warning resolves and names the start date`, () => {
      const f = renderTemplateForm(locale, IN_FORCE);
      expect(f.caption()).toContain(IN_FORCE);
      expect(looksUnresolved(f.caption())).toBe(false);
    });
  }
});

// ── §D the eligibility rule editor, which had no note at all ─────────────────────────────────────────

describe('§D r224 · the eligibility rule form carries the same derivation', () => {
  const renderRuleForm = (openValidFrom: string | null) => {
    const view = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <EligibilityRuleForm
          action={async () => {}}
          countAction={async () => 0}
          templates={[{ value: 'tpl-1', label: 'Executive' }]}
          criteriaSections={[]}
          gradeGroups={[]}
          today={TODAY}
          submitLabel="CREATE-RULE"
          openValidFrom={openValidFrom}
          initial={
            openValidFrom
              ? {
                  lineageId: 'rule-1',
                  name: 'Contract staff',
                  templateLineageId: 'tpl-1',
                  validFrom: openValidFrom,
                  criteria: {},
                }
              : undefined
          }
        />
      </NextIntlClientProvider>,
    );
    const input = view.container.querySelector('input[name="validFrom"]') as HTMLInputElement;
    return {
      ...view,
      input,
      submit: () => view.container.querySelector('button[type="submit"]') as HTMLButtonElement,
      text: () => view.container.textContent ?? '',
      type: (date: string) => fireEvent.change(input, { target: { value: date } }),
    };
  };

  it('an in-force rule opens on its own date and its Save says "Save changes"', () => {
    const f = renderRuleForm(IN_FORCE);
    expect(f.input.value).toBe(IN_FORCE);
    expect(f.submit().textContent).toBe('Save changes');
    // The note this editor has never carried, and the warning that goes with overwriting a rule that has
    // been deciding who resolved to a table.
    expect(f.text()).toMatch(/date has not changed/i);
    expect(f.text()).toMatch(/closed leave years/i);
  });

  it('…and a later date makes it a new version, live', () => {
    const f = renderRuleForm(IN_FORCE);
    f.type('2027-01-01');
    expect(f.submit().textContent).toBe('Save as a new version');
  });

  it('the CREATE form keeps the caller\'s own label and says nothing about versions', () => {
    const f = renderRuleForm(null);
    expect(f.input.value).toBe(TODAY);
    expect(f.submit().textContent).toBe('CREATE-RULE');
    expect(f.text()).not.toMatch(/date has not changed/i);
  });
});
