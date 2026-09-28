/**
 * Item 15e5bd93 REVISION 2 (r353) — THE DEDICATED STATUTORY SETUP SCREEN, RENDERED FOR REAL, IN ALL SIX
 * LOCALES.
 *
 * ⚠️ THE SIBLING test/company-panel-no-disclosure-render.test.ts ASKED FOR, and it exists for the reason
 * that file states: A 200 IS NOT A RENDER CHECK. `MISSING_MESSAGE` and `FORMATTING_ERROR` pass tsc, the
 * suite and `next build`, and surface only as text on a page somebody has to look at. Every OTHER test on
 * this screen either mocks next-intl (rendering the KEY, so a locale that lost one still passes) or drives
 * one locale through jsdom. This file renders the component through the REAL `NextIntlClientProvider` with
 * each locale's actual JSON and fails on ANY IntlError.
 *
 * It matters more here than on the panel, not less, because this screen introduced SEVEN new catalogue
 * strings in six languages plus one ICU argument (`authoritySavedToast`'s `{body}`), and because the eight
 * body labels and descriptions are DYNAMIC keys (`authority_epf`, `authorityDesc_epf`, …) that
 * test/i18n-coverage.test.ts cannot see at all.
 *
 * ⚠️ `.test.ts`, NOT `.test.tsx`, AND THAT IS NOT A STYLE CHOICE. vitest.config.ts runs `test/**\/*.test.ts`
 * in the node project and `test/**\/*.dom.test.tsx` in the dom one. A `*.test.tsx` that is not `*.dom.` matches
 * NEITHER pattern and is silently skipped — a file full of green-looking assertions that never run. Hence
 * `createElement` rather than JSX here, exactly as the sibling panel render guard does it.
 *
 * It also carries the behavioural half of what MOVED here from the panel — every claim r352 made about the
 * workspace pane that is still true of a card:
 *   · all thirteen posted field names are present when a card is open;
 *   · filing numbers appear on epf / socso / lhdn and nowhere else;
 *   · the HRD Corp band is stated only when the identity row carries one;
 *   · EIS is subordinate to SOCSO and still its own record;
 *   · the company's own debit account is NOT masked;
 *   · a departed signatory is still POSTED rather than silently cleared.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { MY_FILING_FIELD } from '../lib/statutory-authority-display';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesFor = (l: string) => JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${l}.json`), 'utf8'));

const noop = () => undefined;

/** A fully-populated MY company: a configured body, a bank account, a state catalogue, a departed signatory. */
const richProps = {
  companyId: 'c1',
  filingCountry: 'MY',
  statutory: {
    epfEmployerNo: 'E123',
    socsoEmployerCode: 'S123',
    lhdnEmployerNo: 'L123',
    myinvoisTin: 'C12345678900',
    ssmRegistrationNo: '202301001234',
    hrdfStatus: 'mandatory' as const,
  },
  statutoryAuthorities: [
    {
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
    },
  ],
  bankProfiles: [
    {
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
    },
  ],
  signatories: [{ personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' }],
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
  actions: { setStatutoryAuthority: noop, removeStatutoryAuthority: noop },
};

/** The other side of every branch: nothing configured at all, and no bank account to pay from. */
const sparseProps = {
  ...richProps,
  statutory: null,
  statutoryAuthorities: [],
  bankProfiles: [],
  signatories: [],
  stateOptions: [],
};

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
      // Without an explicit zone next-intl logs ENVIRONMENT_FALLBACK, which this file treats as a failure:
      // the whole point is that it fails on ANY IntlError, not only on a missing message.
      timeZone: 'Asia/Kuala_Lumpur',
      children: createElement(StatutorySetupScreen, props as never),
    }),
  );
}

/**
 * THE CATALOGUE STRING AS IT APPEARS IN MARKUP. `authority_socso` is "SOCSO & EIS (PERKESO)" and React
 * escapes a text child, so the markup carries "SOCSO &amp; EIS (PERKESO)". Escaping the EXPECTED side rather
 * than unescaping the received one keeps the assertion exact: this precise label has to have reached the
 * markup, and a label that is genuinely absent still fails. (The sibling file learned this the hard way in
 * r327 — see its copy of this note.)
 */
const inMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** One body's card, by the attribute that says what the element IS rather than by a class string. */
function cards(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /<section[^>]*\sdata-statutory-card="([^"]+)"[\s\S]*?<\/section>/g;
  for (const m of html.matchAll(rx)) out[m[1]] = m[0];
  return out;
}
/** The view-mode values a card states, read out of its <dd>s. */
const cardValues = (card: string) => [...card.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => m[1]);

describe('15e5bd93 rev 2 render check — the setup screen in all six locales, real catalogues', () => {
  for (const locale of LOCALES) {
    for (const [label, props] of [
      ['fully configured MY company', richProps],
      ['nothing configured, no bank account', sparseProps],
    ] as const) {
      it(`${locale} · ${label}`, () => {
        const html = render(locale, props);
        expect(html, 'MISSING_MESSAGE in rendered output').not.toContain('MISSING_MESSAGE');
        expect(html, 'FORMATTING_ERROR in rendered output').not.toContain('FORMATTING_ERROR');
        expect(errors.join('\n'), 'next-intl logged an error').toBe('');
        // Every body is drawn, in the controlled set's order, on both shapes and in every locale.
        expect(Object.keys(cards(html))).toEqual([...STATUTORY_AUTHORITIES]);
        // No disclosure came with the move: this screen has view/edit modes, not folds.
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
      });
    }
  }

  /**
   * EVERY BODY'S LABEL AND DESCRIPTION, IN EVERY LOCALE. Both are computed at render time
   * (`` t(`authority_${a}`) ``), so test/i18n-coverage.test.ts cannot see either: adding an authority means
   * adding BOTH strings to SIX files or the card renders MISSING_MESSAGE behind a 200, a green suite and a
   * clean build. The source guard checks the keys EXIST; this checks they reach the screen.
   */
  it('states every body’s name and purpose, on its own card, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const byBody = cards(render(locale, richProps));
      for (const a of STATUTORY_AUTHORITIES) {
        expect(byBody[a], `${locale}: authority_${a}`).toContain(inMarkup(org[`authority_${a}`]));
        expect(byBody[a], `${locale}: authorityDesc_${a}`).toContain(inMarkup(org[`authorityDesc_${a}`]));
      }
    }
  });

  /**
   * ⚠️ APPROVED POINT 3, ON THE RENDER: EVERY CARD STARTS READ-ONLY. A source guard can see the ternary and
   * still miss a card that renders a form anyway, or one whose read-only face renders nothing at all.
   *
   * "READ-ONLY" here means ABSENT, not disabled and not hidden — see the note on Cancel in
   * components/statutory-setup-screen.tsx. A disabled input would read to an operator as something they can
   * fix where they are standing, and a hidden one would make Cancel a lie.
   */
  it('opens entirely read-only: eight cards, no form, no input, and an Edit on each', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    expect(html, 'no card is in edit mode on arrival').not.toContain('<form');
    expect(html, 'and no field at all').not.toContain('<input');
    expect(html, 'nor a select pretending to be read-only').not.toContain('<select');
    expect((html.match(/data-statutory-mode="viewing"/g) ?? []).length).toBe(STATUTORY_AUTHORITIES.length);
    expect((html.match(/data-statutory-mode="editing"/g) ?? []).length).toBe(0);
    expect((html.match(new RegExp(`>${en.authorityEdit}<`, 'g')) ?? []).length, 'one Edit per card').toBe(
      STATUTORY_AUTHORITIES.length,
    );
    // The one-card-at-a-time hint is NOT shown before anything is open: it would be advice about nothing.
    expect(html).not.toContain('data-statutory-editing-hint');
    expect(html).not.toContain(inMarkup(en.statutoryScreenEditingHint));
  });

  /**
   * ── r226, ON THE RENDER: TWO DIFFERENT NUMBERS, TWO CAPTIONS ──────────────────────────────────────
   *
   * The reporter's original complaint was that a body had one number on its card and a different number for
   * the same body in a list above it, with nothing on screen saying they were different things. So the
   * values are asserted as an EXACT list: a substring check would pass on a card whose summary rendered
   * empty, and a count would not notice the two numbers being collapsed into one.
   */
  it('a configured body states its filing number and its payment reference under separate captions', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const epf = cards(render('en', richProps)).epf;
    expect(epf, 'the EPF employer number, captioned').toContain(inMarkup(en.epfEmployerNo));
    expect(epf, 'the payment reference, captioned differently').toContain(inMarkup(en.authorityAccountNo));
    expect(epf, 'the account it is paid from').toContain(inMarkup(en.authorityBankAccount));
    expect(cardValues(epf)).toEqual([
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
   * ⚠️ MOVED FROM THE PANEL'S RENDER GUARD (r353): THE COMPANY'S OWN DEBIT ACCOUNT IS NOT MASKED.
   *
   * 3c2f55d7 rev 2 unmasked it deliberately: this screen is admin-only (RLS), the number is the company's
   * OWN debit account, and an admin routing EPF to the right account needs to read the whole thing. The
   * masks on EMPLOYEE bank details elsewhere are a different decision and are asserted untouched in
   * test/company-panel-bank-statutory-layout.test.ts.
   */
  it('prints the paying account in full, on the card, not truncated to four digits', () => {
    const html = render('en', richProps);
    expect(html).toContain('512345678901');
    expect(html, 'no employee-facing mask leaked onto an admin screen').not.toContain('••••');
  });

  /**
   * A BODY WITH NOTHING ON FILE SAYS SO IN WORDS RATHER THAN SHOWING A BLANK. LHDN is the card that proves
   * both halves at once on `richProps`: it has no authority row, but the company DOES carry its filing
   * number — so the number that exists is shown and the facts that do not are NAMED as not set.
   */
  it('names what is not set instead of rendering an empty gap', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = cards(render('en', richProps));
    expect(cardValues(byBody.lhdn)[0], 'the filing number the company does have').toBe('L123');
    expect(new Set(cardValues(byBody.lhdn).slice(1)), 'and every absent fact says so').toEqual(
      new Set([en.authorityValueNotSet]),
    );
    expect(byBody.lhdn).toContain(inMarkup(en.authorityNotConfigured));
    expect(byBody.epf, 'while a configured body says Configured').toContain(inMarkup(en.authorityConfigured));
  });

  /**
   * FILING NUMBERS APPEAR ON epf / socso / lhdn AND NOWHERE ELSE — the exact set, read off the render.
   *
   * EIS carries none because it has none: it files under SOCSO's PERKESO employer code, and inventing a
   * caption for it would say something untrue. HRD Corp carries a registration BAND instead of a number.
   * Everything else has no filing identity at all.
   */
  it('shows a filing number on exactly the three bodies that have one', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = cards(render('en', richProps));
    const withFiling = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a]);
    expect([...withFiling], 'the controlled set’s own answer').toEqual(['epf', 'socso', 'lhdn']);
    for (const a of STATUTORY_AUTHORITIES) {
      const caption = MY_FILING_FIELD[a] ? inMarkup(en[MY_FILING_FIELD[a].labelKey]) : null;
      if (caption) expect(byBody[a], `${a} states its filing number`).toContain(caption);
    }
    // No body borrows another's caption — which is how one number would come to look like two.
    expect(byBody.eis, 'EIS does not show the PERKESO code as its own').not.toContain(inMarkup(en.socsoEmployerCode));
    expect(byBody.zakat).not.toContain(inMarkup(en.epfEmployerNo));
    expect(byBody.hrdf, 'HRD Corp states a band, not a number').toContain(inMarkup(en.hrdfStatusLabel));
    expect(byBody.hrdf).not.toContain(inMarkup(en.epfEmployerNo));
  });

  /**
   * HRD CORP'S BAND IS THE ONE VALUE THAT COULD BE INVENTED, so it is pinned on both sides. Payroll resolves
   * a missing `company_statutory_my` row to 'not_registered' and charges nothing — but printing that band for
   * a company with no row at all would assert a registration decision nobody made (CLAUDE.md §8: an absent
   * box asserts nothing).
   */
  it('states HRD Corp’s band only when the identity row actually carries one', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    expect(cardValues(cards(render('en', richProps)).hrdf)[0]).toBe(inMarkup(en.hrdfMandatory));
    const bare = cards(render('en', { ...richProps, statutory: null })).hrdf;
    expect(cardValues(bare)[0], 'an absent identity row is never read as a band').toBe(en.authorityValueNotSet);
    for (const band of [en.hrdfNotRegistered, en.hrdfMandatory, en.hrdfOptional]) {
      expect(bare, `the card must not claim ${band}`).not.toContain(inMarkup(band));
    }
  });

  /**
   * ⚠️ APPROVED POINT 6, ON THE RENDER — EIS INDENTED UNDER SOCSO, AND STILL ITS OWN RECORD.
   *
   * Their payment configurations genuinely differ on this tenant (measured on production 2026-09-22: one
   * company pays SMSB_EIS and SMSB_SOCSO), so a single card backed by SOCSO's row would leave EIS's account
   * on file with no screen able to edit it. The DOM POSITION is what is asserted, not just the indent class:
   * in a two-column grid the third card would otherwise land under the first.
   */
  it('draws EIS immediately after SOCSO, indented, with no second copy of the PERKESO mark', () => {
    const html = render('en', richProps);
    const at = (a: string) => html.indexOf(`data-statutory-card="${a}"`);
    expect(at('eis'), 'EIS comes after SOCSO').toBeGreaterThan(at('socso'));
    expect(at('eis'), 'and before LHDN, so it is inside the PERKESO group').toBeLessThan(at('lhdn'));
    expect(cards(html).eis, 'indented').toMatch(/class="[^"]*\bml-6\b/);
    expect(cards(html).socso, 'while its group head is not').not.toMatch(/class="[^"]*\bml-6\b/);
    // The mark is carried once by the group head; a second copy would read as a second organisation.
    expect(cards(html).socso).toContain('/statutory/perkeso.png');
    expect(cards(html).eis, 'no second PERKESO logo').not.toContain('/statutory/perkeso.png');
  });

  /** A company with no bank account cannot route a statutory payment, and the screen says so up front. */
  it('carries the no-bank-account warning through every locale', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      expect(render(locale, sparseProps), locale).toContain(inMarkup(org.authoritiesNoBankAccounts));
    }
  });
});
