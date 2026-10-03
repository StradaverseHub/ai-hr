/**
 * Item 35b7af0a, GROUP 1 — the Create New Employee wizard and the Personnel (Admin) profile card now
 * render ONE shared Personal Details field group instead of two drifting copies.
 *
 * THE DEFECT THIS FIXES IS NOT ONLY DUPLICATION. The wizard carried its own gender/marital selects with
 * its own shorter option list: 2 genders and 2 marital statuses against the profile card's 3 and 6. So
 * 'divorced', 'widowed', 'separated' and 'undisclosed' were unrecordable at hire and recordable one screen
 * later — while #12129e77 had already established that every surface offering these must draw from the
 * SAME master list, precisely so a leave rule written for 'divorced' has a reachable matching profile
 * value. The wizard was the surface nobody checked.
 *
 * §1 one definition — the master lists live in a client-safe module and every consumer draws from it,
 *    including the two CLIENT components that previously had to keep hand-synced copies.
 * §2 source guards — neither screen builds its own option list any more, and the shared component is
 *    boundary-safe and single-namespace.
 * §3 the retired labels are gone from all six catalogs and nothing renders them.
 * §4 behaviour against a real database — a draft can now carry the values the wizard could not offer, and
 *    they land on the person row.
 * §5 DRAFT COMPATIBILITY — a draft saved BEFORE this change still opens and still creates. This is the one
 *    place the refactor could lose somebody's work.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { GENDERS, MARITAL_STATUSES } from '../lib/person-vocabulary';
import { clientPackFor } from '../localization/registry.client';
// The db-free leaf the client pack serves as `identity.isLocalNationality` — the gate group 8 shares.
import { isMalaysianNationality } from '../localization/my/ic-dob';
import * as profile from '../core/profile';
import { ELIGIBILITY_MARITAL_OPTIONS } from '../core/admin';
import {
  completeEmployeeDraft,
  getEmployeeDraft,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { type EmployeeDraftData } from '../lib/employee-draft-schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

/**
 * THE BODY OF `missingByTab`, AND PROOF THAT IT IS REALLY THERE (r374, CLAUDE.md §8).
 *
 * Two cases below read this function's source rather than calling it, because what they assert is that
 * a field name is NEVER pushed — a thing no amount of calling can establish. Both used to cut the slice
 * with a bare pair of `indexOf` calls, and a renamed marker makes `indexOf` return −1, which
 * `String.prototype.slice` reads as `length − 1`: the slice collapses to the empty string and every
 * `not.toContain` on it passes over no source at all. Asserted with `>= 0` rather than truthiness,
 * because −1 is truthy, plus a length floor — the only thing that separates "no violations" from
 * "no text".
 */
function missingByTabBody(): string {
  const schema = read('lib/employee-draft-schema.ts');
  const start = schema.indexOf('export function missingByTab');
  const end = schema.indexOf('export function missingForCreation');
  expect(start, 'missingByTab was renamed — this guard would silently stop reading anything').toBeGreaterThanOrEqual(0);
  expect(end, 'missingForCreation was renamed — same trap').toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = schema.slice(start, end);
  expect(body.length, 'the missingByTab body is implausibly short — the markers moved').toBeGreaterThan(2000);
  // A positive control: the one field name the function certainly DOES push.
  expect(body).toContain("'basicSalary'");
  return body;
}

const WIZARD = 'app/admin/personnel/new/wizard.tsx';
const PERSONNEL = 'app/admin/personnel/[employmentId]/page.tsx';
const SHARED = 'components/person-details-fields.tsx';
const BIRTH_DATE = 'components/birth-date-fields.tsx';
const EPF_FIELDS = 'components/epf-registration-fields.tsx';
const BANK_FIELDS = 'components/bank-account-fields.tsx';
const BANK_CARD = 'components/bank-info-card.tsx';
const TAX_FIELD = 'components/tax-category-field.tsx';
const TAX_CARD = 'components/identity-tax-card.tsx';
const SOCSO_FIELDS = 'components/socso-eis-fields.tsx';
const IDENTITY_FIELDS = 'components/identity-fields.tsx';
const IDENTITY_CARD = 'components/personnel-identity.tsx';
const PERSONNEL_PAGE = 'app/admin/personnel/[employmentId]/page.tsx';
const PAY_STRUCTURE = 'components/pay-structure-fields.tsx';
const SALARY_HISTORY = 'components/salary-history-table.tsx';
const LEAVE_PANEL = 'app/admin/leave-config/types/leave-type-tabs.tsx';

let b: Base;

function draft(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: {
      fullName: 'Nadia Yusof',
      primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `SF${randomUUID().slice(0, 8).toUpperCase()}`,
    },
    employment: {
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    },
    payroll: { basicSalary: '5200' },
    ...over,
  };
}

const readPerson = (personId: string) =>
  owner.db
    .select()
    .from(schema.person)
    .where(eq(schema.person.id, personId))
    .limit(1)
    .then((r) => r[0]);

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

// ── §1 one definition ─────────────────────────────────────────────────────────────────────────────
describe('§1 the person master lists have exactly one definition', () => {
  it('carries every value the profile screen offers', () => {
    expect([...GENDERS]).toEqual(['male', 'female', 'undisclosed']);
    expect([...MARITAL_STATUSES]).toEqual(['single', 'married', 'divorced', 'widowed', 'separated', 'other']);
  });

  it('core/profile.ts re-exports the SAME arrays (identity, not a copy)', () => {
    // Reference equality matters: core/admin.ts does ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES and
    // test/marital-master-enum.test.ts asserts that with toBe. A re-declared array would pass a
    // deep-equal check today and silently drift tomorrow — which is the entire fault being fixed.
    expect(profile.GENDERS).toBe(GENDERS);
    expect(profile.MARITAL_STATUSES).toBe(MARITAL_STATUSES);
    expect(ELIGIBILITY_MARITAL_OPTIONS).toBe(MARITAL_STATUSES);
  });

  it('the server write path accepts every value the shared list offers, and nothing else', () => {
    // The list HR picks from and the list the server validates against must be the same list, or a
    // choosable value is silently dropped on save. This walks the real sanitiser via its only public door.
    for (const m of MARITAL_STATUSES) {
      expect(profile.MARITAL_STATUSES).toContain(m);
    }
    for (const g of GENDERS) {
      expect(profile.GENDERS).toContain(g);
    }
  });
});

// ── §2 source guards ──────────────────────────────────────────────────────────────────────────────
describe('§2 neither screen keeps its own copy of the group', () => {
  it('both screens render the shared component', () => {
    for (const f of [WIZARD, PERSONNEL]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain(
        "from '@/components/person-details-fields'",
      );
      expect(src, `${f} must render it`).toContain('<PersonDetailsFields');
    }
  });

  it('neither screen hardcodes a gender or marital option list any more', () => {
    // The exact shape of the old duplication: literal <option value="..."> for a master-list value.
    for (const f of [WIZARD, PERSONNEL]) {
      const src = read(f);
      for (const v of ['male', 'female', 'undisclosed', 'single', 'married', 'divorced', 'widowed', 'separated']) {
        // The Family/dependants panel on the Personnel page has its own gender + marriage-status
        // vocabularies (core/dependents.ts) for DEPENDANTS, not for the employee — those are a different
        // register and are deliberately untouched. They render from a mapped array, never a literal
        // <option value="male">, so this guard does not collide with them.
        expect(src.includes(`<option value="${v}">`), `${f} still hardcodes ${v}`).toBe(false);
      }
    }
  });

  it('the leave-eligibility rule form draws the marital list from the shared module, not a copy', () => {
    const src = read(LEAVE_PANEL);
    expect(src).toContain("from '@/lib/person-vocabulary'");
    expect(src).toContain('const ELIGIBILITY_MARITAL_OPTIONS = MARITAL_STATUSES;');
    // The old hand-synced literal is gone.
    expect(src).not.toContain("['single', 'married', 'divorced', 'widowed', 'separated', 'other'] as const");
  });

  it('the shared component is client-safe for a SERVER caller and stays single-namespace', () => {
    const src = read(SHARED);
    // It must be a client component (the wizard passes it handlers)…
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    // …and the Personnel page (a server component) must therefore pass it NO function prop. r123 shipped
    // exactly that fault to production; test/server-client-boundary.test.ts pins the general class, this
    // pins the specific call site.
    const call = read(PERSONNEL).match(/<PersonDetailsFields[\s\S]*?\/>/);
    expect(call, 'the personnel page must render PersonDetailsFields').not.toBeNull();
    expect(call![0]).not.toMatch(/=\{\s*\(/); // no arrow-function prop
    expect(call![0]).toContain('mode="form"');
    // One namespace per file — check C of test/i18n-coverage.test.ts SKIPS multi-namespace files, so a
    // second useTranslations here would quietly drop these labels out of the guard.
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);
  });
});

// ── §3 the retired labels ─────────────────────────────────────────────────────────────────────────
describe('§3 the wizard s duplicate labels are retired, not orphaned', () => {
  it('nothing in the app renders the retired wizard keys', () => {
    for (const f of [WIZARD, PERSONNEL]) {
      const src = read(f);
      expect(src).not.toContain("t('fields.gender')");
      expect(src).not.toContain("t('fields.maritalStatus')");
      expect(src).not.toContain("t('gender.");
      expect(src).not.toContain("t('marital.");
    }
  });

  it('and they are gone from all six catalogs', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const w = msgs.people.wizard;
      expect(w.gender, `${loc} people.wizard.gender`).toBeUndefined();
      expect(w.marital, `${loc} people.wizard.marital`).toBeUndefined();
      expect(w.fields.gender, `${loc} people.wizard.fields.gender`).toBeUndefined();
      expect(w.fields.maritalStatus, `${loc} people.wizard.fields.maritalStatus`).toBeUndefined();
      // The surviving definition — the one both screens now read — is present in every language.
      for (const k of [
        'gender', 'genderNotSet', 'genderMale', 'genderFemale', 'genderUndisclosed',
        'maritalStatus', 'maritalNotSet', 'maritalSingle', 'maritalMarried', 'maritalDivorced',
        'maritalWidowed', 'maritalSeparated', 'maritalOther',
      ]) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

// ── §3b GROUP 2 — pay structure ───────────────────────────────────────────────────────────────────
describe('§3b group 2 — Pay Mode / Payment Term / Rate is one component, not three copies', () => {
  it('the wizard renders the component the Personnel screens already used', () => {
    const src = read(WIZARD);
    expect(src).toContain("from '@/components/pay-structure-fields'");
    expect(src).toMatch(/<PayStructureFields[\s\S]*?mode="controlled"/);
    // …and no longer builds the three fields itself.
    expect(src).not.toContain("t('fields.payMode')");
    expect(src).not.toContain("t('fields.paymentTerm')");
    expect(src).not.toContain("t('payMode.");
    expect(src).not.toContain("t('paymentTerm.");
    expect(src).not.toContain("t('hints.rateAmount')");
    for (const v of ['monthly', 'daily', 'hourly', 'custom_period', 'weekly', 'biweekly']) {
      expect(src.includes(`<option value="${v}">`), `wizard still hardcodes ${v}`).toBe(false);
    }
  });

  it('the two pre-existing callers keep the uncontrolled form behaviour they had', () => {
    // `mode` is optional and defaults to 'form'. These two live inside server-action <form> blocks and
    // MUST keep posting named inputs — a silent switch to controlled would post nothing and every salary
    // revision would quietly lose its pay structure.
    for (const f of [PERSONNEL, SALARY_HISTORY]) {
      const call = read(f).match(/<PayStructureFields[\s\S]*?\/>/);
      expect(call, `${f} must render PayStructureFields`).not.toBeNull();
      expect(call![0], `${f} must not be switched to controlled`).not.toContain('mode="controlled"');
      expect(call![0]).toContain('defaultPayMode');
    }
    const shared = read(PAY_STRUCTURE);
    // The named inputs the form mode depends on are still emitted in that mode only.
    expect(shared).toContain("{ name: 'payMode' }");
    expect(shared).toContain("name: 'paymentTerm'");
    expect(shared).toContain("name: 'rateAmount'");
  });

  it('the rate box is conditional on the pay mode in BOTH modes (one rule, not a per-screen one)', () => {
    const shared = read(PAY_STRUCTURE);
    // The conditional and the required-ness are expressed once, outside either mode branch.
    expect(shared).toContain("{payMode !== 'monthly' && (");
    expect(shared).toContain("const rateRequired = payMode === 'daily' || payMode === 'hourly';");
  });

  it('the wizard clears a stale rate when the pay mode goes back to monthly', () => {
    // On the Personnel form the input unmounts and is simply not submitted. A DRAFT keeps what it holds,
    // so without this a rate typed under "hourly" would survive invisibly into setCompensation.
    expect(read(WIZARD)).toContain("...(patch.payMode === 'monthly' ? { rateAmount: '' } : {})");
  });

  it('the retired payroll labels are gone, but the one the review step still needs is kept', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const w = msgs.people.wizard;
      expect(w.payMode, `${loc} people.wizard.payMode`).toBeUndefined();
      expect(w.paymentTerm, `${loc} people.wizard.paymentTerm`).toBeUndefined();
      expect(w.fields.payMode, `${loc} people.wizard.fields.payMode`).toBeUndefined();
      expect(w.fields.paymentTerm, `${loc} people.wizard.fields.paymentTerm`).toBeUndefined();
      expect(w.hints.rateAmount, `${loc} people.wizard.hints.rateAmount`).toBeUndefined();
      // KEPT ON PURPOSE: missingByStep can return 'rateAmount' and the review step renders
      // t(`fields.${f}`) — a computed key check C cannot see. Deleting it is a MISSING_MESSAGE on a
      // screen HR actually reaches (a daily-paid hire with no rate).
      expect(String(w.fields.rateAmount ?? '').trim(), `${loc} fields.rateAmount`).not.toBe('');
      // The surviving definition both screens now read.
      for (const k of ['payMode', 'paymentTerm', 'rateAmount', 'rateUnitDaily', 'rateUnitHourly',
        'payMode_monthly', 'payMode_daily', 'payMode_hourly', 'payMode_custom_period',
        'paymentTerm_monthly', 'paymentTerm_weekly', 'paymentTerm_biweekly']) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

// ── §3c GROUP 3 — Date of Birth + Age ─────────────────────────────────────────────────────────────
describe('§3c group 3 — Date of Birth carries the Age, and the age counter has one definition', () => {
  it('both screens render the shared group', () => {
    for (const f of [WIZARD, PERSONNEL]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain("from '@/components/birth-date-fields'");
      expect(src, `${f} must render it`).toContain('<BirthDateFields');
    }
  });

  it('neither screen builds its own date-of-birth box or age figure any more', () => {
    const wizard = read(WIZARD);
    // The wizard's own label is no longer RENDERED (the key survives — see the catalog assertion below).
    expect(wizard).not.toContain("t('fields.dateOfBirth')");
    expect(wizard).not.toContain("name: 'dateOfBirth'");
    const page = read(PERSONNEL);
    // The page no longer derives the age itself, and no longer needs the server-only helper at all.
    expect(page).not.toContain('completedYearsAt');
    expect(page).not.toContain("<Field label={t('age')}>");
  });

  it('the age counter is defined ONCE, in a client-safe module, and re-exported by identity', () => {
    const lib = read('lib/completed-years.ts');
    // Client-safe means exactly this: no database, no server module, nothing that drags one in. The wizard
    // is a client component — that is the whole reason it never had an Age field.
    expect(lib).not.toMatch(/from '(\.\.\/)?(db|core)\//);
    expect(lib).toContain('export const serviceYearsAt');
    expect(lib).toContain('export const completedYearsAt');
    // core/leave.ts keeps the old door open for its server callers (core/read.ts, core/analytics.ts, the
    // entitlement engine, four test files) — imported and re-exported, never redeclared.
    const leave = read('core/leave.ts');
    expect(leave).toContain("import { serviceYearsAt, completedYearsAt } from '../lib/completed-years';");
    expect(leave).toContain('export { serviceYearsAt, completedYearsAt };');
    expect(leave).not.toMatch(/export const (serviceYearsAt|completedYearsAt)\b/);
  });

  it('the shared component is client-safe for a SERVER caller and stays single-namespace', () => {
    const src = read(BIRTH_DATE);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    const call = read(PERSONNEL).match(/<BirthDateFields[\s\S]*?\/>/);
    expect(call, 'the personnel page must render BirthDateFields').not.toBeNull();
    expect(call![0]).not.toMatch(/=\{\s*\(/); // no arrow-function prop crosses the RSC boundary
    expect(call![0]).toContain('mode="form"');
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);
  });

  it('the IC → DOB autofill still has the DOM id it writes into', () => {
    // components/ic-dob-autofill.tsx fills the field by document.getElementById(dobInputId).value — a raw
    // DOM write with no React event. Losing the id (or making the input controlled) breaks item 354a500d
    // silently: no type error, no failing assertion anywhere else, just an autofill that stops arriving.
    // The writer and the field must name the SAME id, and they live in two different files.
    expect(read('components/personnel-identity.tsx')).toContain('dobInputId="profile-dob-input"');
    expect(read(PERSONNEL)).toContain('inputId="profile-dob-input"');
    expect(read(BIRTH_DATE)).toContain('defaultValue: stored');
    expect(read(BIRTH_DATE)).toContain('id: props.inputId');
  });

  it('the wizard label key is KEPT in all six catalogs, because the Review step still computes it', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      // missingByStep returns the field name 'dateOfBirth' for a malformed draft date, and the Review step
      // renders t(`fields.${f}`) — a computed key check C cannot see. Deleting this would be a
      // MISSING_MESSAGE on a screen HR reaches by typing a bad date. Same rule as fields.rateAmount.
      expect(String(msgs.people.wizard.fields.dateOfBirth ?? '').trim(), `${loc} fields.dateOfBirth`).not.toBe('');
      // The wizard's own hint is still shown UNDER the shared field — nothing was lost by sharing it.
      expect(String(msgs.people.wizard.hints.dateOfBirth ?? '').trim(), `${loc} hints.dateOfBirth`).not.toBe('');
      // The surviving label definition — the one both screens now read.
      for (const k of ['birthDate', 'age', 'ageYears']) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
      expect(String(msgs.people.detail.employmentInfo.notAvailable ?? '').trim()).not.toBe('');
    }
  });
});

// ── §3d GROUP 4 — EPF registration ────────────────────────────────────────────────────────────────
describe('§3d group 4 — EPF Number + EPF Citizenship is one component, not two copies', () => {
  it('both screens render the shared group and neither builds the citizenship list itself', () => {
    for (const f of [WIZARD, PERSONNEL]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain("from '@/components/epf-registration-fields'");
      expect(src, `${f} must render it`).toContain('<EpfRegistrationFields');
      for (const v of ['citizen', 'pr', 'non_citizen']) {
        expect(src.includes(`<option value="${v}">`), `${f} still hardcodes ${v}`).toBe(false);
      }
    }
    const wizard = read(WIZARD);
    expect(wizard).not.toContain("t('fields.epfNumber')");
    expect(wizard).not.toContain("t('fields.epfCitizenship')");
    expect(wizard).not.toContain("t('citizenship.");
  });

  it('the shared component is client-safe for a SERVER caller and stays single-namespace', () => {
    const src = read(EPF_FIELDS);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    // No DB import from a 'use client' module — the option list is a declared mirror of the pg enum, the
    // same arrangement components/pay-structure-fields.tsx uses for the pay unions.
    expect(src).not.toMatch(/from '(@\/|\.\.\/)?(db|core)\//);
    const call = read(PERSONNEL).match(/<EpfRegistrationFields[\s\S]*?\/>/);
    expect(call, 'the personnel page must render EpfRegistrationFields').not.toBeNull();
    expect(call![0]).not.toMatch(/=\{\s*\(/); // no arrow-function prop crosses the RSC boundary
    expect(call![0]).toContain('mode="form"');
    expect(call![0]).not.toContain('mode="controlled"');
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);
  });

  it('the option list matches the pg enum exactly — no blank member the column cannot hold', () => {
    // `epf_citizenship` is NOT NULL DEFAULT 'citizen'. The wizard's fourth "— Not set —" option therefore
    // promised a state that has never been storable: it produced 'citizen' anyway, and the Personnel screen
    // then read back "Malaysian citizen" for a foreign worker whose recruiter had left it deliberately blank.
    // Read as source rather than imported: this is a node-project test file and the component is a
    // 'use client' .tsx (the DOM project renders it for real — see the sibling .dom.test.tsx).
    expect(read(EPF_FIELDS)).toContain(
      "export const EPF_CITIZENSHIP_OPTIONS = ['citizen', 'pr', 'non_citizen'] as const;",
    );
    const schema = read('db/schema.ts');
    expect(schema).toContain("pgEnum('epf_citizenship', ['citizen', 'pr', 'non_citizen'])");
    expect(schema).toContain("epfCitizenship: epfCitizenshipEnum('epf_citizenship').notNull().default('citizen')");
    expect(read(EPF_FIELDS)).not.toContain('<option value="">');
  });

  it('the wizard s duplicate EPF labels are gone from all six catalogs', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const w = msgs.people.wizard;
      expect(w.fields.epfNumber, `${loc} people.wizard.fields.epfNumber`).toBeUndefined();
      expect(w.fields.epfCitizenship, `${loc} people.wizard.fields.epfCitizenship`).toBeUndefined();
      expect(w.citizenship, `${loc} people.wizard.citizenship`).toBeUndefined();
      // KEPT: 'notSet' is still rendered by the wizard's remaining tax/EIS/resident selects.
      expect(String(w.notSet ?? '').trim(), `${loc} people.wizard.notSet`).not.toBe('');
      // The surviving definition both screens now read.
      for (const k of ['epfNumber', 'epfCitizenship', 'epfCitizenshipCitizen', 'epfCitizenshipPr',
        'epfCitizenshipNonCitizen']) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

// ── §3e GROUP 5 — employee bank details ───────────────────────────────────────────────────────────
describe('§3e group 5 — Bank + Bank Account Number is one component, and the wizard stops taking free text', () => {
  it('both screens render the shared group', () => {
    for (const f of [WIZARD, BANK_CARD]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain("from '@/components/bank-account-fields'");
      expect(src, `${f} must render it`).toContain('<BankAccountFields');
    }
    const wizard = read(WIZARD);
    expect(wizard).not.toContain("t('fields.bankName')");
    expect(wizard).not.toContain("t('fields.bankAccountNo')");
  });

  it('the wizard s bank is a CATALOG PICK now, not a free-text box', () => {
    // The defect, stated plainly: the Personnel card has been a pick-from-the-BNM-catalog select since item
    // ef720d3a, and the wizard was still a bare <input>. So a hire could be created with "may bank" typed by
    // hand — invisible on every screen, and only surfacing when the first salary payment file is built.
    const src = read(BANK_FIELDS);
    expect(src).toContain("from '@/localization/registry.client'");
    expect(src).toContain('const BANK_NAMES = clientCountryPacks().flatMap((p) => p.bankNames);');
    expect(src).toContain('<select');
    // A value already typed into a draft (or stored from before the catalog existed) is preserved as its own
    // option rather than silently rewritten — a screen that merely renders a value must never drop it.
    expect(src).toContain(
      "const options = current && !BANK_NAMES.includes(current) ? [current, ...BANK_NAMES] : BANK_NAMES;",
    );
  });

  it('the shared component is client-safe for a SERVER caller and stays single-namespace', () => {
    const src = read(BANK_FIELDS);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    expect(src).not.toMatch(/from '(@\/|\.\.\/)?(db|core)\//);
    // The card is itself a client island, so the no-closure rule is not at stake there — but the card must
    // stay in the uncontrolled `form` mode its setBankAction reads out of FormData.
    const call = read(BANK_CARD).match(/<BankAccountFields[\s\S]*?\/>/);
    expect(call, 'the bank card must render BankAccountFields').not.toBeNull();
    expect(call![0]).toContain('mode="form"');
    expect(call![0]).not.toContain('mode="controlled"');
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);
  });

  it('the retired bank labels are gone, but the two the wizard still renders are kept', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const w = msgs.people.wizard;
      expect(w.fields.bankName, `${loc} people.wizard.fields.bankName`).toBeUndefined();
      expect(w.fields.bankAccountNo, `${loc} people.wizard.fields.bankAccountNo`).toBeUndefined();
      // KEPT: missingByStep returns 'bankAccount' when exactly one of the two is filled (half a bank
      // instruction cannot pay anybody) and the Review step renders it through a computed t(`fields.${f}`).
      expect(String(w.fields.bankAccount ?? '').trim(), `${loc} fields.bankAccount`).not.toBe('');
      // KEPT: the all-or-nothing rule is still shown under the account number.
      expect(String(w.hints.bankAccount ?? '').trim(), `${loc} hints.bankAccount`).not.toBe('');
      for (const k of ['bank', 'bankAccount', 'bankSelectPlaceholder']) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

describe('§3f group 6 — Tax Category is one component, and the wizard stops labelling it "1", "2", "3"', () => {
  it('both screens render the shared control', () => {
    for (const f of [WIZARD, TAX_CARD]) {
      const src = read(f);
      expect(src, `${f} must import the shared control`).toContain('tax-category-field');
      expect(src, `${f} must render it`).toContain('<TaxCategoryField');
    }
    expect(read(WIZARD)).not.toContain("t('fields.taxCategory')");
  });

  it('the wizard NAMES the five circumstances instead of numbering three', () => {
    // The defect, stated plainly: the Personnel card has always offered Single / Married & spouse not
    // working / Married & spouse working / Divorced with children / None. The wizard offered options
    // labelled literally "1", "2" and "3", so creating a hire required knowing the LHDN numbering by
    // heart — and a category chosen wrongly here is invisible afterwards. It is simply the wrong monthly
    // tax, every month, until somebody notices.
    const wizard = read(WIZARD);
    for (const k of ['taxCategory.1', 'taxCategory.2', 'taxCategory.3']) {
      expect(wizard, `the numbered label ${k} must be gone`).not.toContain(k);
    }
    const src = read(TAX_FIELD);
    expect(src, 'the shared control consumes the country-owned options').toContain("clientPackFor('MY')!.payroll.taxCircumstanceOptions");
    const keys = clientPackFor('MY')!.payroll.taxCircumstanceOptions!.map((option) => option.key);
    for (const k of [
      'taxCategorySingle',
      'taxCategoryMarriedSpouseNotWorking',
      'taxCategoryMarriedSpouseWorking',
      'taxCategoryDivorcedWithKids',
      'taxCategoryNone',
    ]) {
      expect(keys, `the shared control must offer ${k}`).toContain(k);
    }
  });

  it('preserves five distinct saved circumstances and their exact statutory mapping', () => {
    // Spouse-working and widow/divorced retain separate saved identities while both map to category 3.
    // Explicit None bypasses PCB rather than silently selecting category 1. The public client seam owns
    // these options; importing its pure data avoids pulling the client component into this node guard.
    const options = clientPackFor('MY')!.payroll.taxCircumstanceOptions!;
    expect(Object.fromEntries(options.map((option) => [option.value, option.category]))).toEqual({
      single: 1, spouse_not_working: 2, spouse_working: 3, widow_divorced: 3, none: null,
    });
    expect(new Set(options.map((option) => option.value)).size, 'five distinct saved tokens').toBe(5);
    expect(new Set(options.map((option) => option.key)).size, 'five distinct labels').toBe(5);
  });

  it('the shared control is client-safe, single-namespace, and each screen uses the right mode', () => {
    const src = read(TAX_FIELD);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    expect(src).not.toMatch(/from '(@\/|\.\.\/)?(db|core)\//);
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);

    // The card POSTS both the mapped integer and the detailed identity through FormData.
    const cardCall = read(TAX_CARD).match(/<TaxCategoryField[\s\S]*?\/>/);
    expect(cardCall).not.toBeNull();
    expect(cardCall![0]).toContain('mode="form"');
    // The wizard holds its draft in state and submits JSON, so it must be controlled and carry NO name —
    // r159's lesson: a guard grepping for name="taxCategory" must not conclude that this one posts.
    const wizardCall = read(WIZARD).match(/<TaxCategoryField[\s\S]*?\/>/);
    expect(wizardCall).not.toBeNull();
    expect(wizardCall![0]).toContain('mode="controlled"');
    expect(wizardCall![0]).not.toContain('name=');
  });

  it('the retired numbered labels are gone from every catalog, and the named ones exist', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      expect(msgs.people.wizard.fields.taxCategory, `${loc} fields.taxCategory`).toBeUndefined();
      expect(msgs.people.wizard.taxCategory, `${loc} wizard.taxCategory.*`).toBeUndefined();
      for (const k of [
        'taxCategoryLabel',
        'taxCategorySingle',
        'taxCategoryMarriedSpouseNotWorking',
        'taxCategoryMarriedSpouseWorking',
        'taxCategoryDivorcedWithKids',
        'taxCategoryNone',
      ]) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });

  it('retiring fields.taxCategory is safe from the computed-key trap', () => {
    // r159 nearly deleted three keys that survive no literal grep because the Review step renders
    // t(`fields.${f}`) from whatever missingByTab returns. Checked by READING the function, not grepping:
    // it never pushes 'taxCategory', so nothing can ask for the retired key.
    // r374 — THE SLICE IS PROVEN NON-EMPTY FIRST (CLAUDE.md §8). Both markers are matched by `indexOf`,
    // and a renamed one returns −1: `slice(-1)` is the LAST CHARACTER, whose own `indexOf` is then −1
    // too, so `slice(0, -1)` is `""` and this `not.toContain` would pass over no source at all.
    // `test/r219-ea-cp8a-form.test.ts` asserted nothing for 27 rounds through exactly this.
    expect(missingByTabBody()).not.toContain("'taxCategory'");
  });
});

describe('§3g group 7 — SOCSO / EIS is one group, and the wizard catches up a whole consolidation', () => {
  it('both screens render the shared group', () => {
    for (const f of [WIZARD, PERSONNEL_PAGE]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain('socso-eis-fields');
      expect(src, `${f} must render it`).toContain('<SocsoEisFields');
    }
  });

  it('the wizard offers the CATEGORY controls it never had, not the legacy boolean', () => {
    // The defect: item a7271737 made the category the single per-scheme control on the Personnel
    // screen, replacing Subject-to-SOCSO / Subject-to-EIS. The wizard never followed — it still asked
    // one "EIS eligible" yes/no and had NO SOCSO category at all, so a hire created there could not be
    // put in SOCSO First or Second category, and the same employee on Personnel showed a different
    // question with more answers.
    const wizard = read(WIZARD);
    expect(wizard, 'the legacy EIS boolean control is gone').not.toContain("t('fields.eisEligible')");
    expect(wizard, 'and its bare SOCSO number box is gone').not.toContain("t('fields.socsoNumber')");
    const src = read(SOCSO_FIELDS);
    expect(src).toContain("SOCSO_CATEGORIES = ['auto', 'first', 'second', 'none']");
    expect(src).toContain("EIS_CATEGORIES = ['auto', 'none']");
  });

  it('the IC-derived number default reaches the client WITHOUT dragging the server pack in', () => {
    // defaultSocsoEisNumber is pure but lived in statutory.ts, which imports db/client. Sharing the
    // group meant extracting it to a leaf; importing it from statutory.ts instead would put the
    // database driver into every client bundle that reads jurisdiction vocabulary.
    const leaf = read('localization/my/socso-eis.ts');
    expect(leaf).toContain('export const defaultSocsoEisNumber');
    expect(leaf, 'the leaf must have no server deps').not.toMatch(/from '(\.\.\/)*(db|core)\//);
    expect(read('localization/my/statutory.ts'), 'server callers keep their import').toContain(
      "export { defaultSocsoEisNumber } from './socso-eis'",
    );
    expect(read('localization/my/client.ts'), 'the client pack serves it').toContain('defaultSocsoEisNumber');
    expect(read(SOCSO_FIELDS), 'the component reads it through the CLIENT registry').toContain(
      "from '@/localization/registry.client'",
    );
  });

  it('a draft saved BEFORE this change still maps forward', () => {
    // The legacy draft carries eisEligible 'yes' | 'no' and no categories. 'no' meant the scheme off,
    // which is eisCategory 'none'; anything else meant the automatic derivation. Mapping it in the
    // WRITER (not the component) is what lets an old draft create exactly the employee it always would.
    const draft = read('core/employee-draft.ts');
    expect(draft).toContain("boolOrUndef(s.eisEligible) === false ? 'none' : undefined");
    // And the legacy field stays declared, or an old draft would not even typecheck on open.
    expect(read('lib/employee-draft-schema.ts')).toContain('eisEligible?: string;');
  });

  it('the shared group is client-safe, single-namespace, and each screen uses the right mode', () => {
    const src = read(SOCSO_FIELDS);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    expect(src).not.toMatch(/from '(@\/|\.\.\/)?(db|core)\//);
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);

    const cardCall = read(PERSONNEL_PAGE).match(/<SocsoEisFields[\s\S]*?\/>/);
    expect(cardCall).not.toBeNull();
    expect(cardCall![0], 'the card POSTs through FormData').toContain('mode="form"');
    const wizardCall = read(WIZARD).match(/<SocsoEisFields[\s\S]*?\/>/);
    expect(wizardCall).not.toBeNull();
    expect(wizardCall![0], 'the wizard holds a draft in state').toContain('mode="controlled"');
  });

  it('the retired labels are gone from every catalog and the Personnel keys exist', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      expect(msgs.people.wizard.fields.socsoNumber, `${loc} fields.socsoNumber`).toBeUndefined();
      expect(msgs.people.wizard.fields.eisEligible, `${loc} fields.eisEligible`).toBeUndefined();
      for (const k of [
        'socsoEisNumber',
        'socsoCategoryLabel',
        'socsoCategoryAuto',
        'socsoCategoryFirst',
        'socsoCategorySecond',
        'socsoCategoryNone',
        'eisCategoryLabel',
        'eisCategoryAuto',
        'eisCategoryNone',
      ]) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

describe('§3h group 8 — Identity is one group, and the wizard finally asks for a nationality', () => {
  it('both screens render the shared group', () => {
    for (const f of [WIZARD, IDENTITY_CARD]) {
      const src = read(f);
      expect(src, `${f} must import the shared group`).toContain("from '@/components/identity-fields'");
      expect(src, `${f} must render the identity number field`).toContain('<IdentityNumberField');
      expect(src, `${f} must render the nationality picker`).toContain('<NationalityPicker');
    }
    // The wizard's own bare box and its two labels are gone.
    const wizard = read(WIZARD);
    expect(wizard).not.toContain("t('fields.icNumber')");
    expect(wizard).not.toContain("t('hints.icNumber')");
  });

  it('the wizard ASKS for the nationality, and stores it on the draft', () => {
    // The defect, stated plainly: item 357faecf gates the Personnel screen's Identity No (NRIC) card on
    // person.nationality, and the wizard never collected one — so every hire it created arrived with
    // nationality NULL, isLocalNationality(null) is false, and the identity number the wizard had just
    // captured was HIDDEN on the Personnel screen until somebody set a nationality by hand.
    expect(read(WIZARD)).toContain("set('profile', { nationality })");
    expect(read('lib/employee-draft-schema.ts')).toContain('nationality?: string;');
    // …and the creation path seeds it on the person, at creation, through hireEmployee's own person insert.
    const org = read('core/org.ts');
    expect(org).toContain('nationality: p.person.nationality ?? null');
    expect(read('core/employee-draft.ts')).toContain('nationality,');
  });

  it('the NRIC gate has ONE definition, from the client-safe pack registry', () => {
    // Never a hardcoded jurisdiction (ADR-0080 D4). The predicate lives in the shared group; the Personnel
    // wrapper imports it under its local name rather than restating the rule.
    const src = read(IDENTITY_FIELDS);
    expect(src).toContain("from '@/localization/registry.client'");
    expect(src).toContain(
      'clientCountryPacks().some((p) => p.identity.isLocalNationality(nationality))',
    );
    expect(src, 'the gate is applied inside the shared field, so neither screen can drift from it')
      .toContain('if (!isLocalNationality(props.nationality)) return null;');
    expect(read(IDENTITY_CARD)).toContain('isLocalNationality as isMalaysianNationality');
    // No screen re-derives it from a country string of its own.
    expect(read(WIZARD)).not.toContain('isMalaysianNationality');
  });

  it("group 7's SOCSO workaround is gone — the IC-derived default fires in the wizard now", () => {
    const wizard = read(WIZARD);
    expect(wizard, 'the nationality={undefined} workaround must be gone').not.toContain('nationality={undefined}');
    expect(wizard).toContain('nationality={data.profile?.nationality}');
    // Displaying the default is not storing it: the wizard's SOCSO box is CONTROLLED, so a default nobody
    // types over never enters the draft. The writer applies the same default the Personnel action applies,
    // which is what makes the number shown and the number stored the same number.
    expect(read('core/employee-draft.ts')).toContain('socsoNumber: pack.statutory.defaultSocsoEisNumber({');
  });

  it('the shared group is client-safe, single-namespace, and each screen uses the right mode', () => {
    const src = read(IDENTITY_FIELDS);
    expect(/^\s*['"]use client['"]\s*;/m.test(src.slice(0, 400))).toBe(true);
    expect(src).not.toMatch(/from '(@\/|\.\.\/)?(db|core)\//);
    const namespaces = [...src.matchAll(/useTranslations\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...new Set(namespaces)]).toEqual(['people.detail']);

    // The Personnel card POSTs through FormData, so its copy stays uncontrolled and keeps the names.
    const cardIc = read(IDENTITY_CARD).match(/<IdentityNumberField[\s\S]*?\/>/);
    expect(cardIc).not.toBeNull();
    expect(cardIc![0]).toContain('mode="form"');
    expect(src).toContain('name="icNumber"');
    const cardNat = read(IDENTITY_CARD).match(/<NationalityPicker[\s\S]*?\/>/);
    expect(cardNat).not.toBeNull();
    expect(cardNat![0]).toContain('mode="form"');
    expect(cardNat![0]).toContain('name={name}');

    // The wizard holds a draft in state and submits JSON — controlled, and carrying NO name, so a guard
    // grepping for name="nationality" can never conclude that this copy posts (the r159 lesson).
    for (const tag of ['IdentityNumberField', 'NationalityPicker']) {
      const call = read(WIZARD).match(new RegExp(`<${tag}[\\s\\S]*?/>`));
      expect(call, `the wizard must render ${tag}`).not.toBeNull();
      expect(call![0], `${tag} must be controlled in the wizard`).toContain('mode="controlled"');
      expect(call![0], `${tag} must carry no name in the wizard`).not.toContain('name=');
    }
    // Combobox only emits its hidden input when a name is given — that is what makes "no name" mean
    // "posts nothing" rather than "posts under an empty name".
    expect(read('components/ui/combobox.tsx')).toContain(
      '{name !== undefined && <input type="hidden" name={name} value={selected} />}',
    );
  });

  it('the wizard is NOT made stricter than the other two ways of creating an employee', () => {
    // The IC is required on the Personnel card (a Malaysian must have an NRIC) and deliberately optional in
    // the wizard: item e3ce0d4d made the column nullable for passport holders, and lib/employee-draft-schema
    // states that a wizard stricter than hireEmployee and the bulk importer is how the three drift apart.
    const body = missingByTabBody(); // r374 — non-emptiness proven inside the helper (CLAUDE.md §8).
    expect(body).not.toContain("'icNumber'");
    expect(body).not.toContain("'nationality'");
  });

  it('the retired wizard labels are gone from every catalog, and the Personnel keys exist', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      const w = msgs.people.wizard;
      // Safe to retire: missingByStep never returns 'icNumber', so the Review step's computed
      // t(`fields.${f}`) cannot ask for it (asserted from the function body in the test above).
      expect(w.fields.icNumber, `${loc} people.wizard.fields.icNumber`).toBeUndefined();
      expect(w.hints.icNumber, `${loc} people.wizard.hints.icNumber`).toBeUndefined();
      // The surviving definition — the one both screens now read.
      for (const k of [
        'nationality',
        'nationalitySearchPlaceholder',
        'nationalityNoResults',
        'optionNotSet',
        'optionLegacySuffix',
        'icNumber',
        'icNumberHint',
        'icDobInvalidDate',
      ]) {
        expect(String(msgs.people.detail[k] ?? '').trim(), `${loc} people.detail.${k}`).not.toBe('');
      }
    }
  });
});

// ── §4 behaviour ──────────────────────────────────────────────────────────────────────────────────
describe('§4 a hire can now carry the values the wizard could not offer', () => {
  it('creates an employee with a marital status the old wizard had no option for', async () => {
    const a = adminCtx(b);
    const { id } = await saveEmployeeDraft(a, {
      data: draft({ profile: { ...draft().profile, gender: 'undisclosed', maritalStatus: 'divorced' } }),
      currentStep: 5,
    });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    expect(p.maritalStatus).toBe('divorced');
    expect(p.gender).toBe('undisclosed');
  });

  it('group 8 — a nationality picked in the wizard lands on the person, so the Personnel NRIC card shows', async () => {
    // The whole point of group 8. Before it, this column was ALWAYS null for a wizard-created employee,
    // and item 357faecf hides the Identity No (NRIC) card whenever it is not a local nationality — so the
    // identity number captured two fields earlier could not be seen or corrected on the Personnel screen.
    const a = adminCtx(b);
    const { id } = await saveEmployeeDraft(a, {
      data: draft({
        profile: { ...draft().profile, nationality: 'Malaysian', icNumber: '900101015555' },
      }),
      currentStep: 5,
    });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    expect(p.nationality).toBe('Malaysian');
    // The gate the Personnel screen applies, run against what was actually stored.
    expect(isMalaysianNationality(p.nationality)).toBe(true);
  });

  it('group 8 — the IC-derived SOCSO number default now fires for a wizard hire, as it does on Personnel', async () => {
    // This is what the nationality UNBLOCKED. defaultSocsoEisNumber keys on nationality, so group 7 had to
    // pass undefined and the wizard stored no number at all; PERKESO registers locals under their MyKad.
    const a = adminCtx(b);
    const { id } = await saveEmployeeDraft(a, {
      data: draft({
        profile: { ...draft().profile, nationality: 'Malaysian', icNumber: '900101-01-5555' },
        statutory: { epfNumber: 'E-100200' },
      }),
      currentStep: 5,
    });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const [st] = await owner.db
      .select({ socsoNumber: schema.employeeStatutoryMy.socsoNumber })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    // NORMALISED — the dashes HR typed are not part of a MyKad registration number.
    expect(st.socsoNumber).toBe('900101015555');
  });

  it('group 8 — a number HR actually typed is never overwritten by the default', async () => {
    const a = adminCtx(b);
    const { id } = await saveEmployeeDraft(a, {
      data: draft({
        profile: { ...draft().profile, nationality: 'Malaysian', icNumber: '900101015555' },
        statutory: { socsoNumber: 'S-ENTERED-BY-HAND' },
      }),
      currentStep: 5,
    });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const [st] = await owner.db
      .select({ socsoNumber: schema.employeeStatutoryMy.socsoNumber })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(st.socsoNumber).toBe('S-ENTERED-BY-HAND');
  });
});

// ── §5 draft compatibility ────────────────────────────────────────────────────────────────────────
describe('§5 a draft saved BEFORE this change still opens and still creates', () => {
  it('reopens with its old two-vocabulary values intact', async () => {
    const a = adminCtx(b);
    // Written exactly as the pre-change wizard wrote it: the same keys, values from the old short lists.
    // The payload shape did not change in this group — profile.gender / profile.maritalStatus are still
    // plain strings in the same place — which is why no version marker is needed here. A group that DOES
    // move a key must version the payload or tolerate the old one; this one does not move any.
    const legacy = draft({
      profile: { ...draft().profile, gender: 'male', maritalStatus: 'single' },
    });
    const { id } = await saveEmployeeDraft(a, { data: legacy, currentStep: 2 });

    const reopened = await getEmployeeDraft(a, id);
    expect(reopened).not.toBeNull();
    expect(reopened!.data.profile?.gender).toBe('male');
    expect(reopened!.data.profile?.maritalStatus).toBe('single');
    expect(reopened!.currentStep).toBe(2);
    // Every other section survives untouched — nothing about this refactor rewrites a stored draft.
    expect(reopened!.data.employment?.companyId).toBe(b.companyId);
    expect(reopened!.data.payroll?.basicSalary).toBe('5200');

    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    expect(p.gender).toBe('male');
    expect(p.maritalStatus).toBe('single');
  });

  it('a pre-change draft that carries a daily pay structure still creates it intact', async () => {
    const a = adminCtx(b);
    // Group 2 changed which of these three inputs is VISIBLE, not where they are stored: payroll.payMode /
    // paymentTerm / rateAmount are still plain strings in the same place. A draft written by the old
    // wizard must therefore create exactly what it always did.
    const { id } = await saveEmployeeDraft(a, {
      data: draft({ payroll: { basicSalary: '4000', payMode: 'daily', paymentTerm: 'weekly', rateAmount: '180' } }),
      currentStep: 4,
    });
    const reopened = await getEmployeeDraft(a, id);
    expect(reopened!.data.payroll).toMatchObject({ payMode: 'daily', paymentTerm: 'weekly', rateAmount: '180' });

    const { employmentId } = await completeEmployeeDraft(a, id);
    const [comp] = await owner.db
      .select({
        payMode: schema.compensation.payMode,
        paymentTerm: schema.compensation.paymentTerm,
        rateAmount: schema.compensation.rateAmount,
      })
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(comp.payMode).toBe('daily');
    expect(comp.paymentTerm).toBe('weekly');
    expect(Number(comp.rateAmount)).toBe(180);
  });

  it('a pre-change draft carrying a date of birth still reopens on it and still stores it', async () => {
    const a = adminCtx(b);
    // Group 3 added an Age BESIDE the date, and the age is not stored — so the draft payload is byte-for-byte
    // what the old wizard wrote: profile.dateOfBirth, a plain yyyy-mm-dd string in the same place. No version
    // marker is needed because no key moved; this asserts that claim rather than trusting it.
    const { id } = await saveEmployeeDraft(a, {
      data: draft({ profile: { ...draft().profile, dateOfBirth: '1990-01-01' } }),
      currentStep: 2,
    });
    const reopened = await getEmployeeDraft(a, id);
    expect(reopened!.data.profile?.dateOfBirth).toBe('1990-01-01');
    // Nothing named 'age' was invented in the payload — an age that is saved is wrong the next day.
    expect(reopened!.data.profile).not.toHaveProperty('age');

    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    expect(p.dateOfBirth).toBe('1990-01-01');
  });

  it('a pre-change draft whose EPF citizenship was left "— Not set —" creates exactly what it always did', async () => {
    const a = adminCtx(b);
    // The old wizard wrote `epfCitizenship: ''` when HR picked its "— Not set —" option. Group 4 removed
    // that option (the column is NOT NULL DEFAULT 'citizen', so it never meant anything), and a draft that
    // already holds the blank must still open and still create the same row it would have created before.
    //
    // ITEM 35524d1f — the IC is NO LONGER supplied here. An earlier revision of this test passed one on
    // purpose to work around a live defect it had found: `completeEmployeeDraft` calls `pack.statutory.set`
    // whenever ANY statutory field is non-blank (`hasAnyStatutory`), and the setter opened with
    // `if (!isValidIC(p.icNumber)) throw new InvalidICError()`, which rejects a blank too. So a draft that
    // filled in an EPF number but left Identity No blank — which the wizard explicitly allows, because item
    // e3ce0d4d made the IC optional for passport holders — failed at "Create Employee" with "Invalid
    // Malaysian IC number (expected 12 digits)" for a field no step marks required. The cure it deferred
    // (store a null IC rather than skip the statutory write) is now in the setter, so the workaround comes
    // out and the blank IC IS the case: the employee is created and the EPF number is kept.
    const { id } = await saveEmployeeDraft(a, {
      data: draft({ statutory: { epfNumber: 'E-778899', epfCitizenship: '' } }),
      currentStep: 3,
    });
    const reopened = await getEmployeeDraft(a, id);
    expect(reopened!.data.statutory).toMatchObject({ epfNumber: 'E-778899', epfCitizenship: '' });

    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const [st] = await owner.db
      .select({
        icNumber: schema.employeeStatutoryMy.icNumber,
        epfNumber: schema.employeeStatutoryMy.epfNumber,
        epfCitizenship: schema.employeeStatutoryMy.epfCitizenship,
      })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(st.epfNumber).toBe('E-778899');
    // Stored, not discarded — a passport holder's statutory details survive an absent MyKad.
    expect(st.icNumber).toBeNull();
    // The column default — the value the removed "— Not set —" option produced all along.
    expect(st.epfCitizenship).toBe('citizen');
  });

  it('group 8 — a pre-change draft has NO nationality, and still creates exactly what it always did', async () => {
    const a = adminCtx(b);
    // Written exactly as the pre-change wizard wrote it: an Identity No and no nationality key at all,
    // because the field did not exist. The one place this refactor could lose somebody's work is by
    // demanding a value an old draft cannot have — nationality is optional in `missingByStep` for that
    // reason, so this must reopen and create with no complaint.
    const legacy = draft({ profile: { ...draft().profile, icNumber: '900101015555' } });
    expect(legacy.profile).not.toHaveProperty('nationality');
    const { id } = await saveEmployeeDraft(a, { data: legacy, currentStep: 1 });

    const reopened = await getEmployeeDraft(a, id);
    expect(reopened).not.toBeNull();
    expect(reopened!.data.profile?.nationality).toBeUndefined();
    expect(reopened!.data.profile?.icNumber).toBe('900101015555');

    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    // NULL, exactly as before — the wizard never wrote this column, and this change must not invent a
    // value for it. Anything else would be guessing a nationality from an identity number, which is how a
    // foreign worker gets filed under a Malaysian SOCSO registration.
    expect(p.nationality).toBeNull();
    const [st] = await owner.db
      .select({ icNumber: schema.employeeStatutoryMy.icNumber, socsoNumber: schema.employeeStatutoryMy.socsoNumber })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(st.icNumber).toBe('900101015555');
    // No nationality ⇒ no IC-derived default ⇒ the same blank the old wizard produced.
    expect(st.socsoNumber).toBeNull();
  });

  it('a draft with NO personal details at all still creates (the fields stay optional)', async () => {
    const a = adminCtx(b);
    const { id } = await saveEmployeeDraft(a, { data: draft(), currentStep: 1 });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    const p = await readPerson(emp.personId);
    expect(p.gender).toBeNull();
    expect(p.maritalStatus).toBeNull();
  });
});
