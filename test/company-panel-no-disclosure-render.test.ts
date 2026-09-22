/**
 * Item 3c2f55d7 — the company panel, rendered for real, in all six locales.
 *
 * WHY THIS EXISTS AS A TEST AND NOT A DEV-SERVER EYEBALL. A 200 is not a render check: MISSING_MESSAGE
 * passes tsc, the suite and `next build`, and shows up only as text on a page somebody has to look at.
 * Every OTHER test on this screen mocks next-intl (`useTranslations: () => (k) => k`), so it renders the
 * KEY and can never see a locale that has lost one. This file renders the component through the real
 * NextIntlClientProvider with each locale's actual JSON and fails on any IntlError — the same thing a
 * human would be squinting for on six dev-server tabs, done deterministically and without a database.
 *
 * It also carries the behavioural half of the flattening (test/company-panel-bank-statutory-layout has
 * the source half): the content that used to sit behind a fold is asserted PRESENT in the markup, on a
 * fully-configured Malaysian company AND on an archived non-MY one with nothing set up, so neither
 * branch of the panel can quietly regain a disclosure.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { CompanyPanel, type PanelCompany } from '../components/company-panel';
import { STATUTORY_AUTHORITIES } from '../lib/statutory-authorities';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesFor = (l: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${l}.json`), 'utf8'));

const noop = () => undefined;
const actions = {
  updateCompany: noop,
  archiveCompany: noop,
  deleteCompany: noop,
  setParent: noop,
  setStatutory: noop,
  setBankProfile: noop,
  removeBankProfile: noop,
  setStatutoryAuthority: noop,
  removeStatutoryAuthority: noop,
  setCompanyLogo: noop,
  removeCompanyLogo: noop,
  updateCompanyDefaultCycle: noop,
};

const baseCompany: PanelCompany = {
  id: 'c1',
  name: 'Demo Sdn Bhd',
  country: 'MY',
  currency: 'MYR',
  registrationNo: '202301001234',
  companyLabel: 'DEMO',
  industry: 'Construction',
  website: 'https://example.test',
  businessType: 'Sdn Bhd',
  addressLine1: 'Level 10',
  addressLine2: 'Menara Demo',
  addressLine3: null,
  city: 'Kuala Lumpur',
  state: 'Selangor',
  addressCountry: 'Malaysia',
  postcode: '50000',
  phone: '+60312345678',
  fax: null,
  archivedAt: null,
  inUse: true,
  parentId: null,
  hasLogo: true,
  defaultPayrollCycle: 'Monthly',
};

/** A fully-populated MY company: every previously-folded area has content to show. */
const richProps = {
  company: baseCompany,
  companies: [
    { id: 'c1', name: 'Demo Sdn Bhd' },
    { id: 'c2', name: 'Demo Group Holdings Bhd' },
  ],
  statutory: {
    epfEmployerNo: 'E123',
    socsoEmployerCode: 'S123',
    lhdnEmployerNo: 'L123',
    myinvoisTin: null,
    ssmRegistrationNo: null,
    hrdfStatus: 'mandatory' as const,
  },
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
    {
      id: 'bp2',
      bank: 'legacy_gone_bank',
      corporateId: 'CORP2',
      debitAccountNo: '998877665544',
      orgName: null,
      txnType: 'IBG',
      accountLabel: null,
      accountName: null,
      accountType: null,
      branch: null,
      swiftCode: null,
      currency: 'MYR',
      isPrimary: false,
    },
  ],
  statutoryAuthorities: [
    {
      id: 'a1',
      authority: STATUTORY_AUTHORITIES[0],
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
      signatoryPersonId: 'gone-person',
    },
  ],
  // 3c2f55d7 rev 2 — the picker searches by Employee ID as well as by name, so a candidate carries its code.
  signatories: [{ personId: 'p1', name: 'Aminah binti Ali', employeeCode: 'EMP-0001' }],
  stateOptions: [{ value: 'Selangor', label: 'Selangor' }],
  activeCycleNames: ['Monthly', 'Fortnightly'],
  actions,
};

/** An ARCHIVED, non-MY company with nothing configured — the other side of every branch. */
const sparseProps = {
  ...richProps,
  company: {
    ...baseCompany,
    id: 'c3',
    name: 'Demo Pte Ltd',
    country: 'SG',
    currency: 'SGD',
    archivedAt: new Date('2026-01-01'),
    inUse: false,
    hasLogo: false,
    registrationNo: null,
    defaultPayrollCycle: 'Retired Cycle',
  },
  statutory: null,
  bankProfiles: [],
  statutoryAuthorities: [],
  signatories: [],
  activeCycleNames: [],
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
      // Without an explicit zone next-intl logs ENVIRONMENT_FALLBACK, which this file treats as a
      // failure — the whole point is that it fails on ANY IntlError, not just a missing message.
      timeZone: 'Asia/Kuala_Lumpur',
      children: createElement(CompanyPanel, props as never),
    }),
  );
}

/**
 * THE CATALOGUE STRING AS IT APPEARS IN MARKUP. r327 renamed authority_socso to "SOCSO & EIS
 * (PERKESO)" and this file went red on it — not because the label was missing, but because React
 * escapes a text child, so the markup carries "SOCSO &amp; EIS (PERKESO)". A browser shows the
 * ampersand; a raw `toContain` of the catalogue value does not.
 *
 * Escaping the EXPECTED side rather than unescaping the received one keeps the assertion exact: it
 * still pins that this precise label reached the markup, and a label that is genuinely absent still
 * fails. Loosening it to a substring before the "&" would have let a half-rendered heading pass.
 * The five characters are the ones renderToStaticMarkup escapes in a text child.
 */
const inMarkup = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

describe('3c2f55d7 render check — CompanyPanel in all six locales, real catalogues', () => {
  for (const locale of LOCALES) {
    for (const [label, props] of [
      ['fully configured MY company', richProps],
      ['archived non-MY company with nothing configured', sparseProps],
    ] as const) {
      it(`${locale} · ${label}`, () => {
        const html = render(locale, props);
        expect(html, 'MISSING_MESSAGE in rendered output').not.toContain('MISSING_MESSAGE');
        expect(errors.join('\n'), 'next-intl logged an error').toBe('');
        // Every fold is gone, on both shapes and in every locale.
        expect(html).not.toContain('<details');
        expect(html).not.toContain('<summary');
        // …and the tabs survive.
        expect(html).toContain('role="tablist"');
      });
    }
  }

  it('the previously-folded content is actually IN the markup, not merely un-foldable', () => {
    const html = render('en', richProps);
    // Bank account editor for a saved account (was fold #2).
    expect(html).toContain('value="512345678901"');
    // The blank add-an-account form (was fold #3) — a second Corporate ID box, empty.
    expect(html.match(/name="corporateId"/g) ?? []).toHaveLength(3); // 2 saved + 1 blank
    // Statutory-authority payment setup (was fold #1) — one form per authority in the controlled set.
    // 3c2f55d7 rev 2 — this is now the assertion that keeps the card's Open/Edit HONEST. The editor is
    // collapsed on arrival, but it is collapsed with CSS: every one of the nine forms is still rendered,
    // so a half-typed address survives a collapse and this count cannot be satisfied by unmounting.
    expect(html.match(/name="signatoryPersonId"/g) ?? []).toHaveLength(STATUTORY_AUTHORITIES.length);
    expect(html).toContain('value="ACC-1"');
  });

  /**
   * 3c2f55d7 rev 2 — the card FACE, rendered. The description strings are dynamic keys
   * (`authorityDesc_epf`, …) which no static check can see; the six-locale loop above would catch a
   * MISSING_MESSAGE, and this catches the other failure: a card that renders no description at all.
   */
  it('every statutory body shows its name and its description on the card face', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    for (const a of STATUTORY_AUTHORITIES) {
      expect(html, `authority_${a}`).toContain(inMarkup(en[`authority_${a}`]));
      expect(html, `authorityDesc_${a}`).toContain(inMarkup(en[`authorityDesc_${a}`]));
    }
    // One Open/Edit per body, and nothing native about it.
    const opens = html.split(inMarkup(en.authorityOpen)).length - 1;
    expect(opens, 'one Open-settings control per statutory body').toBe(STATUTORY_AUTHORITIES.length);
  });

  /**
   * The signatory picker is legacy-tolerant: richProps pins a signatory (`gone-person`) who is NOT among
   * the candidates. The searchable field drops a value it cannot find in its own list, which would have
   * turned "edit the phone number" into "clear the authorised signatory" — so the former employee is
   * injected as an option and the hidden input keeps posting the stored id.
   */
  it('keeps a departed signatory posted rather than silently clearing them', () => {
    const html = render('en', richProps);
    expect(html).toContain('name="signatoryPersonId" value="gone-person"');
  });
});
