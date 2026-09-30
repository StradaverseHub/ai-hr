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
  // 15e5bd93 rev 2 (r353) — `saveStatutoryTab` STOOD HERE and the consolidated statutory Save it named is
  // retired: the reporter contested the in-tab editing it existed to consolidate. The Statutory tab's
  // registrations card submits itself again, and the body editors are a dedicated screen with its own
  // render guard. ⚠️ TWO FILES SINCE r355, and the names were also written with the wrong extension here —
  // a `.test.tsx` that is not `.dom.` matches NEITHER vitest project: test/statutory-setup-screen-render.test.ts
  // (the statutory screen) and test/statutory-body-screen-render.test.ts (one body's card on it).
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
 * ── ITEM 3783fd87 — READING A BODY'S FACE OUT OF THE MARKUP ──────────────────────────────────────
 *
 * ⚠️ `<script>` IS STRIPPED, and that half is load-bearing. AGENTS §8: a key is not a screen. Every
 * editor on this panel stays MOUNTED (hidden with CSS), so each value appears in the markup twice over —
 * once as the face's text, once as an input's `value=` — and every <select>'s full option list is in
 * there too. A bare `toContain` therefore proves nothing about what is ON SCREEN: it passes on a face
 * that renders nothing at all, and it finds "No Contribution" inside the HRD Corp band picker of a
 * company that has no identity row. So assertions about the face are made on the face SLICE.
 *
 * ⚠️ UPDATED BY 15e5bd93 (r352) — THE SLICE NO LONGER STOPS AT AN "Open settings" CONTROL, because the
 * per-body fold it stopped at was replaced. The row IS the face, end to end, and it is identified by
 * `data-statutory-body="<key>"` rather than by a Tailwind class string — a stronger handle, since a class
 * string changes whenever the row is restyled while the attribute says what the element IS.
 *
 * ⚠️ 15e5bd93 REVISION 2 (r353) MAKES THE SLICE EXACT RATHER THAN MERELY TIGHT. The body's fields are not
 * on this panel at all any more — they are a dedicated screen — so the row cannot include anything from an
 * editor even in principle, and the `<script>` strip below stops being the load-bearing half of the helper
 * for the STATUTORY rows (it still is for the rest of the panel, where every tab stays mounted). The row
 * does now contain one control: the "Open settings" link, which is the reporter's first approved point.
 */
function cardFaces(html: string): string[] {
  const clean = html.replace(/<script\b[\s\S]*?<\/script>/g, '');
  const rows = [...clean.matchAll(/<li[^>]*\sdata-statutory-body="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
  expect(
    rows.map((m) => m[1]),
    'one rail row per statutory body, in the controlled set’s own order',
  ).toEqual([...STATUTORY_AUTHORITIES]);
  return rows.map((m) => m[2]);
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
    /**
     * ⚠️ THE STATUTORY HALF OF THIS CASE MOVED WITH ITS SUBJECT (15e5bd93 rev 2, r353) AND IS ASSERTED
     * NEGATIVELY HERE. It counted one payment form per authority — first to keep the card's Open/Edit
     * honest (collapsed with CSS, never unmounted), then because r352's one Save read every body out of
     * the DOM. Neither reason survives the reporter's contest: the bodies are edited on a dedicated screen
     * now — and r372 put every body's form back on that ONE screen, the per-body page r355 added having
     * been contested as "an unnecessary intermediate page". So the forms are counted in
     * test/statutory-body-screen-render.test.ts and test/statutory-setup-screen-render.test.ts.
     *
     * What this file must still prove is that the fields did not get left behind in BOTH places. Two
     * screens writing `company_statutory_authority`, one of which has no Save, is worse than the fold ever
     * was — so the panel is asserted to carry none of them.
     */
    expect(html.match(/name="signatoryPersonId"/g) ?? [], 'no signatory control on the panel').toHaveLength(0);
    expect(html, 'and no payment reference input').not.toContain('name="accountNo"');
    // The VALUE is still on screen, as text on the row's summary — which is 3783fd87's promise, unchanged.
    expect(html).toContain('ACC-1');
  });

  /**
   * 3c2f55d7 rev 2 — the body's FACE, rendered. The description strings are dynamic keys
   * (`authorityDesc_epf`, …) which no static check can see; the six-locale loop above would catch a
   * MISSING_MESSAGE, and this catches the other failure: a row that renders no description at all.
   *
   * ⚠️ THE "Open settings" HALF OF THIS CASE HAS NOW BEEN WRITTEN THREE WAYS, AND THE THIRD IS THE FIRST
   * AGAIN. 3c2f55d7 rev 2 counted one Open control per body (the fold). r352 asserted there were NONE (the
   * fold was gone). r353 counts one per body again — but as a LINK to the dedicated screen, which is the
   * reporter's first approved point in their own words: "Open Settings" becomes a link to a real page.
   *
   * The count matters and so does the ELEMENT. A row per body with one link each is the claim; a single
   * link somewhere on the tab would leave seven rows with no way out of them, and a toggle would be the
   * disclosure the last two rounds removed. So both are asserted, on the rendered markup.
   */
  it('every statutory body shows its name, its description and its own way through to the setup screen', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    const faces = cardFaces(html);
    for (const [i, a] of STATUTORY_AUTHORITIES.entries()) {
      expect(faces[i], `authority_${a}`).toContain(inMarkup(en[`authority_${a}`]));
      expect(faces[i], `authorityDesc_${a}`).toContain(inMarkup(en[`authorityDesc_${a}`]));
      // ONE LINK PER ROW, to the ONE route for the whole setup — there is no route per authority.
      expect(faces[i], `${a}: Open settings`).toContain(inMarkup(en.authorityOpen));
      expect(faces[i], `${a}: links to the dedicated screen`).toContain('href="/admin/organization/c1/statutory"');
      expect(faces[i], `${a}: as a link, not a toggle`).not.toContain('aria-expanded');
    }
    expect(
      (html.match(/data-statutory-setup-link="/g) ?? []).length,
      'one per body, and no stray extras',
    ).toBe(STATUTORY_AUTHORITIES.length);
    // `authorityClose` only ever captioned a fold, so it must not reach the screen.
    expect(html, 'no Close survives').not.toContain(inMarkup(en.authorityClose));
    // NOT asserted here: "no aria-expanded anywhere in the markup". The panel declares none (pinned in
    // test/company-panel-bank-statutory-layout.test.ts), but other comboboxes on the General tab render
    // their own — a blanket rendered-markup ban would fail on a control that is not a disclosure at all.
  });

  /**
   * ⚠️ REPLACES TWO r352 CASES, AND IT IS THE SAME QUESTION ASKED OF THE OPPOSITE ANSWER.
   *
   * "fills the workspace with exactly one body, and keeps the other seven mounted but hidden" and
   * "renders the statutory tab Save bar, with the registrations card inside its scope" both described a tab
   * that EDITED the bodies. The reporter contested that ("Do not expand the statutory settings directly
   * within the existing Statutory tab"), so the workspace and the scope are gone from this panel and their
   * successors are counted in test/statutory-setup-screen-render.test.ts (the screen) and
   * test/statutory-body-screen-render.test.ts (one body's card on it).
   *
   * Asserted on the RENDER rather than at source because "is this form inside that scope?" and "is this
   * field on this screen?" are DOM questions, and because the failure this replaces is not a missing
   * feature — it is a HALF-REMOVED one: a workspace pane left mounted with no Save above it, or a section
   * marker with no scope to read it, renders fine, passes tsc and quietly cannot save.
   */
  it('the Statutory tab renders NO body editor and NO consolidated Save — only the registrations card', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);
    // The workspace is gone, not hidden: no pane, no marker, no scope.
    expect(html, 'no workspace pane survives').not.toContain('data-statutory-workspace');
    expect(html, 'and no statutory scope').not.toContain('data-tab-save-scope="statutory"');
    expect(html, 'nor any section marker for one to own').not.toContain('data-save-section="identity"');
    for (const a of STATUTORY_AUTHORITIES) {
      expect(html, `no section marker for ${a}`).not.toContain(`data-save-section="${a}"`);
    }
    // The General tab's scope is untouched: this round removed one scope, not the pattern.
    expect(html, "General's Save bar stays").toContain('data-tab-save-scope="general"');

    // THE REGISTRATIONS CARD IS STILL HERE, still editable, and it has its own Save again.
    expect(html).toContain('name="ssmRegistrationNo"');
    expect(html).toContain('name="myinvoisTin"');
    expect(html, 'the retired caption, back in service').toContain(inMarkup(en.saveStatutoryIdentity));
    // …and it did NOT drift onto General. Pinned by position against the General scope's own bar, which is
    // the failure 65b22c00 wrote its version of this case against.
    const generalBar = html.indexOf('data-tab-save-bar');
    expect(html.indexOf('name="ssmRegistrationNo"'), 'after the General bar, i.e. on another tab').toBeGreaterThan(
      generalBar,
    );

    // NO PER-BODY SAVE ON THIS TAB EITHER: the bodies are not edited here at all.
    expect(html, 'no per-body Save reached the tab').not.toContain(inMarkup(en.authoritySave));
    expect(html, 'and no Clear, which moved with the editor it belongs to').not.toContain(
      inMarkup(en.authorityClear),
    );
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
   * a key is not a screen. The editors are MOUNTED and merely hidden with CSS, so every value on this
   * panel appears in the markup twice over — once as the face's text and once as an input's `value=` —
   * and `toContain('E123')` would pass on a face that renders nothing at all. So the assertions below are
   * made on the FACE SLICE: the body's own rail `<li>`, with scripts removed.
   *
   * ⚠️ 15e5bd93 (r352) MAKES THIS CASE MORE IMPORTANT, NOT LESS. The redesign moves a body's fields into a
   * workspace that shows ONE body at a time, so if the values ever left the rail, "compare EPF's employer
   * number with LHDN's" would be back to two clicks and a memory — which is the exact complaint 3783fd87
   * was raised for. The values stay on the rail, and this is what says so.
   */
  it('shows each body\u2019s employer number and paying account on the face, before any interaction', () => {
    const en = messagesFor('en').admin.organization as Record<string, string>;
    const html = render('en', richProps);

    const faces = cardFaces(html);

    // richProps: statutory.epfEmployerNo = 'E123', authority[0] (= epf) accountNo 'ACC-1' paid from bp1
    // ("Payroll — Maybank" / 512345678901). All three are on the face, each under its own caption.
    const epfFace = faces[STATUTORY_AUTHORITIES.indexOf('epf')];
    expect(epfFace, 'the EPF employer number, captioned').toContain(inMarkup(en.epfEmployerNo));
    expect(epfFace, 'the payment reference, captioned').toContain(inMarkup(en.authorityAccountNo));
    expect(epfFace, 'the account it is paid from, captioned').toContain(inMarkup(en.authorityBankAccount));
    /**
     * AND THE SUMMARY IS VISIBLE, not merely present. Everything on this panel is mounted and hidden
     * with CSS rather than unmounted, which is deliberate — but it means "in the markup" and "on the
     * screen" are different claims here, and the promise made to the reporter was the second one. A
     * `hidden` (or `sr-only`) class on this list would satisfy every other assertion in this case while
     * putting the values straight back behind the click they were taken out of.
     */
    const dlTag = /<dl class="([^"]*)"/.exec(epfFace);
    expect(dlTag, 'the summary is a <dl> on the face').not.toBeNull();
    expect(dlTag![1].split(/\s+/), 'the summary is not hidden from the reader').not.toContain('hidden');
    expect(dlTag![1].split(/\s+/)).not.toContain('sr-only');
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

    const hrdfFace = (props: unknown) => cardFaces(render('en', props))[STATUTORY_AUTHORITIES.indexOf('hrdf')];

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
   * ⚠️ MOVED, NOT DROPPED (15e5bd93 rev 2, r353). The signatory picker's legacy tolerance — a stored
   * signatory who has since left is injected as an option so the hidden input keeps POSTING their id,
   * because `EmployeeSearchField` drops a value it cannot find in its own list and "edit the phone number"
   * would otherwise become "clear the authorised signatory" — is asserted where the picker is:
   * test/statutory-body-screen-render.test.ts and test/15e5bd93-statutory-screen.dom.test.tsx.
   *
   * What this file keeps is the half that belongs to THIS panel: the departed signatory must not be
   * rendered here at all, because there is no control here to post them from. `richProps` still pins
   * `gone-person`, so a picker that crept back onto the panel fails.
   */
  it('renders no signatory control at all — the picker is on the dedicated statutory screen', () => {
    const html = render('en', richProps);
    expect(html).not.toContain('name="signatoryPersonId"');
    expect(html, 'not even as a value left behind').not.toContain('gone-person');
  });
});
