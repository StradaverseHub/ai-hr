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
  ME_VISIBLE_FIELD_LABEL_KEYS,
} from '../app/me/visible-fields';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const ME_PAGE = read('app/me/page.tsx');
const ME_RECORD = read('app/me/record.ts');
const READ_FIELD = read('app/me/read-field.tsx');
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
  'components/bank-account-fields.tsx',
  'components/bank-info-card.tsx',
  'components/salary-history-table.tsx',
  'components/pay-structure-fields.tsx',
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
    for (const column of [
      'blacklistReason',
      'blacklistedAt',
      'contractRemark',
      'costAllocation',
      'employerBearsEpf',
      'employerBearsSocso',
      'employerBearsEis',
      'employerBearsTax',
      'childReliefTable',
      'payrollPolicyName',
      'taxNumberSharedWith',
      'createdByName',
    ]) {
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

  it('every withheld field names a tab the screen has (or all of them)', () => {
    const valid = new Set<string>([...ME_TABS, 'all']);
    for (const f of ME_HIDDEN_FIELDS) {
      expect(valid.has(f.tab), `${f.field} is filed under tab '${f.tab}', which is not on this screen`).toBe(true);
    }
  });
});

describe('r259 — the two existing write paths were preserved, not rebuilt', () => {
  it('keeps ADR-0012’s two paths exactly as they were', () => {
    // The correction the reporter was given: a request-and-approve path ALREADY EXISTS
    // (db/schema.ts profile_change_request + core/profile.ts). This round must not build a second one,
    // and must not remove the first.
    expect(ME_PAGE).toContain('action={myUpdateContact}');
    expect(ME_PAGE).toContain('action={myRequestProfileChange}');
    // Stage two and stage three are NOT this round. A rejection-reason box or a per-field permission
    // control appearing here would mean a stage was built ahead of its plan.
    for (const ahead of ['rejectionReason', 'rejectReason', 'fieldPermission']) {
      expect(ME_PAGE.includes(ahead), `${ahead} belongs to a later stage`).toBe(false);
    }
  });
});
