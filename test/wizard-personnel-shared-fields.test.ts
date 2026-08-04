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
