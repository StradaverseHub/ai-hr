/**
 * Item 15e5bd93 REVISION 4 (r372) — ONE STATUTORY BODY'S CARD, RENDERED FOR REAL, IN ALL SIX LOCALES.
 *
 * ⚠️ THIS FILE'S SUBJECT HAS MOVED ONCE AND NONE OF ITS CLAIMS WAS DROPPED. r353 put the eight body
 * editors on the setup screen as cards and checked them in test/statutory-setup-screen-render.test.ts.
 * r355 moved the editor to a route of its own (`components/statutory-body-screen.tsx`) and every card
 * claim came here, restated about a SCREEN. The reporter has now contested that route as "an unnecessary
 * intermediate page": the editor is folded back into `components/statutory-setup-screen.tsx` as the
 * per-body CARD, so the claims come back to being about a card — and this file follows its subject rather
 * than being deleted with the file it happened to live in.
 *
 * THE SPLIT WITH THE SIBLING IS BY SUBJECT, NOT BY ROUTE: that file is the SCREEN (what is on it, in what
 * order, the identity card, the actions, the six-locale wiring); this one is ONE BODY'S CARD (its three
 * groups, its thirteen posted names, its filing control, its absences). Both render the same component,
 * because there is one component again.
 *
 * WHAT CHANGED IN THE CLAIMS, AND WHY:
 *   · "view mode renders text and no writer at all" — REVERSED. There is no view mode: the contest's own
 *     words are that a View step and an Edit step are both a click between arriving and changing
 *     something. The card IS the form.
 *   · "gives edit mode a Save submit and a Cancel LINK back to the list" — REVERSED. There is no list and
 *     no per-card Save: one Save for the whole screen, asserted in the sibling and driven through real
 *     events in test/15e5bd93-statutory-screen.dom.test.tsx.
 *   · everything else — all thirteen posted names, the exact three bodies with a filing number, the
 *     unmasked debit account, the departed signatory, EIS's sentence, Clear, the retired lock strings —
 *     is CARRIED FORWARD, restated about a card.
 *
 * A 200 IS NOT A RENDER CHECK (CLAUDE.md §8). `MISSING_MESSAGE` and `FORMATTING_ERROR` pass tsc, the suite
 * and `next build`, and surface only as text on a page somebody has to look at. This file renders through
 * the REAL `NextIntlClientProvider` with each locale's actual JSON and fails on ANY IntlError.
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

// `TabSaveScope` is inside the screen and `useRouter()` throws outside an App Router context. Nothing
// here asserts routing; the client behaviour is driven through real events in the dom file.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
  }),
}));
vi.mock('sonner', () => ({ toast: { success: () => undefined, error: () => undefined } }));

import { StatutorySetupScreen } from '../components/statutory-setup-screen';
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
  statutoryAuthorities: [EPF_ROW],
  bankProfiles: [BANK],
  signatories: [{ personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' }],
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
  backHref: '/admin/organization/c1?tab=statutory',
  actions: {
    saveStatutoryScreen: async () => ({ ok: true, saved: [] }),
    setStatutoryAuthority: noop,
    removeStatutoryAuthority: noop,
  },
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

function render(locale: string, over: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale,
      messages: messagesFor(locale),
      // Without an explicit zone next-intl logs ENVIRONMENT_FALLBACK, which this file treats as a failure.
      timeZone: 'Asia/Kuala_Lumpur',
      children: createElement(StatutorySetupScreen, { ...base, ...over } as never),
    }),
  );
}

const inMarkup = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/** One body's CARD, sliced out of the screen by the attribute that says what the element IS. */
function cards(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /<section[^>]*\sdata-statutory-card="([^"]+)"[\s\S]*?<\/section>/g;
  for (const m of html.matchAll(rx)) out[m[1]] = m[0];
  return out;
}
/** Every group heading printed on one card, in order — the "only the applicable sections" claim. */
const headingsIn = (card: string) =>
  [...card.matchAll(/<div class="text-xs font-medium uppercase tracking-wide text-muted-foreground">([\s\S]*?)<\/div>/g)].map(
    (m) => m[1],
  );

describe('15e5bd93 rev 4 render check — ONE body’s card, every body, all six locales', () => {
  /**
   * ⚠️ EVERY BODY × EVERY LOCALE. The reason it is exhaustive rather than a sample is that three of the
   * eight bodies take a DIFFERENT first group (a filing number, HRD Corp's rate, EIS's sentence) and four
   * take none at all — so a missing caption could hide on any one of them. All eight are on one screen
   * now, so one render per locale covers the lot, which is strictly more coverage than r355's 8 × 2.
   */
  for (const locale of LOCALES) {
    it(`${locale} · every body’s card renders with no IntlError`, () => {
      const html = render(locale);
      expect(html, 'MISSING_MESSAGE').not.toContain('MISSING_MESSAGE');
      expect(html, 'FORMATTING_ERROR').not.toContain('FORMATTING_ERROR');
      expect(Object.keys(cards(html)), 'every body has a card').toEqual([...STATUTORY_AUTHORITIES]);
      expect(errors.join('\n'), 'next-intl logged an error').toBe('');
    });
  }

  it('states the body’s name in every locale, from the same catalogue entry the panel’s list uses', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const byBody = cards(render(locale));
      for (const a of STATUTORY_AUTHORITIES) {
        expect(byBody[a], `${locale}: authority_${a}`).toContain(inMarkup(org[`authority_${a}`]));
      }
    }
  });

  /**
   * ⚠️ REVERSES r355's "view mode renders text and no writer at all — no form, no input, no Save", and the
   * reversal IS this round. The reporter's contest: the View step and the Edit step are both an
   * unnecessary click. Every card is a form, open, on arrival — and there is no mode marker left to
   * branch on, which is the strongest form of "there is one shape".
   */
  it('gives every body one open form and no mode to be in', () => {
    const html = render('en');
    const byBody = cards(html);
    for (const a of STATUTORY_AUTHORITIES) {
      expect(byBody[a], `${a} is a form`).toContain(`data-statutory-form="${a}"`);
      expect(byBody[a], `${a} carries its section marker`).toContain(`data-save-section="${a}"`);
      expect(byBody[a], `${a} has no read-only mode`).not.toContain('data-statutory-mode');
      expect(byBody[a], `${a} has no <dl> summary to ellipsise`).not.toContain('<dl');
    }
    // No per-card Save and no per-card Cancel survived the fold-in: there is ONE Save for the screen.
    const en = messagesFor('en').admin.organization as Record<string, string>;
    expect(html, 'the per-body Save is gone').not.toContain(inMarkup(en.authoritySave));
    expect(html, 'and the per-body Cancel link with it').not.toContain('data-statutory-cancel-link');
  });

  /**
   * ── r226, ON THE RENDER: TWO DIFFERENT NUMBERS, TWO CAPTIONS, TWO BOXES ─────────────────────────
   *
   * The reporter's original complaint was that a body had one number on its card and a different number
   * for the same body in a list above it, with nothing on screen saying they were different things. The
   * FILING number goes on the body's filed form (`company_statutory_my`); the employer account is the
   * reference on its PAYMENT slip (`company_statutory_authority`). Both captions, both stored values, in
   * their own boxes, on the one card.
   */
  it('a configured body carries its filing number and its payment reference in separate boxes', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const card = cards(render('en')).epf;
    expect(card, 'the EPF employer number, captioned').toContain(inMarkup(en.epfEmployerNo));
    expect(card, 'the payment reference, captioned differently').toContain(inMarkup(en.authorityAccountNo));
    expect(card, 'the account it is paid from').toContain(inMarkup(en.authorityBankAccount));
    expect(card, 'the filing value on file').toContain('name="epfEmployerNo" value="E123"');
    expect(card, 'the payment reference on file').toContain('name="accountNo" value="ACC-1"');
    // Every address line has its OWN box, holding its own line whole. r355 joined them into one
    // comma-separated value and then ellipsised it (defect D3, the literal "…" the reporter drew).
    expect(card).toContain('name="addressLine1" value="Jalan Satu"');
    expect(card).toContain('name="city" value="KL"');
    expect(card).toContain('name="postcode" value="50000"');
    expect(card, 'no joined single-line address anywhere').not.toContain('Jalan Satu, KL');
  });

  /**
   * ⚠️ CARRIED THROUGH THREE MOVES: THE COMPANY'S OWN DEBIT ACCOUNT IS NOT MASKED.
   *
   * 3c2f55d7 rev 2 unmasked it deliberately: this screen is admin-only (RLS), the number is the company's
   * OWN debit account, and an admin routing EPF to the right account needs to read the whole thing. The
   * masks on EMPLOYEE bank details elsewhere are a different decision and are asserted untouched in
   * test/company-panel-bank-statutory-layout.test.ts.
   */
  it('prints the paying account in full, not truncated to four digits', () => {
    const html = render('en');
    expect(html).toContain('512345678901');
    expect(html, 'no employee-facing mask leaked onto an admin screen').not.toContain('••••');
  });

  /**
   * A BODY WITH NOTHING ON FILE SHOWS EMPTY BOXES, NOT THE WORDS "Not set" INSIDE A BOX. r355's view mode
   * printed "Not set" as text, which was right for text; printing it as an input VALUE would make the
   * operator delete a sentence before they could type. LHDN proves both halves at once: it has no
   * authority row, but the company DOES carry its filing number, so that one box is filled.
   */
  it('leaves an unset box empty and still shows the filing number the company does have', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const card = cards(render('en')).lhdn;
    expect(card, 'the filing number the company does have').toContain('name="lhdnEmployerNo" value="L123"');
    for (const n of ['accountNo', 'addressLine1', 'city', 'postcode', 'phone', 'email']) {
      expect(card, `${n} is an empty box`).toContain(`name="${n}" value=""`);
    }
    expect(card, 'and never the words "Not set" inside a box').not.toContain(
      `value="${inMarkup(en.authorityValueNotSet)}"`,
    );
    // The card's one word says what is on file, which is where "Not set up" belongs.
    expect(card).toContain(inMarkup(en.statutoryCardNotSetUp));
  });

  /**
   * FILING NUMBERS APPEAR ON epf / socso / lhdn AND NOWHERE ELSE — the exact set, read off the render.
   *
   * EIS carries none because it has none: it files under SOCSO's PERKESO employer code, and inventing a
   * caption for it would say something untrue. HRD Corp carries a registration RATE instead of a number.
   * Everything else has no filing identity at all.
   *
   * ⚠️ ASSERTED PER CARD, NOT PER DOCUMENT. All eight bodies share one screen now, so "the page does not
   * contain SOCSO's caption" would be false for a perfectly correct screen; the claim that still means
   * something is that no body borrows ANOTHER body's caption, which is how one number would come to look
   * like two.
   */
  it('shows a filing control on exactly the three bodies that have one, and no body borrows another’s', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const withFiling = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a]);
    expect([...withFiling], 'the controlled set’s own answer').toEqual(['epf', 'socso', 'lhdn']);
    const byBody = cards(render('en'));
    for (const a of STATUTORY_AUTHORITIES) {
      const own = MY_FILING_FIELD[a];
      if (own) expect(byBody[a], `${a} states its filing number`).toContain(inMarkup(en[own.labelKey]));
      for (const other of withFiling.filter((x) => x !== a)) {
        expect(byBody[a], `${a} must not show ${other}'s caption`).not.toContain(
          inMarkup(en[MY_FILING_FIELD[other].labelKey]),
        );
      }
    }
    expect(byBody.hrdf, 'HRD Corp states a rate, not a number').toContain(inMarkup(en.hrdfStatusLabel));
  });

  /**
   * ⚠️ "ONLY THE SECTIONS APPLICABLE TO THAT BODY", WHICH IS THE REPORTER'S OWN PHRASE READ PER CARD.
   * Three bodies plus HRD Corp and EIS open with a first group; the other three start at Payment setup.
   * The exact ordered heading list per card, because a card that grew a heading it has no field for is
   * exactly what "only the applicable sections" forbids.
   */
  it('heads each card with only the groups that body actually has', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = cards(render('en'));
    const PAY_AND_ADDRESS = [inMarkup(en.authorityPaymentSection), inMarkup(en.authorityAddressSection)];
    for (const a of ['epf', 'socso', 'lhdn', 'eis'] as const) {
      expect(headingsIn(byBody[a]), a).toEqual([inMarkup(en.authorityFilingSection), ...PAY_AND_ADDRESS]);
    }
    expect(headingsIn(byBody.hrdf), 'HRD Corp registers rather than files').toEqual([
      inMarkup(en.authorityRegistrationSection),
      ...PAY_AND_ADDRESS,
    ]);
    for (const a of ['zakat', 'ptptn', 'tabung_haji'] as const) {
      expect(headingsIn(byBody[a]), `${a} has no filing identity at all`).toEqual(PAY_AND_ADDRESS);
    }
  });

  /**
   * HRD CORP'S RATE IS PRE-SELECTED FROM WHAT IS ON FILE. The three stored values are unchanged (no data
   * migration) and in rate order; the identity card is where an ABSENT decision is stated as "Not set",
   * because a select must offer a default and that default is not an assertion about the company.
   */
  it('pre-selects HRD Corp’s stored rate, in rate order, with the stored values untouched', () => {
    const card = cards(render('en')).hrdf;
    const select = card.slice(card.indexOf('name="hrdfStatus"'), card.indexOf('</select>', card.indexOf('name="hrdfStatus"')));
    expect(select.indexOf('value="not_registered"')).toBeGreaterThan(-1);
    expect(select.indexOf('value="mandatory"')).toBeGreaterThan(select.indexOf('value="not_registered"'));
    expect(select.indexOf('value="optional"')).toBeGreaterThan(select.indexOf('value="mandatory"'));
    expect(select, 'the stored rate is the selected one').toContain('value="mandatory" selected=""');
  });

  /**
   * ALL THIRTEEN POSTED NAMES, ON THE RENDER, FOR EVERY BODY. A field that went missing in the fold-in is
   * the single most likely way this round loses a customer's setting, and it would pass every behavioural
   * test: the save succeeds, it just writes `null`.
   */
  it('mounts every posted field at once, on every body’s card', () => {
    const byBody = cards(render('en'));
    for (const a of STATUTORY_AUTHORITIES) {
      for (const n of ['companyId', 'authority', 'returnTo', 'accountNo', 'bankProfileId', 'addressLine1',
        'addressLine2', 'addressLine3', 'city', 'state', 'postcode', 'country', 'phone', 'email',
        'signatoryPersonId']) {
        expect(byBody[a], `${a}: name="${n}"`).toContain(`name="${n}"`);
      }
      expect(byBody[a], `${a}: the body it writes`).toContain(`name="authority" value="${a}"`);
      expect(byBody[a], `${a}: the return marker`).toContain('name="returnTo" value="statutory-setup"');
    }
  });

  /**
   * THE PACK FLAG IS `filingCountry` AND THE POSTAL FIELD IS `country`, ON ONE CARD. Both names at once
   * with different values is the whole condition the r352 rename exists for: without it,
   * `syncCarriedValues` overwrote the hidden flag with "Malaysia" and every identity save died with "No
   * statutory pack for Malaysia". It matters MORE here than it did on the per-body route — there are eight
   * visible postal `country` selects in ONE save scope now. The flag appears only where the body HAS
   * something to write towards the identity row.
   */
  it('emits the pack flag only on the four bodies with a filing control, beside a visible postal country', () => {
    const withFlag = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a] || a === 'hrdf');
    expect([...withFlag]).toEqual(['epf', 'socso', 'lhdn', 'hrdf']);
    const byBody = cards(render('en'));
    for (const a of STATUTORY_AUTHORITIES) {
      const expected = withFlag.includes(a);
      expect(byBody[a].includes('name="filingCountry" value="MY"'), `${a}: pack flag`).toBe(expected);
      // The postal country is on EVERY body's card, as a visible select, which is the collision condition.
      expect(byBody[a], `${a}: postal country`).toContain('name="country"');
    }
  });

  /** EIS says out loud that it files under SOCSO's code, rather than showing an empty box. */
  it('gives EIS a sentence where its filing number would be, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const card = cards(render(locale)).eis;
      expect(card, `${locale}: authorityEisSharesSocso`).toContain(inMarkup(org.authorityEisSharesSocso));
      expect(card, `${locale}: no second control over one column`).not.toContain('name="socsoEmployerCode"');
    }
  });

  /**
   * A DEPARTED SIGNATORY IS STILL POSTED AND STILL NAMED. `EmployeeSearchField` drops a value that is not
   * in its own option list, which would turn "edit the phone number" into "clear the authorised
   * signatory" — so the stored person is injected as an option and the hidden input keeps posting the id.
   */
  it('keeps a signatory who has since left on file, named rather than shown blank', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const card = cards(render('en')).epf;
    expect(card, 'still on record').toContain('name="signatoryPersonId" value="gone-person"');
    expect(card, 'and named as kept on record').toContain(inMarkup(en.authoritySignatoryFormer));
    expect(card, 'captioned for the change summary the one Save builds').toContain(
      `data-field-label="${inMarkup(en.authoritySignatory)}"`,
    );
  });

  /**
   * "Clear this authority" DELETES the row — bucket (b) of the 65b22c00 audit. It appears only where a row
   * exists, it carries `authority` so a REFUSED clear can be returned to this screen (the delete itself is
   * keyed off the row id), and it must NOT carry the section marker: a screen-wide Save that appeared to
   * cover a deletion would be a control lying about what it does.
   */
  it('offers Clear only on a body that has a record, and never inside the saved section', () => {
    const byBody = cards(render('en'));
    expect(byBody.epf, 'EPF has a row').toContain('data-statutory-clear="epf"');
    expect(byBody.ptptn, 'PTPTN has none').not.toContain('data-statutory-clear');
    const clear = byBody.epf.slice(byBody.epf.indexOf('data-statutory-clear="epf"'));
    expect(clear, 'the Clear form is not a saved section').not.toContain('data-save-section');
  });

  /**
   * ⚠️ RETIRED, NOT DELETED, AND NOT RENDERED. `statutoryScreenEditingHint` and `authorityEditing`
   * explained r353's one-card-at-a-time lock, which existed so pressing another card's Edit could not
   * unmount a dirty form. There are no Edit buttons at all now and no form is ever unmounted, so there is
   * nothing to lock. The catalogue entries stay (test/company-panel-bank-statutory-layout.test.ts asserts
   * their presence, the way `authorityClose` has been asserted since r352); neither may appear on screen.
   */
  it('renders neither the retired editing badge nor the retired lock hint', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale);
      expect(html, `${locale}: authorityEditing`).not.toContain(inMarkup(org.authorityEditing));
      expect(html, `${locale}: statutoryScreenEditingHint`).not.toContain(inMarkup(org.statutoryScreenEditingHint));
    }
  });
});
