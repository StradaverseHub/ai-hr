/**
 * Item 15e5bd93 REVISION 3 (r355) — ONE STATUTORY BODY'S SCREEN, RENDERED FOR REAL, IN ALL SIX LOCALES.
 *
 * ⚠️ THIS FILE IS WHERE r353's RENDER CLAIMS WENT, AND NONE OF THEM WAS DROPPED. r353 put the eight body
 * editors on the setup screen as cards and its render guard
 * (test/statutory-setup-screen-render.test.ts) checked them there. The reporter contested that shape and
 * drew the layout themselves: the list is a table of rows, and "Selecting Edit → EPF opens a screen
 * containing ONLY the EPF fields, with Cancel / Save." So the editor is
 * components/statutory-body-screen.tsx and every claim that was about a CARD is here, about a SCREEN:
 *
 *   · all thirteen posted field names are present in edit mode;
 *   · filing numbers appear on epf / socso / lhdn and nowhere else;
 *   · the HRD Corp band is stated only when the identity row carries one;
 *   · the company's own debit account is NOT masked;
 *   · a departed signatory is still POSTED rather than silently cleared;
 *   · EIS says in words that it files under SOCSO's code rather than showing an empty box.
 *
 * A 200 IS NOT A RENDER CHECK (CLAUDE.md §8). `MISSING_MESSAGE` and `FORMATTING_ERROR` pass tsc, the suite
 * and `next build`, and surface only as text on a page somebody has to look at. This file renders the
 * component through the REAL `NextIntlClientProvider` with each locale's actual JSON and fails on ANY
 * IntlError — in BOTH modes, because a caption that only the edit form carries would otherwise never be
 * rendered by any six-locale check at all.
 *
 * ⚠️ `.test.ts`, NOT `.test.tsx`, AND THAT IS NOT A STYLE CHOICE. vitest.config.ts runs `test/**\/*.test.ts`
 * in the node project and `test/**\/*.dom.test.tsx` in the dom one. A `*.test.tsx` that is not `*.dom.`
 * matches NEITHER pattern and is silently skipped — a file full of green-looking assertions that never run,
 * which r353 nearly shipped. Hence `createElement` rather than JSX.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { StatutoryBodyScreen } from '../components/statutory-body-screen';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { MY_FILING_FIELD } from '../lib/statutory-authority-display';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesFor = (l: string) => JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${l}.json`), 'utf8'));

const noop = () => undefined;

const IDENTITY = {
  epfEmployerNo: 'E123',
  socsoEmployerCode: 'S123',
  lhdnEmployerNo: 'L123',
  myinvoisTin: 'C12345678900',
  ssmRegistrationNo: '202301001234',
  hrdfStatus: 'mandatory' as const,
};

const EPF_ROW = {
  id: 'a1',
  authority: 'epf',
  accountNo: 'ACC-1',
  bankProfileId: 'bp1',
  addressLine1: 'Jalan Satu',
  addressLine2: null,
  addressLine3: null,
  city: 'KL',
  state: 'Selangor',
  postcode: '50000',
  country: 'Malaysia',
  phone: '+60312345678',
  email: 'epf@example.test',
  // NOT among the candidates below: the legacy-tolerance case.
  signatoryPersonId: 'gone-person',
};

const BANK = {
  id: 'bp1',
  bank: 'maybank',
  corporateId: 'CORP1',
  debitAccountNo: '512345678901',
  orgName: 'Demo Sdn Bhd',
  txnType: 'IBG',
  accountLabel: 'Payroll — Maybank',
  accountName: 'DEMO SDN BHD',
  accountType: 'current',
  branch: 'KLCC',
  swiftCode: 'MBBEMYKL',
  currency: 'MYR',
  isPrimary: true,
};

const base = {
  companyId: 'c1',
  filingCountry: 'MY',
  statutory: IDENTITY,
  bankProfiles: [BANK],
  signatories: [{ personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' }],
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
  actions: { setStatutoryAuthority: noop, removeStatutoryAuthority: noop },
};

const propsFor = (mode: 'view' | 'edit', authority: string, over: Record<string, unknown> = {}) => ({
  ...base,
  mode,
  authority,
  row: authority === 'epf' ? EPF_ROW : null,
  ...over,
});

let errors: string[] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function render(locale: string, props: unknown): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messagesFor(locale),
      // Without an explicit zone next-intl logs ENVIRONMENT_FALLBACK, which this file treats as a failure.
      timeZone: 'Asia/Kuala_Lumpur',
      children: createElement(StatutoryBodyScreen, props as never),
    }),
  );
}

const inMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const dds = (html: string) => [...html.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => m[1]);

describe('15e5bd93 rev 3 render check — ONE body’s screen, both modes, all six locales', () => {
  /**
   * ⚠️ EVERY BODY × EVERY MODE × EVERY LOCALE. 8 × 2 × 6 renders, and the reason it is exhaustive rather
   * than a sample is that three of the eight bodies take a DIFFERENT first group (a filing number, HRD
   * Corp's band, EIS's sentence) and the rest take none at all — so a missing caption could hide on any one
   * of them. Both modes, because half the captions exist only on the form.
   */
  for (const locale of LOCALES) {
    for (const mode of ['view', 'edit'] as const) {
      it(`${locale} · ${mode} · every body renders with no IntlError`, () => {
        for (const a of STATUTORY_AUTHORITIES) {
          const html = render(locale, propsFor(mode, a));
          expect(html, `${a}: MISSING_MESSAGE`).not.toContain('MISSING_MESSAGE');
          expect(html, `${a}: FORMATTING_ERROR`).not.toContain('FORMATTING_ERROR');
          // Exactly one body on screen — "Editing EPF shows EPF and nothing else".
          expect(
            [...html.matchAll(/data-statutory-card="([^"]+)"/g)].map((m) => m[1]),
            `${a}: one body only`,
          ).toEqual([a]);
        }
        expect(errors.join('\n'), 'next-intl logged an error').toBe('');
      });
    }
  }

  it('states the body’s name in every locale, from the same catalogue entry the list row uses', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      for (const a of STATUTORY_AUTHORITIES) {
        expect(render(locale, propsFor('view', a)), `${locale}: authority_${a}`).toContain(
          inMarkup(org[`authority_${a}`]),
        );
      }
    }
  });

  /**
   * ⚠️ VIEW IS READ-ONLY, AND "READ-ONLY" MEANS ABSENT. Not disabled and not hidden: a greyed-out input
   * reads to an operator as something they can fix where they are standing, and a hidden one would make the
   * mode a lie. The reporter's words: "View is the same screen, read-only, with no Save."
   */
  it('view mode renders text and no writer at all — no form, no input, no Save', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', propsFor('view', 'epf'));
    expect(html, 'no form in view mode').not.toContain('<form');
    expect(html, 'and no box').not.toContain('<input');
    expect(html, 'nor a select pretending to be read-only').not.toContain('<select');
    expect(html, 'and no Save').not.toContain(inMarkup(en.authoritySave));
    expect(html).toContain('data-statutory-mode="viewing"');
    // The way forward is a LINK into the same route's edit mode: a read-only page whose only exit is the
    // browser Back button is a screen you escape rather than use.
    expect(html).toContain('href="/admin/organization/c1/statutory/epf?mode=edit"');
    expect(html).toContain(inMarkup(en.authorityEdit));
  });

  /**
   * ── r226, ON THE RENDER: TWO DIFFERENT NUMBERS, TWO CAPTIONS ──────────────────────────────────────
   *
   * The reporter's original complaint was that a body had one number on its card and a different number for
   * the same body in a list above it, with nothing on screen saying they were different things. So the
   * values are asserted as an EXACT list: a substring check would pass on a screen whose summary rendered
   * empty, and a count would not notice the two numbers being collapsed into one.
   */
  it('a configured body states its filing number and its payment reference under separate captions', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', propsFor('view', 'epf'));
    expect(html, 'the EPF employer number, captioned').toContain(inMarkup(en.epfEmployerNo));
    expect(html, 'the payment reference, captioned differently').toContain(inMarkup(en.authorityAccountNo));
    expect(html, 'the account it is paid from').toContain(inMarkup(en.authorityBankAccount));
    expect(dds(html)).toEqual([
      'E123',
      'ACC-1',
      inMarkup('Payroll — Maybank · 512345678901'),
      // The departed signatory is NAMED as kept on record, never shown as "Not set" (which would say the
      // column is empty) and never as a bare person id.
      inMarkup(en.authoritySignatoryFormer),
      'Jalan Satu, KL, 50000, Selangor, Malaysia',
      '+60312345678',
      'epf@example.test',
    ]);
  });

  /**
   * ⚠️ CARRIED THROUGH TWO MOVES: THE COMPANY'S OWN DEBIT ACCOUNT IS NOT MASKED.
   *
   * 3c2f55d7 rev 2 unmasked it deliberately: this screen is admin-only (RLS), the number is the company's
   * OWN debit account, and an admin routing EPF to the right account needs to read the whole thing. The
   * masks on EMPLOYEE bank details elsewhere are a different decision and are asserted untouched in
   * test/company-panel-bank-statutory-layout.test.ts.
   */
  it('prints the paying account in full, in both modes, not truncated to four digits', () => {
    for (const mode of ['view', 'edit'] as const) {
      const html = render('en', propsFor(mode, 'epf'));
      expect(html, mode).toContain('512345678901');
      expect(html, `${mode}: no employee-facing mask leaked onto an admin screen`).not.toContain('••••');
    }
  });

  /**
   * A BODY WITH NOTHING ON FILE SAYS SO IN WORDS RATHER THAN SHOWING A BLANK. LHDN proves both halves at
   * once: it has no authority row, but the company DOES carry its filing number — so the number that exists
   * is shown and the facts that do not are NAMED as not set.
   */
  it('names what is not set instead of rendering an empty gap', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', propsFor('view', 'lhdn'));
    expect(dds(html)[0], 'the filing number the company does have').toBe('L123');
    expect(new Set(dds(html).slice(1)), 'and every absent fact says so').toEqual(
      new Set([en.authorityValueNotSet]),
    );
    expect(html).toContain(inMarkup(en.authorityNotConfigured));
    expect(render('en', propsFor('view', 'epf')), 'while a configured body says Configured').toContain(
      inMarkup(en.authorityConfigured),
    );
  });

  /**
   * FILING NUMBERS APPEAR ON epf / socso / lhdn AND NOWHERE ELSE — the exact set, read off the render, in
   * BOTH modes.
   *
   * EIS carries none because it has none: it files under SOCSO's PERKESO employer code, and inventing a
   * caption for it would say something untrue. HRD Corp carries a registration BAND instead of a number.
   * Everything else has no filing identity at all.
   */
  it('shows a filing number on exactly the three bodies that have one', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const withFiling = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a]);
    expect([...withFiling], 'the controlled set’s own answer').toEqual(['epf', 'socso', 'lhdn']);
    for (const mode of ['view', 'edit'] as const) {
      for (const a of STATUTORY_AUTHORITIES) {
        const html = render('en', propsFor(mode, a));
        const own = MY_FILING_FIELD[a];
        if (own) expect(html, `${mode} ${a} states its filing number`).toContain(inMarkup(en[own.labelKey]));
        // No body borrows another's caption — which is how one number would come to look like two.
        for (const other of withFiling.filter((x) => x !== a)) {
          expect(html, `${mode} ${a} must not show ${other}'s caption`).not.toContain(
            inMarkup(en[MY_FILING_FIELD[other].labelKey]),
          );
        }
      }
    }
    expect(render('en', propsFor('view', 'hrdf')), 'HRD Corp states a band, not a number').toContain(
      inMarkup(en.hrdfStatusLabel),
    );
  });

  /**
   * HRD CORP'S BAND IS THE ONE VALUE THAT COULD BE INVENTED, so it is pinned on both sides. Payroll resolves
   * a missing `company_statutory_my` row to 'not_registered' and charges nothing — but printing that band for
   * a company with no row at all would assert a registration decision nobody made (CLAUDE.md §8: an absent
   * box asserts nothing).
   */
  it('states HRD Corp’s band only when the identity row actually carries one', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    expect(dds(render('en', propsFor('view', 'hrdf')))[0]).toBe(inMarkup(en.hrdfMandatory));
    const bare = render('en', propsFor('view', 'hrdf', { statutory: null }));
    expect(dds(bare)[0], 'an absent identity row is never read as a band').toBe(en.authorityValueNotSet);
    for (const band of [en.hrdfNotRegistered, en.hrdfMandatory, en.hrdfOptional]) {
      expect(bare, `the screen must not claim ${band}`).not.toContain(inMarkup(band));
    }
  });

  /**
   * ALL THIRTEEN POSTED NAMES, ON THE RENDER, FOR EVERY BODY. A field that went missing in the move to a
   * route is the single most likely way this round loses a customer's setting, and it would pass every
   * behavioural test: the save succeeds, it just writes `null`.
   */
  it('mounts every posted field at once in edit mode, for every body', () => {
    for (const a of STATUTORY_AUTHORITIES) {
      const html = render('en', propsFor('edit', a));
      for (const n of ['companyId', 'authority', 'returnTo', 'accountNo', 'bankProfileId', 'addressLine1',
        'addressLine2', 'addressLine3', 'city', 'state', 'postcode', 'country', 'phone', 'email',
        'signatoryPersonId']) {
        expect(html, `${a}: name="${n}"`).toContain(`name="${n}"`);
      }
      expect(html, `${a}: the body it writes`).toContain(`name="authority" value="${a}"`);
      expect(html, `${a}: the return marker`).toContain('name="returnTo" value="statutory-setup"');
    }
  });

  /**
   * THE PACK FLAG IS `filingCountry` AND THE POSTAL FIELD IS `country`, ON ONE FORM. Both names at once with
   * different values is the whole condition the r352 rename exists for: without it, `syncCarriedValues`
   * overwrote the hidden flag with "Malaysia" and every identity save died with "No statutory pack for
   * Malaysia". The flag appears only where the body HAS something to write towards the identity row.
   */
  it('emits the pack flag only on the four bodies with a filing control, beside a visible postal country', () => {
    const withFlag = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a] || a === 'hrdf');
    expect([...withFlag]).toEqual(['epf', 'socso', 'lhdn', 'hrdf']);
    for (const a of STATUTORY_AUTHORITIES) {
      const html = render('en', propsFor('edit', a));
      const expected = withFlag.includes(a);
      expect(html.includes('name="filingCountry" value="MY"'), `${a}: pack flag`).toBe(expected);
      // The postal country is on EVERY body's form, as a visible select, which is the collision condition.
      expect(html, `${a}: postal country`).toContain('name="country"');
    }
  });

  /** EIS says out loud that it files under SOCSO's code, rather than showing an empty box. */
  it('gives EIS a sentence where its filing number would be, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, propsFor('edit', 'eis'));
      expect(html, `${locale}: authorityEisSharesSocso`).toContain(inMarkup(org.authorityEisSharesSocso));
      expect(html, `${locale}: no second control over one column`).not.toContain('name="socsoEmployerCode"');
    }
  });

  /**
   * CANCEL AND SAVE, AND CANCEL IS A LINK. r353's Cancel was an onClick that unmounted the form; there is no
   * client state to reset here, so leaving the route IS the discard — and a `<button>` where Cancel sits
   * would SUBMIT the form it is inside, which is a Cancel that saves.
   */
  it('gives edit mode a Save submit and a Cancel LINK back to the list, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, propsFor('edit', 'epf'));
      expect(html, `${locale}: Save`).toContain(inMarkup(org.authoritySave));
      expect(html, `${locale}: Cancel`).toContain(inMarkup(org.authorityCancel));
      // Attribute ORDER is React's to choose, so the anchor is located by its marker and then read for
      // its href — never by a regex that pins the two in one sequence.
      const cancel = html.match(/<a[^>]*data-statutory-cancel-link[^>]*>/)?.[0] ?? '';
      expect(cancel, `${locale}: Cancel is an anchor`).toBeTruthy();
      expect(cancel, `${locale}: Cancel goes back to the list`).toContain(
        'href="/admin/organization/c1/statutory"',
      );
      expect(html, `${locale}: the edit caption`).toContain(inMarkup(org.statutoryBodyEditCaption));
      expect(render(locale, propsFor('view', 'epf')), `${locale}: the view caption`).toContain(
        inMarkup(org.statutoryBodyViewCaption),
      );
    }
  });

  /**
   * "Clear this authority" DELETES the row — bucket (b) of the 65b22c00 audit. It appears only in edit mode
   * and only where a row exists, and it carries `authority` so a REFUSED clear can be returned to this
   * screen (the delete itself is keyed off the row id).
   */
  it('offers Clear only in edit mode and only on a body that has a record', () => {
    expect(render('en', propsFor('edit', 'epf')), 'EPF has a row').toContain('data-statutory-clear="epf"');
    expect(render('en', propsFor('view', 'epf')), 'but not in view mode').not.toContain('data-statutory-clear');
    expect(render('en', propsFor('edit', 'ptptn')), 'and not where there is no row').not.toContain(
      'data-statutory-clear',
    );
  });

  /**
   * ⚠️ RETIRED, NOT DELETED, AND NOT RENDERED. `statutoryScreenEditingHint` and `authorityEditing` explained
   * r353's one-card-at-a-time lock. There is one body per route now, so there is nothing to lock. The
   * catalogue entries stay (test/company-panel-bank-statutory-layout.test.ts asserts their presence, the way
   * `authorityClose` has been asserted since r352); neither may appear on screen.
   */
  it('renders neither the retired editing badge nor the retired lock hint', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      for (const mode of ['view', 'edit'] as const) {
        const html = render(locale, propsFor(mode, 'epf'));
        expect(html, `${locale} ${mode}: authorityEditing`).not.toContain(inMarkup(org.authorityEditing));
        expect(html, `${locale} ${mode}: statutoryScreenEditingHint`).not.toContain(
          inMarkup(org.statutoryScreenEditingHint),
        );
      }
    }
  });
});
