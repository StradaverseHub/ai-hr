/**
 * Item 15e5bd93 REVISION 4 (r370) — THE STATUTORY PAYMENT SETUP SCREEN, RENDERED FOR REAL, IN ALL SIX
 * LOCALES.
 *
 * ⚠️ THE SIBLING test/company-panel-no-disclosure-render.test.ts ASKED FOR, and it exists for the reason
 * that file states: A 200 IS NOT A RENDER CHECK. `MISSING_MESSAGE` and `FORMATTING_ERROR` pass tsc, the
 * suite and `next build`, and surface only as text on a page somebody has to look at. Every OTHER test on
 * this screen either mocks next-intl (rendering the KEY, so a locale that lost one still passes) or drives
 * one locale through jsdom. This file renders the component through the REAL `NextIntlClientProvider` with
 * each locale's actual JSON and fails on ANY IntlError.
 *
 * ⚠️ RE-POINTED BY REVISION 4, AND BROADENED BACK. r353 rendered eight body CARDS here. r355 narrowed this
 * to a table of rows and moved every card claim to test/statutory-body-screen-render.test.ts, because the
 * editors had become a route of their own. The reporter contested that route as "an unnecessary
 * intermediate page": the editors are back on this one screen as cards, so the card claims come back with
 * them and the two files split by SUBJECT rather than by route — this one is the screen (what is on it,
 * in what order, in six languages), the sibling is one body's card (its groups, its fields, its absences).
 *
 * ⚠️ AND THREE CLAIMS ARE NEW, BECAUSE THIS IS THE ROUND THAT MEASURED THE SCREEN. r355's table laid out
 * 42–322px wider than its container and its Action column was never painted; the body page ellipsised an
 * ordinary address and put a label and its value 767–926px apart; the outer Card had no inset, so the
 * first label sat on its left border. Those were SOURCE decisions — `truncate`, a `<dl>` that declared a
 * grid and then cancelled it per row, a `<Card>` with no padding — and they are pinned at the source,
 * with the removed class strings named, in the last describe below.
 *
 * It matters more here than on the panel, not less, because the eight body labels and descriptions are
 * DYNAMIC keys (`authority_epf`, `authorityDesc_epf`, …) that test/i18n-coverage.test.ts cannot see at all,
 * and because this round added nine more catalogue strings in six languages.
 *
 * ⚠️ `.test.ts`, NOT `.test.tsx`, AND THAT IS NOT A STYLE CHOICE. vitest.config.ts runs `test/**\/*.test.ts`
 * in the node project and `test/**\/*.dom.test.tsx` in the dom one. A `*.test.tsx` that is not `*.dom.` matches
 * NEITHER pattern and is silently skipped — a file full of green-looking assertions that never run. Hence
 * `createElement` rather than JSX here, exactly as the sibling panel render guard does it.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';

/**
 * `TabSaveScope` is inside this screen now, and `useRouter()` THROWS outside an App Router context
 * ("invariant expected app router to be mounted") — it is called during render even though `refresh()` is
 * only reached from a callback. Nothing below asserts anything about routing; the client behaviour of the
 * bar, the prompt and the Save is driven through real events in test/15e5bd93-statutory-screen.dom.test.tsx.
 */
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
const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

const noop = () => undefined;
const BACK_HREF = '/admin/organization/c1?tab=statutory';

/** A fully-populated MY company: a configured body, an identity row, a bank account. */
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
      signatoryPersonId: 'p1',
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
  backHref: BACK_HREF,
  actions: {
    saveStatutoryScreen: async () => ({ ok: true, saved: [] }),
    setStatutoryAuthority: noop,
    removeStatutoryAuthority: noop,
  },
};

/** The other side of every branch: nothing configured at all, and no bank account to pay from. */
const sparseProps = { ...richProps, statutory: null, statutoryAuthorities: [], bankProfiles: [] };

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

/** One body's CARD, by the attribute that says what the element IS rather than by a class string. */
function cards(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /<section[^>]*\sdata-statutory-card="([^"]+)"[\s\S]*?<\/section>/g;
  for (const m of html.matchAll(rx)) out[m[1]] = m[0];
  return out;
}
/** The identity card's markup, which is above the body cards. */
const identity = (html: string) =>
  html.slice(html.indexOf('data-statutory-identity'), html.indexOf('</section>', html.indexOf('data-statutory-identity')));
const dtsIn = (frag: string) => [...frag.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map((m) => m[1]);
const ddsIn = (frag: string) => [...frag.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => m[1]);
const statusOf = (card: string) =>
  card.match(/data-statutory-card-status="[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '';

describe('15e5bd93 rev 4 render check — the setup SCREEN in all six locales, real catalogues', () => {
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
        // No disclosure came with any of the four moves: this screen is flat.
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
      });
    }
  }

  /**
   * ⚠️ THE CLAIM THIS ITEM HAS NOW BEEN CONTESTED THREE TIMES OVER, AND THIS IS THE ROUND THAT REVERSES IT.
   *
   * r352 put the eight bodies' fields inside the Statutory tab. r353 put them on this screen behind eight
   * Edit buttons. r355 narrowed this very case to "renders a table of rows and nothing that can write: no
   * form, no input, no select" and counted one `<table>` and nine `<tr>`s. The reporter contested the page
   * that assertion pushed the fields onto, calling it "an unnecessary intermediate page".
   *
   * So the claim is inverted: EIGHT forms, every body's whole posted set already in the markup, and no
   * table at all. Asserted per body and by exact count, because a screen rendering one open card and seven
   * closed ones would pass "there is a form on this screen".
   */
  it('renders one open form per body, with every posted field already in the markup', () => {
    const html = render('en', richProps);
    const byBody = cards(html);
    expect((html.match(/<form\b/g) ?? []).length, 'eight body forms plus EPF’s Clear form').toBe(
      STATUTORY_AUTHORITIES.length + 1,
    );
    expect(html, 'and the table that overflowed its container is gone').not.toContain('<table');
    for (const a of STATUTORY_AUTHORITIES) {
      expect(byBody[a], `${a} carries its save-section marker`).toContain(`data-save-section="${a}"`);
      for (const name of [
        'accountNo',
        'bankProfileId',
        'addressLine1',
        'addressLine2',
        'addressLine3',
        'city',
        'state',
        'postcode',
        'country',
        'phone',
        'email',
        'signatoryPersonId',
      ]) {
        expect(byBody[a], `${a} · ${name}`).toContain(`name="${name}"`);
      }
    }
  });

  /**
   * ⚠️ THE FOUR COLUMN CAPTIONS AND THE View LINK ARE RETIRED IN PLACE, NOT DELETED. i18n/request.ts
   * deep-merges each locale over English, so dropping a key from en.json alone leaves a Malay reader the
   * old sentence; and a retired string costs nothing while re-translating a deleted one into six
   * languages costs a round (`authorityOpen`, `authorityClose`, `tabOther` and `tabBankAccount` were each
   * retired this way and two have already come back).
   *
   * BOTH HALVES ARE ASSERTED: the keys still EXIST in all six catalogues, and none of them REACHES the
   * screen.
   */
  it('keeps the retired table captions in every catalogue and renders none of them', () => {
    const RETIRED = [
      'statutoryColBody',
      'statutoryColPaymentSetup',
      'statutoryColStatus',
      'statutoryColAction',
      'authorityView',
      'backToStatutorySetup',
      'statutoryBodyViewCaption',
    ] as const;
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, richProps);
      for (const k of RETIRED) {
        expect(org[k], `${locale}: ${k} is retired, not deleted`).toBeTruthy();
        expect(html, `${locale}: ${k} must not be on the screen`).not.toContain(inMarkup(org[k]));
      }
    }
  });

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
   * ⚠️ THE IDENTITY CARD IS AT THE TOP AND CARRIES THE FOUR FILING IDENTIFIERS — the reporter's words,
   * carried through every shape since r355: "so you can confirm whose configuration you are about to edit
   * before you touch anything."
   *
   * An EXACT ordered list of captions, because a substring check would pass on a card that rendered two of
   * the six, and the position is asserted because "stays at the top" is half the request.
   */
  it('puts the six identity facts at the top, in the reporter’s order, with no input among them', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    const card = identity(html);
    expect(card, 'the identity card is on the screen').toBeTruthy();
    expect(dtsIn(card)).toEqual(
      [
        en.ssmRegistrationNo,
        en.myinvoisTin,
        en.epfEmployerNo,
        en.socsoEmployerCode,
        en.lhdnENumber,
        en.hrdfStatusLabel,
      ].map(inMarkup),
    );
    expect(ddsIn(card)).toEqual(
      ['202301001234', 'C12345678900', 'E123', 'S123', 'L123', en.hrdfMandatory].map(inMarkup),
    );
    /**
     * ⚠️ READ-ONLY HERE, EDITABLE PER BODY. The four filing identifiers live on `company_statutory_my` and
     * are edited inside each body's card through MY_FILING_FIELD (r226). Two editable copies would be two
     * doors onto one column and whichever was saved second would win. The rest of the screen is now full
     * of inputs, so this claim is pinned on the CARD rather than on the document.
     */
    expect(card).not.toContain('<input');
    expect(card).not.toContain('<select');
    // ABOVE the first body card, which is what "stays at the top" means.
    expect(html.indexOf('data-statutory-identity')).toBeLessThan(html.indexOf('data-statutory-card="epf"'));
  });

  it('names an absent identity fact rather than rendering a gap, and never guesses HRD Corp’s rate', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const card = identity(render('en', sparseProps));
    expect(new Set(ddsIn(card)), 'every absent fact says so in words').toEqual(
      new Set([inMarkup(en.authorityValueNotSet)]),
    );
    for (const band of [en.hrdfNotRegistered, en.hrdfMandatory, en.hrdfOptional]) {
      expect(card, `the card must not claim ${band}`).not.toContain(inMarkup(band));
    }
    expect(render('en', sparseProps), 'and the identity HINT still renders').toContain(
      inMarkup(en.statutoryIdentityHint),
    );
  });

  /**
   * ⚠️ ONE STATUS WORD PER CARD, AND WHAT BECAME OF THE TWO COLUMNS.
   *
   * r355's table drew Payment Setup and Status, and the plan told the reporter exactly what each meant:
   * "Payment Setup = we hold a payment record for that body; Status = it is actually contributing". That
   * answer was honest and is RETIRED WITH THE TABLE rather than silently dropped. Each card now carries
   * one word meaning the FIRST of those, identically for all eight bodies, so a shared caption says only
   * what is true of every member (CLAUDE.md §8).
   *
   * HRD Corp is the body the second column existed for, and its fact is still on the screen: not as a
   * derived pill but as the Contribution Rate select on its own card, which is where it is CHOSEN. This
   * case pins both halves — the one word, and the rate still being editable beneath it.
   */
  it('gives every card one status word, and keeps HRD Corp’s contributing fact as its own control', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = cards(render('en', richProps));
    expect(statusOf(byBody.epf), 'EPF has a payment record').toBe(inMarkup(en.statutoryCardSetUp));
    for (const a of STATUTORY_AUTHORITIES.filter((x) => x !== 'epf')) {
      expect(statusOf(byBody[a]), a).toBe(inMarkup(en.statutoryCardNotSetUp));
    }
    // The old Status vocabulary is gone from the screen entirely — one word, not two columns.
    const html = render('en', richProps);
    expect(html, 'no Active pill').not.toContain(inMarkup(en.authorityStatusActive));
    expect(html, 'no Inactive pill').not.toContain(inMarkup(en.authorityStatusInactive));
    // And the fact that column carried is the control on HRD Corp's own card.
    expect(byBody.hrdf, 'the rate select').toContain('name="hrdfStatus"');
    expect(byBody.hrdf).toContain(inMarkup(en.hrdfStatusLabel));
  });

  /** The status vocabulary and the nine new screen strings exist, and reach the screen, in all six locales. */
  it('carries Set up / Not set up and the screen’s own actions in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, richProps);
      for (const k of ['statutoryCardSetUp', 'statutoryCardNotSetUp', 'statutoryScreenSave', 'statutoryScreenCancel']) {
        expect(org[k], `${locale}: ${k}`).toBeTruthy();
        expect(html, `${locale}: ${k} reaches the screen`).toContain(inMarkup(org[k]));
      }
      /**
       * The prompt's five strings are rendered only once the reader tries to leave with something
       * unsaved, so a render check cannot see them — but a MISSING one is still a MISSING_MESSAGE thrown
       * at somebody mid-navigation, in the one locale nobody tested. Their EXISTENCE is checked here for
       * all six; their wiring is driven through real events in the dom file.
       */
      for (const k of [
        'statutoryUnsavedTitle',
        'statutoryUnsavedBody',
        'statutoryUnsavedCancel',
        'statutoryUnsavedDiscard',
        'statutoryUnsavedSave',
      ]) {
        expect(org[k], `${locale}: ${k}`).toBeTruthy();
      }
    }
  });

  /**
   * ⚠️ NO LINK ON THIS SCREEN ADDRESSES THE DELETED PER-BODY ROUTE. r355 gave every row a View and an
   * Edit href built out of the body key. Both the affordances and the route are gone; a link left
   * pointing at a deleted route is a 404 nobody notices until a reader presses it, which is exactly the
   * class of fault this round was raised over.
   */
  it('builds no address with a body in it, and offers no View or Edit', () => {
    const html = render('en', richProps);
    for (const a of STATUTORY_AUTHORITIES) {
      expect(html, `no /statutory/${a} address`).not.toContain(`/statutory/${a}`);
    }
    expect(html, 'no mode query anywhere').not.toContain('mode=');
    expect(html, 'no View affordance').not.toContain('data-statutory-view-link');
    expect(html, 'no Edit affordance').not.toContain('data-statutory-edit-link');
    // Cancel goes to the company's Statutory TAB, which is also where the page header's Back goes.
    expect(html, 'Cancel leaves to the tab this screen was opened from').toContain(`href="${BACK_HREF}"`);
  });

  /**
   * FILING NUMBERS BELONG TO epf / socso / lhdn AND TO NOBODY ELSE — the exact set, read off the
   * controlled set's own answer. EIS carries none because it has none: it files under SOCSO's PERKESO
   * employer code. HRD Corp carries a registration RATE instead of a number.
   *
   * ⚠️ ASSERTED IN BOTH DIRECTIONS, AND THE SECOND HALF IS THE ONE THAT MATTERS: exactly ONE editable
   * control exists per filing column on the whole screen. Eight cards in one save scope is eight chances
   * to grow a second door onto one column, which is the r226 fault.
   */
  it('puts each filing number on its own body’s card and on the identity card, and nowhere else', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    const withFiling = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a]);
    expect([...withFiling], 'the controlled set’s own answer').toEqual(['epf', 'socso', 'lhdn']);
    const card = identity(html);
    const byBody = cards(html);
    for (const a of withFiling) {
      expect(card, `${a}'s filing caption is on the identity card`).toContain(inMarkup(en[MY_FILING_FIELD[a].labelKey]));
      expect(byBody[a], `${a} edits its own filing number`).toContain(`name="${MY_FILING_FIELD[a].name}"`);
      // EXACTLY ONE writer for that column across the whole screen.
      expect(
        (html.match(new RegExp(`name="${MY_FILING_FIELD[a].name}"`, 'g')) ?? []).length,
        `${a}: one owner, one editor`,
      ).toBe(1);
    }
    for (const a of STATUTORY_AUTHORITIES.filter((x) => !MY_FILING_FIELD[x])) {
      for (const f of withFiling) {
        expect(byBody[a], `${a} does not repeat ${f}'s filing control`).not.toContain(
          `name="${MY_FILING_FIELD[f].name}"`,
        );
      }
    }
  });

  /**
   * ⚠️ SOCSO AND EIS ARE TWO CARDS AND STILL TWO RECORDS — efe424b0's measured reason: their payment
   * accounts genuinely differ on this tenant, so merging them would leave EIS's account on file with no
   * screen able to edit it. ADJACENCY is asserted, not merely "after".
   */
  it('draws EIS in the card immediately after SOCSO, saying whose code it files under', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    const order = Object.keys(cards(html));
    expect(order[order.indexOf('socso') + 1], 'the very next card').toBe('eis');
    expect(cards(html).eis, 'and it says so rather than showing an empty box').toContain(
      inMarkup(en.authorityEisSharesSocso),
    );
    expect(cards(html).eis, 'its own record, its own payment fields').toContain('data-save-section="eis"');
  });

  /** A company with no bank account cannot route a statutory payment, and the screen says so up front. */
  it('carries the no-bank-account warning through every locale', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      expect(render(locale, sparseProps), locale).toContain(inMarkup(org.authoritiesNoBankAccounts));
    }
  });
});

/**
 * ⚠️ THE FOUR MEASURED DEFECTS, PINNED WHERE THE DECISION LIVES.
 *
 * jsdom computes no layout and `renderToStaticMarkup` computes less, so nothing here claims to have
 * measured a pixel — what these pin is the SOURCE decision each measurement traced back to, with the
 * removed class string named so it cannot quietly return. The measurements themselves (1280 / 1024 /
 * 820 CSS px, dark and light) are recorded in the approved plan for revision 4.
 */
describe('15e5bd93 rev 4 — the source decisions the measurements traced back to', () => {
  const SCREEN = read('components/statutory-setup-screen.tsx');
  const PAGE = read('app/admin/organization/[companyId]/statutory/page.tsx');
  /**
   * COMMENTS ARE STRIPPED FIRST (the r331 aec53564 lesson: a guard that reads its own explanation finds
   * the very thing it is banning). Every removal below is recorded in a source comment that NAMES the
   * class it removed, and that record has to survive.
   */
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

  /**
   * D1 / D3 — `truncate` is `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`, and BOTH
   * halves did damage. The nowrap made the r355 table cell's min-content the whole 132-character SOCSO
   * description, so the table laid out 42–322px wider than its container and the Action column was never
   * painted; the ellipsis cut an ordinary Malaysian correspondence address mid-word, which is the "…" the
   * reporter drew.
   */
  it('holds nothing on this screen to a single line', () => {
    expect(code(SCREEN), 'no truncate on any label, value or description').not.toMatch(/\btruncate\b/);
    expect(code(SCREEN), 'and no horizontal scroller to hide a control behind').not.toContain('tableWrapCls');
    expect(code(SCREEN), 'no overflow-x-auto either').not.toContain('overflow-x-auto');
  });

  /** D2 — the pill's own text wrapped out of its rounded background at a squeezed width. */
  it('keeps a status pill’s text inside the pill', () => {
    const map = code(SCREEN).slice(code(SCREEN).indexOf('const badge = {'), code(SCREEN).indexOf('};', code(SCREEN).indexOf('const badge = {')));
    expect(map, 'the emerald chip').toContain('whitespace-nowrap');
    expect((map.match(/whitespace-nowrap/g) ?? []).length, 'both chips, not only the first').toBe(2);
  });

  /**
   * D4 — r355's view-mode summary declared `grid-cols-[auto_1fr]` and then gave every row
   * `col-span-2 flex … justify-between`, which CANCELS the grid outright: measured at 1280, the caption's
   * right edge was 31–190px and its value's left edge 906–957px, i.e. 767–926px of dead space per row,
   * with three different value edges because each was right-aligned to its own width. The whole shape is
   * gone with view mode; the class strings are named so the pattern cannot come back.
   */
  it('never declares a grid and then cancels it per row', () => {
    expect(code(SCREEN), 'the cancelled grid').not.toContain('grid-cols-[auto_1fr]');
    expect(code(SCREEN), 'a row that opts out of the grid it is in').not.toContain('col-span-2 flex');
    expect(code(SCREEN), 'no value right-aligned away from its own label').not.toContain('text-right');
    /**
     * AND THE POSITIVE HALF, ON THE RENDER: a caption is directly above the value it names. Every
     * `<dt>`/`<dd>` pair on the identity card sits in one `flex flex-col`, which is the same column
     * relationship every `Field` gives an input — one rule for the whole screen.
     */
    const card = identity(render('en', richProps));
    expect((card.match(/<div class="flex min-w-0 flex-col">/g) ?? []).length, 'one column per fact').toBe(6);
    expect(card, 'and no row pushes its value to the far end').not.toContain('justify-between');
  });

  /**
   * D5 — `components/ui/card.tsx` `Card` carries no padding of its own and this page used none, so the
   * first label sat ON the card's left border (measured x=265 with the border at 265) and the last value
   * on the right one. The company panel gets its inset from its tab shell; this screen has no tab shell.
   */
  it('gives the page’s Card an inset of its own', () => {
    expect(code(PAGE), 'the outer Card is padded').toMatch(/<Card className="p-4">/);
    expect(
      code(read('components/ui/card.tsx')),
      'and the shared primitive is NOT restyled for one screen — every other Card in the product is unchanged',
    ).toContain("'rounded-[1.25rem] border border-border bg-card text-card-foreground shadow-[var(--shadow-card)]'");
  });

  /**
   * D6 — four widths for one kind of field at 1280 (484 / 320 / 648 / 976): the filing number in a
   * two-column grid, the account number and postcode in a three-column one, the bank select spanning
   * two, the signatory and the address lines spanning three. A postcode box as wide as an email box.
   * ONE grid constant for every group on every card, and spans of 1 or 3 only.
   */
  it('lays every group out in one shared three-column grid', () => {
    const src = code(SCREEN);
    expect(src, 'one constant, declared once').toContain(
      "const cardGridCls = 'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3';",
    );
    // No hand-written grid beside it, which is how the four widths accumulated in the first place.
    expect(src, 'no second column count').not.toMatch(/sm:grid-cols-[124-9]/);
    expect(src, 'and no half-width span').not.toMatch(/col-span-2(?![0-9])/);
  });
});
