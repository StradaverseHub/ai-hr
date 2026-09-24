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

/**
 * ⚠️ UPDATED BY 65b22c00 — a MOCK ADDED, NOT AN ASSERTION LOOSENED, and the distinction is the point.
 *
 * The General tab's three field-edit cards are now wrapped in components/tab-save-scope.tsx (one
 * "Save Changes" for the tab, per docs/audits/65b22c00-organization-save-classification.md). That
 * component calls `useRouter()` from next/navigation, which THROWS — "invariant expected app router to
 * be mounted" — outside an App Router context, so every case in this file went red on a render it had
 * always been able to do. The router is the only thing it needs; nothing about what this file asserts
 * changes, and every case below is the one it was before.
 *
 * It is also now a WIDER check than it was: the save bar and its "This Save covers: …" caption render
 * through the real catalogues too, so a components.tabSave key missing from one of the six locales fails
 * here as loudly as an admin.organization one always did.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/admin/organization/c1',
  useSearchParams: () => new URLSearchParams(),
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messagesFor = (l: string) =>
  JSON.parse(readFileSync(join(__dirname, '..', 'messages', `${l}.json`), 'utf8'));

const noop = () => undefined;
const saveTab = async () => ({ ok: true, saved: [] });
const actions = {
  saveGeneralTab: saveTab,
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

/**
 * ── ITEM 3783fd87 — READING A CARD'S FACE OUT OF THE MARKUP ──────────────────────────────────────
 *
 * ⚠️ `<script>` IS STRIPPED AND THE SLICE STOPS AT THE OPEN CONTROL, and both halves are load-bearing.
 * AGENTS §8: a key is not a screen. Every editor on this panel stays MOUNTED (hidden with CSS), so each
 * value appears in the markup twice over — once as the face's text, once as an input's `value=` — and
 * every <select>'s full option list is in there too. A bare `toContain` therefore proves nothing about
 * what is ON SCREEN: it passes on a face that renders nothing at all, and it finds "No Contribution"
 * inside the HRD Corp band picker of a company that has no identity row. So assertions about the face
 * are made on the face SLICE: from each authority row's own <li> up to that row's Open control.
 *
 * The class string is the row's exact opener (EIS adds `pl-6` for its indent and still starts with it),
 * so this cannot pick up an <li> belonging to some other list on the panel.
 */
function cardFaces(html: string, en: Record<string, string>): string[] {
  const chunks = html.replace(/<script\b[\s\S]*?<\/script>/g, '').split('<li class="flex flex-col bg-card').slice(1);
  expect(chunks.length, 'one <li> per statutory body').toBe(STATUTORY_AUTHORITIES.length);
  return chunks.map((chunk, i) => {
    const cut = chunk.indexOf(inMarkup(en.authorityOpen));
    expect(cut, `${STATUTORY_AUTHORITIES[i]}: the row carries its Open control`).toBeGreaterThan(0);
    return chunk.slice(0, cut);
  });
}

/**
 * The summary VALUES, read out of a face's <dd>s. A substring count would not do: the status badge on an
 * unconfigured body reads "Not set up", and "Not set" is a PREFIX of it — so counting the not-set string
 * would count the badge as a value and pass on a face with one value missing. The <dd>s pin exactly
 * which facts are shown and exactly what each one says.
 */
const faceValues = (face: string) => [...face.matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/g)].map((m) => m[1]);

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
   * ── ITEM 3783fd87 — WHAT IS SET, READ OFF THE FACE, WITH NO INTERACTION ──────────────────────────
   *
   * The approved plan promised the reporter a card "showing what is set without opening anything — the
   * employer number and the bank account it is paid from — and saying plainly where nothing is set yet".
   * A source scan cannot prove that: it can see the JSX and still miss a card whose summary renders
   * empty, or one whose values only appear once the editor is open.
   *
   * ⚠️ `<script>` IS STRIPPED FIRST, and that is the whole reason this case is worth writing. AGENTS §8:
   * a key is not a screen. The editor below the face is MOUNTED and merely hidden with CSS, so every
   * value on this panel appears in the markup twice over — once as the face's text and once as an
   * input's `value=` — and `toContain('E123')` would pass on a face that renders nothing at all. So the
   * assertions below are made on the FACE SLICE: the markup from the card's opening `<li>` up to its
   * Open control, with scripts removed. A value found there was on screen before anybody clicked.
   */
  it('shows each body\u2019s employer number and paying account on the face, before any interaction', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);

    const faces = cardFaces(html, en);

    // richProps: statutory.epfEmployerNo = 'E123', authority[0] (= epf) accountNo 'ACC-1' paid from bp1
    // ("Payroll — Maybank" / 512345678901). All three are on the face, each under its own caption.
    const epfFace = faces[STATUTORY_AUTHORITIES.indexOf('epf')];
    expect(epfFace, 'the EPF employer number, captioned').toContain(inMarkup(en.epfEmployerNo));
    expect(epfFace, 'the payment reference, captioned').toContain(inMarkup(en.authorityAccountNo));
    expect(epfFace, 'the account it is paid from, captioned').toContain(inMarkup(en.authorityBankAccount));
    expect(faceValues(epfFace)).toEqual(['E123', 'ACC-1', inMarkup('Payroll — Maybank · 512345678901')]);

    // …and a body with NOTHING on file says so in words rather than showing a blank. LHDN has no
    // authority row in richProps but the company DOES carry its filing number, so this face proves both
    // halves at once: the number that exists is shown, the two that do not are named as not set.
    const lhdnFace = faces[STATUTORY_AUTHORITIES.indexOf('lhdn')];
    expect(lhdnFace).toContain(inMarkup(en.lhdnENumber));
    expect(faceValues(lhdnFace)).toEqual(['L123', en.authorityValueNotSet, en.authorityValueNotSet]);

    // EIS carries NO filing line at all: it has no number of its own, it files under SOCSO's PERKESO
    // code, and inventing a third caption for it would say something untrue. Two facts, not three.
    expect(faceValues(faces[STATUTORY_AUTHORITIES.indexOf('eis')])).toHaveLength(2);
  });

  /**
   * The HRD Corp band is the one summary value that could be INVENTED, so it is pinned on both sides.
   * Payroll resolves a missing `company_statutory_my` row to 'not_registered' and charges nothing — but
   * printing "Not registered" for a company that has no row at all would assert a registration decision
   * nobody made. sparseProps has `statutory: null`; richProps has `hrdfStatus: 'mandatory'`.
   */
  it('states HRD Corp\u2019s band only when the identity row actually carries one', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const strip = (h: string) => h.replace(/<script\b[\s\S]*?<\/script>/g, '');

    const hrdfFace = (props: unknown) => cardFaces(render('en', props), en)[STATUTORY_AUTHORITIES.indexOf('hrdf')];

    // richProps carries hrdfStatus: 'mandatory' — a real decision on file, so the face states it.
    expect(faceValues(hrdfFace(richProps))[0]).toBe(inMarkup(en.hrdfMandatory));

    /**
     * A MALAYSIAN company with NO `company_statutory_my` row at all. (sparseProps is the wrong shape for
     * this: it is an SG company, and a country with no pack renders `noStatutoryPack` instead of the
     * authority list, so it could never have shown or hidden an HRDF band either way.)
     *
     * Payroll resolves a missing row to 'not_registered' and charges nothing — but printing that band
     * here would assert a registration decision nobody made (§8: an absent box asserts nothing). So the
     * face says "Not set", for this fact and for every other one.
     */
    const bare = hrdfFace({ ...richProps, statutory: null, statutoryAuthorities: [], bankProfiles: [] });
    expect(faceValues(bare), 'an absent identity row is never read as a band').toEqual([
      en.authorityValueNotSet,
      en.authorityValueNotSet,
      en.authorityValueNotSet,
    ]);
    for (const band of [en.hrdfNotRegistered, en.hrdfMandatory, en.hrdfOptional]) {
      expect(bare, `the face must not claim ${band}`).not.toContain(inMarkup(band));
    }
    // The empty-state the plan said to reuse rather than reinvent, for a company with no bank accounts.
    expect(strip(render('en', { ...richProps, bankProfiles: [] }))).toContain(
      inMarkup(en.authoritiesNoBankAccounts),
    );
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
