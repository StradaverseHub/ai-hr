/**
 * r259 stage one (board item 9583deac) — MY PROFILE IS THE PERSONNEL RECORD'S SHAPE, MINUS A WRITTEN-DOWN LIST.
 *
 * The reporter's complaint was that "an employee and the HR team are looking at two different shapes of
 * the same person", and the approved plan answers it with two promises. This file holds both to account,
 * because neither is visible to types, to a 200, or to any other test in the suite:
 *
 *   1. THE SAME TABS AND THE SAME SECTION NAMES. Not similar words — the SAME catalogue keys. Every tab
 *      label, section title and field label My Profile renders is a `people.detail.*` key that the
 *      Personnel screen (or a component both screens mount) also renders. Rename one on the Personnel side
 *      and this goes red, which is the only arrangement under which the two cannot drift apart again.
 *
 *   2. THE FIELD-VISIBILITY LIST IS A DELIVERABLE, NOT AN IMPLEMENTATION DETAIL. The plan promises the
 *      reporter, in writing: "The list of exactly which fields are hidden is written down and shown to you
 *      before stage one is built, not decided as we go." So the manifest (app/me/visible-fields.ts), the
 *      screen and the document (docs/me-profile-field-visibility.md) are pinned to each other here. A
 *      withheld field quietly added to the read is the difference between a self-service screen and a
 *      data leak, and it is exactly the kind of change that looks harmless in a diff.
 *
 * Source-static, deliberately (precedent: test/me-tabs.test.ts, test/ea-pdf-i18n-keys.test.ts). What is
 * being asserted is a relationship BETWEEN FILES that cannot see each other — the page, the manifest, the
 * Personnel screen, six message catalogues and a markdown document — and no runtime has all five in hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ME_HIDDEN_FIELDS,
  ME_SECTION_TITLE_KEY,
  ME_TABS,
  ME_TAB_LABEL_KEY,
  ME_UNRENDERED_PERSONNEL_FIELDS,
  ME_VISIBLE_FIELD_LABEL_KEYS,
  ME_WITHHELD_COLUMNS,
} from '../app/me/visible-fields';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const ME_PAGE = read('app/me/page.tsx');
const ME_RECORD = read('app/me/record.ts');
const READ_FIELD = read('app/me/read-field.tsx');
// r260 — the request form moved off the page and into its own card, mounted once per tab. Cases that
// used to grep ME_PAGE for the form now grep this.
const REQUEST_CARD = read('app/me/request-change-card.tsx');
const DOC = read('docs/me-profile-field-visibility.md');
const PERSONNEL_PAGE = read('app/admin/personnel/[employmentId]/page.tsx');

/**
 * The Personnel side is not ONE file. Several of the field labels My Profile reuses are rendered by
 * components the Personnel page mounts rather than by the page itself (Gender / Marital Status by
 * person-details-fields, Date of Birth / Age by birth-date-fields, EPF by epf-registration-fields, and so
 * on — the 35b7af0a shared field groups). Scanning only the page would report those as "not on the
 * Personnel screen", which is false and would make this guard nag rather than protect.
 */
const PERSONNEL_COMPONENTS = [
  'components/personnel-identity.tsx',
  'components/identity-fields.tsx',
  'components/person-details-fields.tsx',
  'components/birth-date-fields.tsx',
  'components/epf-registration-fields.tsx',
  'components/socso-eis-fields.tsx',
  'components/identity-tax-card.tsx',
  // r393 (685d2380 step 3b) — the card's Income Tax Resident select moved into its own shared control.
  'components/tax-residency-field.tsx',
  'components/bank-account-fields.tsx',
  // r260 — /me now names the PCB category with Personnel's own `taxCategoryLabel` key rather than a
  // second `me.pcbCategory` wording of its own, and this is the shared group that renders it on the
  // Personnel card (35b7af0a group six). Without it here the manifest→Personnel case would report the
  // key as "rendered nowhere on the Personnel screen", which is false.
  'components/tax-category-field.tsx',
  'components/bank-info-card.tsx',
  // r393 (685d2380 step 3a) — the card's custom-holder ticks moved into their own shared group.
  'components/custom-holder-fields.tsx',
  // r393 (685d2380 step 2) — "How This Employee Is Paid" moved off the page into its own shared group;
  // without it here `people.detail.paymentMethod` reads as rendered nowhere on the Personnel screen.
  'components/payment-method-field.tsx',
  'components/salary-history-table.tsx',
  'components/pay-structure-fields.tsx',
  // a72610af — five more shared groups joined the list when the Create New Employee draft was widened to
  // the record's own fields. The labels did not move namespace and the Personnel screen still renders
  // every one of them; only the FILE they are written in changed, which is exactly the reason this list
  // exists. Omitting them would make the manifest report Salutation, the passport block, the probation
  // and notice periods, the OKU claims and the HRDF switch as "rendered nowhere on the Personnel
  // screen" — false, and the kind of nagging that gets a guard deleted.
  'components/person-name-fields.tsx',
  'components/passport-fields.tsx',
  'components/employment-period-fields.tsx',
  'components/employer-bears-fields.tsx',
  'components/tax-relief-fields.tsx',
  // da7463b4 (r336) — the SEVENTH shared group, and it arrived the same way as the five above: the draft
  // employee screen was given the record's two address blocks, so the permanent/correspondence fields were
  // extracted out of the Personnel page into one component that BOTH screens mount. The Personnel card
  // renders exactly the same seven labels it always did — addressLine1..3, postcode, city, stateLabel,
  // country — in the same namespace; only the file changed. This list is the reason that is not a failure.
  'components/address-fields.tsx',
];
const PERSONNEL_SRC = PERSONNEL_PAGE + PERSONNEL_COMPONENTS.map(read).join('\n');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const CATALOGS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

function leaf(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
/** Does this source render `t('<key>')` / `tp('<key>')` anywhere? */
const renders = (src: string, key: string) =>
  new RegExp(`\\b(?:t|tp)\\(\\s*'${key.replace(/\./g, '\\.')}'`).test(src);

const ALL_MANIFEST_KEYS = [
  ...Object.values(ME_TAB_LABEL_KEY),
  ...Object.values(ME_SECTION_TITLE_KEY).flat(),
  ...Object.values(ME_VISIBLE_FIELD_LABEL_KEYS).flat(),
];

describe('r259 — My Profile carries the Personnel record’s shape', () => {
  it('wires exactly the six tabs the plan names, in the order it names them', () => {
    expect([...ME_TABS]).toEqual(['profile', 'job', 'bankStatutory', 'payroll', 'family', 'documents']);
    // The strip is built FROM the manifest, so the screen and the list cannot name different tabs.
    expect(ME_PAGE).toContain('tabs={ME_TABS.map((key) => ({ key, label: tp(ME_TAB_LABEL_KEY[key]) }))}');
    // …and every one of them has a panel. A tab with no panel renders the shell's empty state, which
    // would look like a broken screen rather than a missing build.
    for (const key of ME_TABS) {
      expect(new RegExp(`^\\s+${key}: `, 'm').test(ME_PAGE), `no panel wired for tab '${key}'`).toBe(true);
    }
    // The five tabs it replaces are gone — a leftover would be the two-shapes complaint reopening.
    for (const dead of ["key: 'overview'", "key: 'pay'", "key: 'performance'"]) {
      expect(ME_PAGE.includes(dead), `${dead} belongs to the arrangement that was replaced`).toBe(false);
    }
  });

  it('names every tab, section and field with PERSONNEL’S OWN key — not a second wording', () => {
    const notOnPersonnel = ALL_MANIFEST_KEYS.filter((k) => !renders(PERSONNEL_SRC, k));
    expect(
      notOnPersonnel,
      `these people.detail keys are named by My Profile but rendered nowhere on the Personnel screen — ` +
        `either the Personnel side renamed them (fix the manifest) or My Profile minted a second wording ` +
        `for a field HR already names (fix the page): ${notOnPersonnel.join(', ')}`,
    ).toEqual([]);
  });

  it('and My Profile actually renders each of them', () => {
    // The other direction: a key listed in the manifest and in the document, but never put on screen, is
    // a promise to the reporter that the page does not keep. The six TAB labels are exempt because the
    // strip resolves them through `ME_TAB_LABEL_KEY[key]` rather than as literals — which the case above
    // asserts by its exact text, so they are covered, not skipped.
    const tabLabelKeys = new Set(Object.values(ME_TAB_LABEL_KEY));
    const notOnScreen = ALL_MANIFEST_KEYS.filter((k) => !tabLabelKeys.has(k) && !renders(ME_PAGE, k));
    expect(notOnScreen, `named in the manifest but never rendered: ${notOnScreen.join(', ')}`).toEqual([]);
  });

  it('accounts for EVERY field the Personnel record renders — on screen, or on the withheld list', () => {
    /**
     * THE DIRECTION THAT SILENTLY DRIFTS, and the one this round was raised about one level down.
     *
     * The two cases above run manifest→Personnel and manifest→screen: they catch a key My Profile names
     * that HR does not, and a key named but never rendered. Neither catches the opposite — a field ADDED
     * to a Personnel group that never reaches the employee's copy of their own record. Nothing goes red,
     * the two screens quietly become different shapes again, and the complaint that opened this item
     * comes back.
     *
     * So the Personnel screen's OWN field list is read out of its source — every `label={t('…')}` on the
     * page and on the shared field groups it mounts — and each key must be either rendered on My Profile
     * or on `ME_UNRENDERED_PERSONNEL_FIELDS` with a reason. Adding a field to Personnel is then a choice
     * to be made in writing, which is the whole point.
     *
     * When this fails: put the field on My Profile if the employee may see it, or add it to the map with
     * a sentence saying why not. Do not delete the case.
     */
    const labelled = new Set<string>();
    for (const m of PERSONNEL_SRC.matchAll(/label=\{t\(\s*'([A-Za-z0-9_.]+)'\s*\)\}/g)) labelled.add(m[1]);
    // components/pay-structure-fields.tsx labels its three selects with a bare <span> rather than the
    // shared `Field` component, so the pattern above cannot see them. Named here rather than by widening
    // the pattern: every other <span> on that page is a hint, an empty-state or a legend, and matching
    // those would turn this guard into a nag about text that is not a field at all.
    for (const spanLabelled of ['payMode', 'paymentTerm', 'rateAmount']) labelled.add(spanLabelled);
    // a72610af — components/employment-period-fields.tsx picks its label out of a four-entry lookup
    // (`<Field label={label}>`) rather than inlining `t('…')` in the attribute, because ONE component
    // renders all four periods and a computed `employmentInfo.${key}` would be invisible to
    // test/i18n-coverage.test.ts check C. The four keys are literals inside that lookup, so they are
    // named here for the same reason the three above are: widening the pattern to catch them would make
    // it match every hint and legend on the page and turn this guard into a nag.
    for (const lookupLabelled of [
      'employmentInfo.probationPeriod',
      'employmentInfo.extendedProbationPeriod',
      'employmentInfo.noticeBeforeConfirmation',
      'employmentInfo.noticeAfterConfirmation',
    ]) {
      labelled.add(lookupLabelled);
    }

    expect(labelled.size, 'the Personnel field list came back empty — the extraction pattern is broken')
      .toBeGreaterThan(100);

    const shown = new Set(Object.values(ME_VISIBLE_FIELD_LABEL_KEYS).flat());
    const unaccounted = [...labelled].filter(
      (k) => !shown.has(k) && !(k in ME_UNRENDERED_PERSONNEL_FIELDS),
    );
    expect(
      unaccounted.sort(),
      'the Personnel record renders these fields and My Profile accounts for neither showing nor ' +
        'withholding them — an employee would never see them on their own record and nothing would say ' +
        `so: ${unaccounted.join(', ')}`,
    ).toEqual([]);

    // The map may not rot the other way either: a key that stopped being a Personnel field, or that is
    // now shown, is a stale excuse.
    const stale = Object.keys(ME_UNRENDERED_PERSONNEL_FIELDS).filter((k) => !labelled.has(k) || shown.has(k));
    expect(stale, `these are excused but are no longer withheld Personnel fields: ${stale.join(', ')}`).toEqual([]);
    for (const [key, why] of Object.entries(ME_UNRENDERED_PERSONNEL_FIELDS)) {
      expect(why.length, `${key} is excused with no reason given`).toBeGreaterThan(30);
    }
  });

  it('shows the address it saves — one column family on the card, not two', () => {
    /**
     * THE BLOCKER THIS CASE EXISTS FOR. The first cut of this round rendered HR's Permanent and
     * Correspondence address bands read-only and put the contact self-edit fold-out directly beneath
     * them — but that form posts the LEGACY `addressLine1..country` names, and `core/profile.ts
     * updateOwnContact` writes only those columns. The employee saw two addresses on one card, edited
     * one, pressed Save, and neither of the addresses in front of them moved — while the phone and
     * personal email in the same form did, because those columns are shared. Two address families on one
     * card is also the second copy the approved plan promised the reporter would never exist.
     *
     * The property, stated so it cannot be satisfied by a coincidence: every address field the form
     * POSTS must be displayed on the same card, read from the SAME object, field by field. The runtime
     * half — plant a different address in each family, prove the card shows the one the Save button
     * changes — is in test/me-profile-scope.test.ts against a live database.
     */
    const formStart = ME_PAGE.indexOf('action={myUpdateContact}');
    expect(formStart, 'the contact self-edit form is gone from /me').toBeGreaterThan(0);
    const form = ME_PAGE.slice(formStart, ME_PAGE.indexOf('</form>', formStart));

    const posted = [...form.matchAll(/name="([A-Za-z0-9]+)"/g)].map((m) => m[1]);
    const ADDRESS = ['addressLine1', 'addressLine2', 'addressLine3', 'postcode', 'city', 'state', 'country'];
    expect(
      ADDRESS.filter((f) => !posted.includes(f)),
      'the contact form no longer posts the whole home address',
    ).toEqual([]);

    // Displayed, from the one object — and defaulted from that same object, so the value in the input is
    // the value in the field above it by construction rather than by two reads agreeing.
    const notDisplayed = ADDRESS.filter((f) => !ME_PAGE.includes(`c.homeAddress.${f}`));
    expect(
      notDisplayed,
      `these address fields are saved by the card's own Save button but are not displayed on it: ` +
        notDisplayed.join(', '),
    ).toEqual([]);
    for (const f of ADDRESS) {
      expect(
        form.includes(`defaultValue={c.homeAddress.${f} ?? ''}`),
        `the ${f} input is defaulted from something other than the object the card displays`,
      ).toBe(true);
    }

    // And the second family is not on the screen at all, in any spelling.
    for (const other of ['c.permanent', 'c.correspondence', 'permanentAddress', 'correspondenceAddress']) {
      expect(
        ME_PAGE.includes(other),
        `/me renders ${other} — a second address family the Save button below it cannot change`,
      ).toBe(false);
    }
    // Same rule for the emergency contact: the fold-out posts an address, so the register must print one.
    expect(posted.includes('emergencyContactAddress')).toBe(true);
    expect(ME_PAGE.includes("tp('emergency.address')"), 'the emergency address is saved but never shown').toBe(true);
  });

  it('keeps the pay of EVERY concurrent position, and says which company each figure belongs to', () => {
    /**
     * A LAYOUT CHANGE MAY NOT DELETE A FIGURE. The retired Overview tab printed "Basic + allowance" for
     * each of an employee's concurrent employments (ADR-0009 — two active contracts across the group's
     * companies is a real, seeded case). The first cut of this round moved that list onto the Employment
     * tab and dropped the figures on the way, while the Payroll tab's Basic Salary card shows the CURRENT
     * employment's compensation row only — so the second employment's contractual pay rendered nowhere at
     * all, on neither the withheld list nor the not-built list. Withholding is a decision the reporter
     * reads; losing something in a move is not.
     *
     * When this fails: put the figure back, or add it to ME_HIDDEN_FIELDS with a reason the reporter can
     * read. Do not delete the case.
     */
    const start = ME_PAGE.indexOf("t('myPositions'");
    expect(start, 'the concurrent-positions card is gone from /me').toBeGreaterThan(0);
    const card = ME_PAGE.slice(start, ME_PAGE.indexOf('</Card>', start));
    expect(
      card.includes("t('basicPlusAllowance')"),
      'the concurrent-positions card no longer names the pay it shows',
    ).toBe(true);
    expect(
      /rm\(Number\(e\.basic \?\? 0\) \+ Number\(e\.allowance \?\? 0\)\)/.test(card),
      'the concurrent-positions card no longer shows each position’s pay — the second employment’s ' +
        'contractual pay would render nowhere on this screen',
    ).toBe(true);
    // …and the single-employment figure on the Payroll tab says whose contract it is.
    const comp = ME_PAGE.indexOf("<ReadCard id=\"section-compensation\"");
    expect(comp, 'the Basic Salary card is gone from /me').toBeGreaterThan(0);
    const compCard = ME_PAGE.slice(comp, ME_PAGE.indexOf('</ReadCard>', comp));
    expect(
      compCard.includes("tp('employmentInfo.company')"),
      'the Basic Salary card shows an unlabelled figure — an employee with two employments cannot tell ' +
        'which contract it belongs to',
    ).toBe(true);
  });

  it('every key it borrows resolves in ALL SIX catalogues', () => {
    // Borrowing a key means inheriting its translations. A key that exists in en.json only would render
    // the English word on a Malay screen, which is the failure mode i18n-coverage check A exists for —
    // but check A only sees keys that ARE in en.json, and cannot see that this screen depends on them.
    const report: string[] = [];
    for (const loc of LOCALES) {
      for (const key of ALL_MANIFEST_KEYS) {
        const v = leaf(leaf(CATALOGS[loc], 'people.detail'), key);
        if (typeof v !== 'string' || v === '') report.push(`${loc}: people.detail.${key}`);
      }
    }
    expect(report, report.join('\n')).toEqual([]);
  });

  it('renders a read-only value the way the Personnel screen renders one', () => {
    // Personnel's own view-only renderer (8ebabbf2 / 89ea527b — `readOnlyValue` on the Employment tab) is
    // a DISABLED input carrying aria-readonly and no `name`. Matching it is not cosmetics: the missing
    // `name` is what stops a value being picked up by a sibling form, and /me still has two real forms on
    // it. If either side changes its idiom, the two screens stop looking like one record.
    for (const marker of ['disabled', 'readOnly', 'aria-readonly="true"', 'inputCls']) {
      expect(READ_FIELD.includes(marker), `ReadField is missing ${marker}`).toBe(true);
      expect(PERSONNEL_PAGE.includes(marker), `the Personnel readOnlyValue no longer uses ${marker}`).toBe(true);
    }
    expect(/name=/.test(READ_FIELD), 'a read-only field must carry no name — it could be submitted').toBe(false);
  });
});

describe('r259 — the employee sees ONLY their own record', () => {
  it('takes no employment id from anywhere the client controls', () => {
    // The whole security property of this screen. `myProfileRecord` resolves the employment from the
    // session; there is no id segment on /me and none of the accepted search params is an id.
    expect(ME_RECORD).toContain('const me = await myEmployment(ctx);');
    expect(
      /export async function myProfileRecord\(ctx: SessionContext\)/.test(ME_RECORD),
      'myProfileRecord must take the session and nothing else — a second parameter is a way in',
    ).toBe(true);
    const params = ME_PAGE.slice(ME_PAGE.indexOf('searchParams: Promise<'), ME_PAGE.indexOf('>;', ME_PAGE.indexOf('searchParams: Promise<')));
    for (const forbidden of ['employmentId', 'personId', 'employeeId', 'id?']) {
      expect(params.includes(forbidden), `/me accepts a '${forbidden}' search param`).toBe(false);
    }
  });

  it('offers no way to reach anybody else', () => {
    // The plan says it out loud: "Employees see only their own record. There is no way to search for or
    // open anybody else." The Personnel screen's employee picker must never appear here.
    for (const dead of ['EmployeeSwitcher', 'listEmployees', 'employeeSearch', '/admin/personnel/']) {
      expect(ME_PAGE.includes(dead), `/me must not mount ${dead}`).toBe(false);
    }
    expect(ME_RECORD.includes('listEmployees')).toBe(false);
  });

  it('never projects a withheld column out of the admin reads', () => {
    // `employeeDetail` and the statutory pack read return the ADMINISTRATOR's row. The redaction is the
    // explicit projection in record.ts, so a `{...emp}` — or one more field appended in a hurry — is what
    // this case exists to catch.
    //
    // DRIVEN BY THE MANIFEST, NOT BY A LIST OF ITS OWN. This used to be a hand-written array of twelve
    // column names, which meant the guard protected twelve columns while the docstring above claimed it
    // protected the withheld class — and `payrollPolicyStatus` and `holidayGroupName`, which
    // app/me/record.ts's own comment names as deliberately not projected, could be added to the
    // projection with both this file and test/me-profile-scope.test.ts staying green. Every name below
    // now comes from `ME_HIDDEN_FIELDS[].columns`, so widening the guard is the same act as writing the
    // reason down for the reporter.
    expect(ME_WITHHELD_COLUMNS.length, 'the withheld list names no columns at all').toBeGreaterThan(20);
    for (const column of ME_WITHHELD_COLUMNS) {
      expect(ME_RECORD.includes(`${column}:`), `record.ts projects the withheld field ${column}`).toBe(false);
      expect(ME_PAGE.includes(`.${column}`), `/me renders the withheld field ${column}`).toBe(false);
    }
    // The spread that would defeat every line above.
    expect(/\.\.\.emp\b/.test(ME_RECORD), 'record.ts spreads the whole admin row').toBe(false);
    expect(/\.\.\.statutoryRow\b/.test(ME_RECORD), 'record.ts spreads the whole statutory row').toBe(false);
  });

  it('does not mount the HR personnel-file document repository', () => {
    // Withheld for a reason the document states: the folder can hold a warning letter and there is no
    // per-document "visible to employee" switch yet. DocumentsManager is also a WRITE surface.
    for (const dead of ['DocumentsSection', 'DocumentsManager', 'listEmployeeDocuments']) {
      expect(ME_PAGE.includes(dead), `/me must not mount ${dead}`).toBe(false);
    }
  });
});

describe('r259 — the field-visibility list is a deliverable, and it is kept honest', () => {
  it('every withheld field is written down for the reporter, with its reason', () => {
    const missing = ME_HIDDEN_FIELDS.filter((f) => !DOC.includes(f.field));
    expect(
      missing.map((f) => f.field),
      'these fields are withheld in code but are not in docs/me-profile-field-visibility.md — the plan ' +
        'promises the reporter the list is written down, so the document is the deliverable and not a note',
    ).toEqual([]);
    for (const f of ME_HIDDEN_FIELDS) {
      expect(f.reason.length, `${f.field} is withheld with no reason given`).toBeGreaterThan(30);
    }
  });

  it('the document describes the tabs the screen actually has', () => {
    for (const label of ['Profile', 'Employment', 'Bank & Statutory', 'Payroll', 'Family', 'Documents']) {
      expect(DOC.includes(`**${label}**`), `the document does not describe the ${label} tab`).toBe(true);
    }
  });

  it('and names each Personnel-shaped card by the words that are actually on screen', () => {
    // The document is what the reporter reads. A card renamed on the Personnel side renames it here too —
    // that is the whole design — and the document would then describe a screen that no longer exists.
    // When this fails, update the table under "The shape" and re-show the document; do not relax the case.
    const enDetail = CATALOGS.en.people as Record<string, unknown>;
    const missing: string[] = [];
    for (const key of Object.values(ME_SECTION_TITLE_KEY).flat()) {
      const title = leaf(leaf(enDetail, 'detail'), key);
      if (typeof title === 'string' && !DOC.includes(title)) missing.push(`${key} = "${title}"`);
    }
    expect(missing, `cards on screen but not named in the document: ${missing.join(', ')}`).toEqual([]);
  });

  it('every withheld field names a tab the screen has (or all of them)', () => {
    const valid = new Set<string>([...ME_TABS, 'all']);
    for (const f of ME_HIDDEN_FIELDS) {
      expect(valid.has(f.tab), `${f.field} is filed under tab '${f.tab}', which is not on this screen`).toBe(true);
    }
  });
});

describe('r259/r260 — the two existing write paths were widened, not rebuilt', () => {
  it('keeps ADR-0012’s two paths, and neither has been replaced by a second mechanism', () => {
    // The correction the reporter was given: a request-and-approve path ALREADY EXISTS
    // (db/schema.ts profile_change_request + core/profile.ts). Neither stage may build a second one,
    // and neither may remove the first.
    expect(ME_PAGE).toContain('action={myUpdateContact}');
    expect(REQUEST_CARD).toContain('action={myRequestProfileChange}');
  });

  it('r260: STAGE TWO IS BUILT — the request card, and the decision reason shown to the employee', () => {
    /**
     * THIS CASE REPLACES A STAGE-ONE ASSERTION THAT SAID THE OPPOSITE, and the reversal is deliberate
     * rather than a relaxation (AGENTS rule 18). Stage one asserted that no rejection-reason wording
     * appeared on /me, because a reason box then would have meant stage two was built ahead of its
     * plan. Stage two IS that plan, so the assertion now runs the other way: the employee must be able
     * to read the approver's reason, and the request card must exist on BOTH tabs that carry
     * requestable fields.
     */
    expect(REQUEST_CARD).toContain('decisionReason');
    expect(ME_PAGE).toContain('<RequestChangeCard tab="profile"');
    expect(ME_PAGE).toContain('<RequestChangeCard tab="bankStatutory"');
    // The master value is what the record shows; the request is drawn BESIDE it. So the read field
    // still prints `value` and the pending value is a separate prop — never the same one.
    expect(READ_FIELD).toContain('pending?: { value: string; label: string } | null');
    expect(
      /const shown = value == null \|\| value === '' \? notSet : value;/.test(READ_FIELD),
      'the read field no longer shows the MASTER value — a pending request must never replace it',
    ).toBe(true);
  });

  it('r260: STAGE THREE IS NOT BUILT — no per-field permission, no approver-choice setting', () => {
    // The plan tells the reporter stage three follows: "A setting that controls, field by field, which
    // information an employee may ask to change" and "A setting that controls who approves". Neither
    // may appear early, and the single-approver decision the plan states out loud must still hold.
    for (const ahead of ['fieldPermission', 'approverChoice', 'approvalChain', 'secondApprover']) {
      expect(ME_PAGE.includes(ahead), `${ahead} belongs to stage three`).toBe(false);
      expect(REQUEST_CARD.includes(ahead), `${ahead} belongs to stage three`).toBe(false);
    }
  });
});
