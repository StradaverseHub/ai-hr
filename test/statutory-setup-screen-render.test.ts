/**
 * Item 15e5bd93 REVISION 3 (r355) — THE STATUTORY PAYMENT SETUP **LIST**, RENDERED FOR REAL, IN ALL SIX
 * LOCALES.
 *
 * ⚠️ THE SIBLING test/company-panel-no-disclosure-render.test.ts ASKED FOR, and it exists for the reason
 * that file states: A 200 IS NOT A RENDER CHECK. `MISSING_MESSAGE` and `FORMATTING_ERROR` pass tsc, the
 * suite and `next build`, and surface only as text on a page somebody has to look at. Every OTHER test on
 * this screen either mocks next-intl (rendering the KEY, so a locale that lost one still passes) or drives
 * one locale through jsdom. This file renders the component through the REAL `NextIntlClientProvider` with
 * each locale's actual JSON and fails on ANY IntlError.
 *
 * ⚠️ RE-POINTED BY REVISION 3, AND NARROWED ON PURPOSE. r353's version of this file rendered the eight body
 * CARDS this screen used to hold, because that screen held the editors. The reporter contested that shape and
 * drew a table of rows instead, so the editors are a route of their own and their six-locale render check is
 * test/statutory-body-screen-render.test.ts. Every claim r353 made about a card is made there; nothing was
 * dropped because its subject moved. What stays HERE is everything about the LIST, plus three claims that are
 * new because the layout is:
 *   · the reporter's four column headers, as an exact ordered list;
 *   · the identity card at the top, with the four filing identifiers, read-only;
 *   · Payment Setup and Status as TWO facts, including the HRD Corp row where they diverge.
 *
 * It matters more here than on the panel, not less, because this screen introduced eleven new catalogue
 * strings in six languages, and because the eight body labels and descriptions are DYNAMIC keys
 * (`authority_epf`, `authorityDesc_epf`, …) that test/i18n-coverage.test.ts cannot see at all.
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
import { StatutorySetupScreen } from '../components/statutory-setup-screen';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';
import { MY_FILING_FIELD, statutoryRowStatus } from '../lib/statutory-authority-display';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesFor = (l: string) => JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${l}.json`), 'utf8'));

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

/** One body's row, by the attribute that says what the element IS rather than by a class string. */
function rows(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rx = /<tr[^>]*\sdata-statutory-row="([^"]+)"[\s\S]*?<\/tr>/g;
  for (const m of html.matchAll(rx)) out[m[1]] = m[0];
  return out;
}
/** The identity card's markup, which is above the table. */
const identity = (html: string) =>
  html.slice(html.indexOf('data-statutory-identity'), html.indexOf('</section>', html.indexOf('data-statutory-identity')));
const dtsIn = (frag: string) => [...frag.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/g)].map((m) => m[1]);
const ddsIn = (frag: string) => [...frag.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => m[1]);
const cellOf = (row: string, what: 'payment-setup' | 'status') =>
  row.match(new RegExp(`data-statutory-${what}[^>]*>([\\s\\S]*?)</span>`))?.[1] ?? '';

describe('15e5bd93 rev 3 render check — the setup LIST in all six locales, real catalogues', () => {
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
        expect(Object.keys(rows(html))).toEqual([...STATUTORY_AUTHORITIES]);
        // No disclosure came with either move: this screen is a list, not a fold and not a set of cards.
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
      });
    }
  }

  /**
   * ⚠️ THE CLAIM THIS ITEM HAS NOW BEEN CONTESTED TWICE OVER, ASSERTED ON THE RENDER.
   *
   * r352 put the eight bodies' fields inside the Statutory tab. r353 put them on this screen behind eight
   * Edit buttons — r353's version of this very case read "opens entirely read-only: eight cards, no form, no
   * input, and an Edit on each", and counted `data-statutory-mode="viewing"` eight times. The reporter
   * contested that too. The approved plan for revision 3: "The eight bodies below become a plain table:
   * Statutory, Payment Setup, Status, Action. One line each. No fields, no forms, nothing expanded."
   *
   * So the claim is no longer "no form UNTIL you press Edit" but "no form AT ALL", which is strictly
   * stronger: r353's screen could grow one, this one cannot. A source guard can see the absence of a
   * `<form>` tag; only the render can see that nothing else on the page produced one either.
   */
  it('renders a table of rows and nothing that can write: no form, no input, no select', () => {
    const html = render('en', richProps);
    expect(html, 'the list cannot write').not.toContain('<form');
    expect(html, 'and holds no box at all').not.toContain('<input');
    expect(html, 'nor a select pretending to be read-only').not.toContain('<select');
    expect(html, 'nor a textarea').not.toContain('<textarea');
    expect(html, 'nothing on this screen acts in place').not.toContain('<button');
    expect(html, 'and nothing expands').not.toContain('aria-expanded');
    // It is a real table, and the eight rows are its <tbody>.
    expect((html.match(/<table\b/g) ?? []).length, 'one table').toBe(1);
    expect((html.match(/<tr\b/g) ?? []).length, 'a header row plus one row per body').toBe(
      STATUTORY_AUTHORITIES.length + 1,
    );
  });

  /** The reporter's four columns, in their order, as an EXACT list — in every locale. */
  it('carries the reporter’s four column headers, in order, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      // `(?!ead)` because `<thead …>` also matches `<th[^>]*>` and would swallow the first cell.
      const heads = [...render(locale, richProps).matchAll(/<th(?!ead)[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
      expect(heads, locale).toEqual(
        [org.statutoryColBody, org.statutoryColPaymentSetup, org.statutoryColStatus, org.statutoryColAction].map(
          inMarkup,
        ),
      );
    }
  });

  /**
   * EVERY BODY'S LABEL AND DESCRIPTION, IN EVERY LOCALE. Both are computed at render time
   * (`` t(`authority_${a}`) ``), so test/i18n-coverage.test.ts cannot see either: adding an authority means
   * adding BOTH strings to SIX files or the row renders MISSING_MESSAGE behind a 200, a green suite and a
   * clean build. The source guard checks the keys EXIST; this checks they reach the screen.
   */
  it('states every body’s name and purpose, on its own row, in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const byBody = rows(render(locale, richProps));
      for (const a of STATUTORY_AUTHORITIES) {
        expect(byBody[a], `${locale}: authority_${a}`).toContain(inMarkup(org[`authority_${a}`]));
        expect(byBody[a], `${locale}: authorityDesc_${a}`).toContain(inMarkup(org[`authorityDesc_${a}`]));
      }
    }
  });

  /**
   * ⚠️ APPROVED POINT 1 OF REVISION 3, ON THE RENDER: THE IDENTITY CARD IS AT THE TOP AND CARRIES THE FOUR
   * FILING IDENTIFIERS. The reporter's words: "Besides the company's SSM number and MyInvois TIN it will
   * carry the identifiers you listed - the EPF employer number, the SOCSO employer code, the LHDN E number,
   * the HRDF status - so you can confirm whose configuration you are about to edit before you touch
   * anything."
   *
   * An EXACT ordered list of captions, because a substring check would pass on a card that rendered two of
   * the six, and the position is asserted because "moves to the top" is half the request.
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
     * ⚠️ READ-ONLY HERE, EDITABLE PER BODY — the decision this round had to make and state. The four filing
     * identifiers live on `company_statutory_my` and are edited inside each body's editor through
     * MY_FILING_FIELD (r226). Two editable copies would be two doors onto one column and whichever was
     * saved second would win. `<input` is already absent from the whole screen above; this pins the card.
     */
    expect(card).not.toContain('<input');
    expect(card).not.toContain('<select');
    // ABOVE the table, which is what "moves to the top of the page" means.
    expect(html.indexOf('data-statutory-identity')).toBeLessThan(html.indexOf('<table'));
  });

  it('names an absent identity fact rather than rendering a gap, and never guesses HRD Corp’s band', () => {
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
   * ⚠️ THE TWO STATUS COLUMNS ARE TWO FACTS, AND THE PLAN PROMISED THE REPORTER THAT PRECISELY:
   *
   *     Payment Setup = a company_statutory_authority row exists for that body
   *     Status        = it is actually contributing
   *
   * `richProps` is the divergence in one direction: EPF has a row (both columns agree), and HRD Corp has NO
   * row while the identity row says `mandatory` — so payroll charges its levy. A Status column that was
   * secretly an echo of Payment Setup would read Inactive there and this case is what catches it.
   *
   * Derived through `statutoryRowStatus`, the ONE derivation, so the guard and the screen cannot drift apart
   * in opposite directions and still agree with each other.
   */
  it('reads Payment Setup off the record and Status off what is actually contributing', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = rows(render('en', richProps));
    for (const a of STATUTORY_AUTHORITIES) {
      const hasRow = richProps.statutoryAuthorities.some((r) => r.authority === a);
      const { configured, contributing } = statutoryRowStatus(a, hasRow, richProps.statutory.hrdfStatus);
      expect(cellOf(byBody[a], 'payment-setup'), `${a}: Payment Setup`).toBe(
        inMarkup(configured ? en.authorityConfigured : en.authorityNotConfigured),
      );
      expect(cellOf(byBody[a], 'status'), `${a}: Status`).toBe(
        inMarkup(contributing ? en.authorityStatusActive : en.authorityStatusInactive),
      );
    }
    // Spelled out for the one row where they differ, so the case cannot pass vacuously if the helper breaks.
    expect(cellOf(byBody.hrdf, 'payment-setup'), 'no payment record').toBe(inMarkup(en.authorityNotConfigured));
    expect(cellOf(byBody.hrdf, 'status'), 'yet the levy IS charged').toBe(inMarkup(en.authorityStatusActive));
    expect(cellOf(byBody.epf, 'payment-setup')).toBe(inMarkup(en.authorityConfigured));
    expect(cellOf(byBody.epf, 'status')).toBe(inMarkup(en.authorityStatusActive));
  });

  /**
   * THE OTHER DIRECTION, WHICH IS THE ONE THE PLAN NAMED TO THE REPORTER: "a company can have the payment
   * details filled in and still be set to no contribution, and that row will read Configured and Inactive".
   * `hrdf_status` is not_registered | mandatory | optional (localization/my/company-statutory.ts) and
   * core/payroll.ts charges the levy only when it is not `not_registered`.
   */
  it('HRD Corp reads Configured and Inactive together, which is a real reachable state', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = rows(
      render('en', {
        ...richProps,
        statutoryAuthorities: [{ ...richProps.statutoryAuthorities[0], id: 'a9', authority: 'hrdf' }],
        statutory: { ...richProps.statutory, hrdfStatus: 'not_registered' as const },
      }),
    );
    expect(cellOf(byBody.hrdf, 'payment-setup')).toBe(inMarkup(en.authorityConfigured));
    expect(cellOf(byBody.hrdf, 'status')).toBe(inMarkup(en.authorityStatusInactive));
  });

  /** Both column vocabularies exist in all six locales, since neither is a dynamic key the coverage test sees. */
  it('carries Configured / Not set up and Active / Inactive in all six locales', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, richProps);
      for (const k of ['authorityConfigured', 'authorityNotConfigured', 'authorityStatusActive', 'authorityStatusInactive']) {
        expect(org[k], `${locale}: ${k}`).toBeTruthy();
        expect(html, `${locale}: ${k} reaches the screen`).toContain(inMarkup(org[k]));
      }
    }
  });

  /**
   * VIEW AND EDIT ARE LINKS TO THE PER-BODY ROUTE, ONE PAIR PER ROW, AND EACH NAMES ITS OWN BODY. That last
   * half is the one that matters: eight rows all linking to EPF would look perfectly correct on this screen.
   */
  it('gives every row a View and an Edit link into that body’s own route', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const byBody = rows(render('en', richProps));
    for (const a of STATUTORY_AUTHORITIES) {
      expect(byBody[a], `${a} View`).toContain(`href="/admin/organization/c1/statutory/${a}?mode=view"`);
      expect(byBody[a], `${a} Edit`).toContain(`href="/admin/organization/c1/statutory/${a}?mode=edit"`);
      expect(byBody[a]).toContain(inMarkup(en.authorityView));
      expect(byBody[a]).toContain(inMarkup(en.authorityEdit));
    }
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      expect(org.authorityView, `${locale}: authorityView`).toBeTruthy();
      expect(render(locale, richProps), `${locale}: View reaches the row`).toContain(inMarkup(org.authorityView));
    }
  });

  /**
   * ⚠️ REVERSES r353's LOCK, AND THE REASON IT CAN BE REVERSED IS THE REASON IT EXISTED. r353 DISABLED the
   * other seven Edit buttons while a card was open, and said so on screen through
   * `statutoryScreenEditingHint`, because pressing one would unmount a dirty form and discard typing
   * silently. Edit is a link to another route now and there is no form on this screen, so there is nothing
   * to lock and nothing to explain. The catalogue entry is KEPT (see the layout guard); it is not RENDERED.
   */
  it('renders no editing lock and no advice about one, in any locale', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      const html = render(locale, richProps);
      expect(html, `${locale}: the lock hint is not on this screen`).not.toContain(
        inMarkup(org.statutoryScreenEditingHint),
      );
      expect(html, `${locale}: nor the Editing badge`).not.toContain(inMarkup(org.authorityEditing));
      expect(html, 'and nothing is disabled').not.toContain('disabled');
    }
  });

  /**
   * FILING NUMBERS APPEAR ON epf / socso / lhdn AND NOWHERE ELSE — the exact set, read off the controlled
   * set's own answer. EIS carries none because it has none: it files under SOCSO's PERKESO employer code.
   * HRD Corp carries a registration BAND instead of a number.
   *
   * ⚠️ ON THIS SCREEN THE THREE NUMBERS ARE ON THE IDENTITY CARD, NOT ON THE ROWS, and that is asserted in
   * both directions: the card has them and a ROW has none, because a row is four columns and a filing number
   * is not one of them.
   */
  it('shows the three filing numbers on the identity card and on no row', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    const withFiling = STATUTORY_AUTHORITIES.filter((a) => MY_FILING_FIELD[a]);
    expect([...withFiling], 'the controlled set’s own answer').toEqual(['epf', 'socso', 'lhdn']);
    const card = identity(html);
    for (const a of withFiling) {
      expect(card, `${a}'s filing caption is on the identity card`).toContain(
        inMarkup(en[MY_FILING_FIELD[a].labelKey]),
      );
    }
    const byBody = rows(html);
    for (const a of STATUTORY_AUTHORITIES) {
      for (const cap of ['epfEmployerNo', 'socsoEmployerCode', 'lhdnENumber'] as const) {
        expect(byBody[a], `${a}'s row does not repeat ${cap}`).not.toContain(inMarkup(en[cap]));
      }
    }
  });

  /**
   * ⚠️ SOCSO AND EIS ARE TWO ROWS, EIS INDENTED UNDER SOCSO, AND STILL TWO RECORDS — the reporter's sketch
   * and efe424b0's measured reason (their payment accounts genuinely differ on this tenant, so merging them
   * would leave EIS's account on file with no screen able to edit it).
   *
   * r353 needed `STATUTORY_AUTHORITIES.filter(...)` plus a re-draw inside SOCSO's grid cell to make this
   * true, because in a two-column grid the third card lands under the FIRST. A table needs neither: the
   * controlled set already orders EIS immediately after SOCSO, so the row order carries the relationship and
   * the indent shows it. ADJACENCY is asserted, not merely "after".
   */
  it('draws EIS in the row immediately after SOCSO, indented, and still its own record', () => {
    const html = render('en', richProps);
    const order = Object.keys(rows(html));
    expect(order[order.indexOf('socso') + 1], 'the very next row').toBe('eis');
    expect(rows(html).eis, 'indented').toMatch(/class="[^"]*\bpl-6\b/);
    expect(rows(html).socso, 'while its group head is not').not.toMatch(/class="[^"]*\bpl-6\b/);
    // Its own record: its links name EIS, so its own screen edits its own row.
    expect(rows(html).eis).toContain('/statutory/eis?mode=edit');
    expect(rows(html).socso).toContain('/statutory/socso?mode=edit');
  });

  /** A company with no bank account cannot route a statutory payment, and the screen says so up front. */
  it('carries the no-bank-account warning through every locale', () => {
    for (const locale of LOCALES) {
      const org = messagesFor(locale).admin.organization as Record<string, string>;
      expect(render(locale, sparseProps), locale).toContain(inMarkup(org.authoritiesNoBankAccounts));
    }
  });
});
