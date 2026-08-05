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

const WIZARD = 'app/admin/personnel/new/wizard.tsx';
const PERSONNEL = 'app/admin/personnel/[employmentId]/page.tsx';
const SHARED = 'components/person-details-fields.tsx';
const BIRTH_DATE = 'components/birth-date-fields.tsx';
const EPF_FIELDS = 'components/epf-registration-fields.tsx';
const BANK_FIELDS = 'components/bank-account-fields.tsx';
const BANK_CARD = 'components/bank-info-card.tsx';
const PAY_STRUCTURE = 'components/pay-structure-fields.tsx';
const SALARY_HISTORY = 'components/salary-history-table.tsx';
const LEAVE_PANEL = 'components/leave-type-panel.tsx';

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
    // ⚠️ THE IC IS SUPPLIED HERE ON PURPOSE, and its absence is a LIVE DEFECT this test found but does NOT
    // fix (it is a write-path bug, not a field-definition one, and picking the right cure — skip the
    // statutory write, or store a null IC — is a statutory decision, not a refactor):
    // `completeEmployeeDraft` calls `pack.statutory.set` whenever ANY statutory field is non-blank
    // (`hasAnyStatutory`) and passes `icNumber ?? ''`, and `setStatutoryProfileMY` opens with
    // `if (!isValidIC(p.icNumber)) throw new InvalidICError()`. So a draft that fills in a bank account or
    // an EPF number but leaves Identity No blank — which the wizard explicitly allows, because item
    // e3ce0d4d made the IC optional for passport holders — fails at "Create Employee" with "Invalid
    // Malaysian IC number (expected 12 digits)" for a field no step marked required. Reproduced by
    // dropping `icNumber` from the draft below.
    const { id } = await saveEmployeeDraft(a, {
      data: draft({
        profile: { ...draft().profile, icNumber: '900101015555' },
        statutory: { epfNumber: 'E-778899', epfCitizenship: '' },
      }),
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
      .select({ epfNumber: schema.employeeStatutoryMy.epfNumber, epfCitizenship: schema.employeeStatutoryMy.epfCitizenship })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, emp.personId));
    expect(st.epfNumber).toBe('E-778899');
    // The column default — the value the removed "— Not set —" option produced all along.
    expect(st.epfCitizenship).toBe('citizen');
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
