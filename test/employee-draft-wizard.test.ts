/**
 * Create New Employee — step-by-step wizard with Save as Draft. Item 6d671f44.
 *
 * The reporter's requirements are mostly ABOUT WHAT A DRAFT IS NOT: it must not appear as an
 * employee, must not enter payroll, must not trigger statutory calculation, must not appear in
 * reports, and must not consume an Employee ID. Those are all true here by CONSTRUCTION rather than
 * by exclusion, because a draft is captured input in its own table and no employee exists until the
 * final step — so §3 proves the construction rather than testing each list read one by one.
 *
 * ITEM bd271009 EXTENDED IT. Company is now the first question (it decides which Employee ID Auto
 * Running Number Setup applies) and the Employee ID is conditionally required — §1b pins the decision,
 * §5 pins what that decision does to a real row, §6 guards the migration that makes the setup screen's
 * "Allow manual override" switch mean something for the first time.
 *
 * §1  the completeness rules (pure, shared by the browser and the server)
 * §1b the Employee ID mode resolver (pure)
 * §2  the computed-key guard — `t(`steps.${k}`)` and `t(`fields.${f}`)` are INVISIBLE to
 *     test/i18n-coverage.test.ts check C, which only resolves literal keys
 * §3  the draft lifecycle against a real database
 * §4  source guards on migration 0337 and its journal entry
 * §5  which Employee ID a wizard-created employee gets, against a real database
 * §6  source guards on migration 0355 and its journal entry
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  DRAFT_STEPS,
  draftLabel,
  missingByStep,
  missingForCreation,
  stepKey,
  stepNumber,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';
import { resolveEmployeeIdMode, type EmployeeIdRule } from '../lib/employee-id-mode';
import {
  completeEmployeeDraft,
  discardEmployeeDraft,
  employeeIdRuleFor,
  getEmployeeDraft,
  isEmployeeCodeTaken,
  listEmployeeDrafts,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { createConfig, listConfigs } from '../core/employee-id-config';
import { hireEmployee } from '../core/org';
import { movementHistory } from '../core/movement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;

/**
 * A draft that has everything creation needs, for the fixtures below.
 *
 * IT NOW CARRIES A HAND-TYPED EMPLOYEE ID, and that is the item bd271009 behaviour change made visible:
 * `seedBase` configures no Employee ID Auto Running Number Setup, and the wizard no longer falls silently
 * through to the legacy house counter for a company that has none. The bulk importer and the seeds are
 * deliberately untouched — §5 pins that with a direct `hireEmployee` call.
 */
function completeDraft(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: {
      fullName: 'Nadia Yusof',
      primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test`,
      employeeCode: `WZ${randomUUID().slice(0, 8).toUpperCase()}`,
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

// ── §1 the completeness rules ─────────────────────────────────────────────────────────────────────
describe('§1 what a draft needs before it can become an employee', () => {
  it('an empty draft is missing exactly the required fields, grouped by their own step', () => {
    const m = missingByStep({});
    // COMPANY IS ON THE PROFILE STEP (item bd271009) — it is asked first, because it decides which
    // Employee ID Auto Running Number Setup applies. It used to sit in the employment bucket.
    expect(m.profile).toEqual(['company', 'fullName', 'primaryEmail']);
    expect(m.employment).toEqual(['department', 'employmentType', 'hiredOn']);
    expect(m.statutory).toEqual([]); // nothing on Bank & Statutory is required by any writer
    expect(m.payroll).toEqual(['basicSalary']);
    expect(m.review).toEqual([]);
  });

  it('a complete draft has nothing outstanding', () => {
    expect(missingForCreation(completeDraftShape())).toEqual([]);
  });

  it('with NO rule supplied the Employee ID is not judged at all — what listEmployeeDrafts relies on', () => {
    // The OPTION-OMITTED contract, unchanged by bd271009: a caller that spans many companies (the drafts
    // list) has no single rule to apply, so it must not start reporting every draft as incomplete.
    const d = completeDraftShape();
    delete d.profile!.employeeCode;
    expect(missingForCreation(d)).toEqual([]);
    expect(missingByStep(d).profile).not.toContain('employeeCode');
  });

  it('the identity number is NOT required — e3ce0d4d allows a passport holder', () => {
    const d = completeDraftShape();
    expect(d.profile!.icNumber).toBeUndefined();
    expect(missingForCreation(d)).toEqual([]);
  });

  it('rejects a malformed email and a malformed date rather than passing them to a writer', () => {
    expect(missingByStep({ profile: { fullName: 'X', primaryEmail: 'not-an-email' } }).profile).toContain(
      'primaryEmail',
    );
    expect(missingByStep({ profile: { fullName: 'X', primaryEmail: 'a@b.co', dateOfBirth: '01/01/1990' } }).profile)
      .toContain('dateOfBirth');
    expect(missingByStep({ employment: { hiredOn: '1 June 2026' } }).employment).toContain('hiredOn');
  });

  it('mirrors the importer: bank name and account number are all-or-nothing', () => {
    expect(missingByStep({ statutory: { bankName: 'Maybank' } }).statutory).toEqual(['bankAccount']);
    expect(missingByStep({ statutory: { bankAccountNo: '514012345678' } }).statutory).toEqual(['bankAccount']);
    expect(missingByStep({ statutory: { bankName: 'Maybank', bankAccountNo: '514012345678' } }).statutory).toEqual([]);
    expect(missingByStep({ statutory: {} }).statutory).toEqual([]);
  });

  it('mirrors setCompensation: a daily or hourly pay mode needs a positive rate', () => {
    const base = { payroll: { basicSalary: '5000', payMode: 'daily' } };
    expect(missingByStep(base).payroll).toContain('rateAmount');
    expect(missingByStep({ payroll: { ...base.payroll, rateAmount: '180' } }).payroll).not.toContain('rateAmount');
    // A monthly worker needs no rate at all.
    expect(missingByStep({ payroll: { basicSalary: '5000', payMode: 'monthly' } }).payroll).toEqual([]);
  });

  it('rejects a zero or negative salary, not merely a blank one', () => {
    expect(missingByStep({ payroll: { basicSalary: '0' } }).payroll).toContain('basicSalary');
    expect(missingByStep({ payroll: { basicSalary: '-100' } }).payroll).toContain('basicSalary');
    expect(missingByStep({ payroll: { basicSalary: 'abc' } }).payroll).toContain('basicSalary');
  });

  it('step numbers and keys round-trip, and the label comes from the name typed so far', () => {
    for (const k of DRAFT_STEPS) expect(stepKey(stepNumber(k))).toBe(k);
    // Out-of-range clamps rather than returning undefined — a stored step from a future version of
    // the wizard must still open something.
    expect(stepKey(0)).toBe(DRAFT_STEPS[0]);
    expect(stepKey(99)).toBe(DRAFT_STEPS[DRAFT_STEPS.length - 1]);
    expect(draftLabel({ profile: { fullName: '  Nadia Yusof ' } })).toBe('Nadia Yusof');
    expect(draftLabel({})).toBe('');
  });
});

/** Pure (DB-free) twin of `completeDraft` for the §1 unit tests. */
function completeDraftShape(): EmployeeDraftData {
  return {
    profile: { fullName: 'Nadia Yusof', primaryEmail: 'nadia@demo.test' },
    employment: {
      companyId: 'c1',
      departmentId: 'd1',
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    },
    payroll: { basicSalary: '5200' },
  };
}

// ── §1b the Employee ID mode (item bd271009) ──────────────────────────────────────────────────────
//
// ONE resolver decides three things that must never disagree: which radio is on, whether the Profile
// step shows a tick, and whether `completeEmployeeDraft` will accept the draft. These are pure, so they
// run without a database and pin the decision itself rather than any one of its three consumers.
describe('§1b the Employee ID mode decides whether the ID is required', () => {
  const rule = (over: Partial<EmployeeIdRule> = {}): EmployeeIdRule => ({
    hasConfig: true,
    scope: 'company',
    prefix: 'ABC',
    suffix: '',
    numberLength: 6,
    nextNumber: 123,
    sampleCode: 'ABC000123',
    allowManualOverride: true,
    ...over,
  });

  it('Auto Running Number is the default, and it needs no typed ID', () => {
    const d = resolveEmployeeIdMode(rule(), {});
    expect(d).toEqual({ mode: 'auto', choosable: true, forcedBecause: null, codeRequired: false });
    const draft = completeDraftShape();
    expect(missingForCreation(draft, { employeeIdRule: rule() })).toEqual([]);
  });

  it('Manual Key In makes the Employee ID required, ON THE PROFILE STEP', () => {
    const d = resolveEmployeeIdMode(rule(), { chosen: 'manual' });
    expect(d).toMatchObject({ mode: 'manual', choosable: true, codeRequired: true });
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    const m = missingByStep(draft, { employeeIdRule: rule() });
    expect(m.profile).toContain('employeeCode');
    expect(m.employment).not.toContain('employeeCode');
    // Typing one satisfies it.
    draft.profile!.employeeCode = 'X-777';
    expect(missingForCreation(draft, { employeeIdRule: rule() })).toEqual([]);
  });

  it('NO setup for the company forces Manual and REQUIRES the ID — the one behaviour that changes', () => {
    // Today a blank ID here falls silently through to the legacy house counter (EMP-####). That is
    // where the unrecognised IDs came from, and it is what the reporter asked to stop.
    const d = resolveEmployeeIdMode(null, {});
    expect(d).toEqual({ mode: 'manual', choosable: false, forcedBecause: 'noConfig', codeRequired: true });
    expect(resolveEmployeeIdMode(rule({ hasConfig: false }), { chosen: 'auto' })).toMatchObject({
      mode: 'manual',
      forcedBecause: 'noConfig',
    });
    expect(missingForCreation(completeDraftShape(), { employeeIdRule: null })).toEqual(['employeeCode']);
  });

  it('"Allow manual override" off beats a stale remembered choice, and takes the choice away', () => {
    const off = rule({ allowManualOverride: false });
    // The draft remembers 'manual' from before the switch was turned off. The LIVE rule overrules it.
    const d = resolveEmployeeIdMode(off, { chosen: 'manual', hasCode: true });
    expect(d).toEqual({ mode: 'auto', choosable: false, forcedBecause: 'manualNotAllowed', codeRequired: false });
    // And a leftover code does not make the draft incomplete — it is simply not used.
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    expect(missingForCreation(draft, { employeeIdRule: off })).toEqual([]);
  });

  it('a draft written before this screen existed reads as Manual when it already carries an ID', () => {
    expect(resolveEmployeeIdMode(rule(), { hasCode: true })).toMatchObject({ mode: 'manual', codeRequired: true });
    // …and as Auto when it does not.
    expect(resolveEmployeeIdMode(rule(), { hasCode: false })).toMatchObject({ mode: 'auto' });
    // A junk stored value is not obeyed: it falls back to the same default.
    expect(resolveEmployeeIdMode(rule(), { chosen: 'whatever' })).toMatchObject({ mode: 'auto' });
  });

  it('omitting the option entirely leaves the Employee ID unjudged, whatever the draft says', () => {
    const draft = completeDraftShape();
    draft.profile!.employeeIdMode = 'manual';
    expect(missingForCreation(draft)).toEqual([]);
  });
});

// ── §2 the computed-key guard ─────────────────────────────────────────────────────────────────────
describe('§2 every computed translation key resolves, in all six locales', () => {
  it('t(`steps.${k}`) — one for every step', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      for (const k of DRAFT_STEPS) {
        expect(String(msgs.people?.wizard?.steps?.[k] ?? '').trim(), `${loc} steps.${k}`).not.toBe('');
      }
    }
  });

  it('t(`fields.${f}`) — every field name missingByStep can ever return', () => {
    // Enumerated from the rule itself rather than hand-listed: drive it with inputs that trip every
    // branch, so a new required field added to `missingByStep` without a label fails HERE.
    const trip: [EmployeeDraftData, Parameters<typeof missingForCreation>[1]?][] = [
      [{}],
      [{ profile: { fullName: 'X', primaryEmail: 'bad', dateOfBirth: 'nope' } }],
      [{ employment: { provisionalEndOn: 'nope' } }],
      [{ statutory: { bankName: 'Maybank' } }],
      [{ payroll: { basicSalary: '1', payMode: 'hourly' } }],
      // item bd271009 — the Manual Key In branch, which is reachable ONLY with a rule supplied.
      [{}, { employeeIdRule: null }],
    ];
    const names = new Set(trip.flatMap(([d, o]) => (o ? missingForCreation(d, o) : missingForCreation(d))));
    // Sanity: the sweep really did reach every step's rules.
    for (const expected of ['fullName', 'primaryEmail', 'dateOfBirth', 'company', 'department',
      'employmentType', 'hiredOn', 'provisionalEndOn', 'bankAccount', 'basicSalary', 'rateAmount',
      'employeeCode']) {
      expect(names.has(expected), expected).toBe(true);
    }
    for (const loc of LOCALES) {
      const msgs = JSON.parse(read(`messages/${loc}.json`));
      for (const n of names) {
        expect(String(msgs.people?.wizard?.fields?.[n] ?? '').trim(), `${loc} fields.${n}`).not.toBe('');
      }
    }
  });

  it('the interpolated wizard strings keep their placeholders in every language', () => {
    const withVars: [string, string[]][] = [
      ['continueDraft', ['{count}']],
      ['stepOf', ['{current}', '{total}']],
      ['missingCount', ['{count}']],
      ['lastSaved', ['{when}']],
      ['startedBy', ['{name}']],
    ];
    for (const loc of LOCALES) {
      const w = JSON.parse(read(`messages/${loc}.json`)).people.wizard;
      for (const [k, vars] of withVars) {
        for (const v of vars) expect(String(w[k]), `${loc}.${k}`).toContain(v);
      }
    }
  });

  it('every Employee ID string exists in all six locales, placeholders intact (item bd271009)', () => {
    // A missing {code} here is the difference between naming the clashing ID and telling HR that
    // something, somewhere, is already taken — the whole value of the message.
    const plain = ['heading', 'chooseCompanyFirst', 'noSetup', 'modeLabel', 'modeAuto', 'modeManual',
      'forcedAuto', 'previewNote', 'checking', 'removeCode', 'draftCostsNothing'];
    const withVars: [string, string][] = [
      ['ruleCompany', '{sample}'],
      ['ruleGlobal', '{sample}'],
      ['duplicate', '{code}'],
      ['available', '{code}'],
      ['staleCode', '{code}'],
    ];
    for (const loc of LOCALES) {
      const w = JSON.parse(read(`messages/${loc}.json`)).people.wizard;
      for (const k of plain) expect(String(w.employeeId?.[k] ?? '').trim(), `${loc} employeeId.${k}`).not.toBe('');
      for (const [k, v] of withVars) expect(String(w.employeeId?.[k] ?? ''), `${loc} employeeId.${k}`).toContain(v);
      // The two strings the relocated Company field needs.
      expect(String(w.companyOnProfileStep ?? '').trim(), `${loc} companyOnProfileStep`).not.toBe('');
      expect(String(w.hints?.company ?? '').trim(), `${loc} hints.company`).not.toBe('');
      expect(String(w.requiredField ?? '').trim(), `${loc} requiredField`).not.toBe('');
    }
  });
});

// ── §3 the lifecycle, against a real database ─────────────────────────────────────────────────────
describe('§3 a draft creates nothing until it is completed', () => {
  it('saving a draft creates NO person, NO employment and NO employee code', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: completeDraft(), currentStep: 2 });
    expect(id).toBeTruthy();
    expect(await counts()).toEqual(before);
    // And it is readable back exactly as saved.
    const got = await getEmployeeDraft(ctx, id);
    expect(got?.currentStep).toBe(2);
    expect(got?.data.profile?.fullName).toBe('Nadia Yusof');
  });

  it('the list derives its label and company from the payload, and recomputes what is outstanding', async () => {
    const ctx = adminCtx(b);
    await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'Half Done' } }, currentStep: 1 });
    const rows = await listEmployeeDrafts(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Half Done');
    expect(rows[0].companyId).toBeNull();
    expect(rows[0].missing.length).toBeGreaterThan(0);
  });

  it('an update replaces the payload rather than creating a second draft', async () => {
    const ctx = adminCtx(b);
    const { id } = await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'First' } }, currentStep: 1 });
    const again = await saveEmployeeDraft(ctx, { id, data: { profile: { fullName: 'Second' } }, currentStep: 3 });
    expect(again.id).toBe(id);
    expect(await listEmployeeDrafts(ctx)).toHaveLength(1);
    expect((await getEmployeeDraft(ctx, id))?.data.profile?.fullName).toBe('Second');
  });

  it('refuses to complete an incomplete draft, and still creates nothing', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: { profile: { fullName: 'Half' } }, currentStep: 1 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Cannot create the employee yet/);
    expect(await counts()).toEqual(before);
    // The draft survives the refusal — losing the typed work would be the worse failure.
    expect(await getEmployeeDraft(ctx, id)).not.toBeNull();
  });

  it('completing it creates the employee through the real writers, and the draft stops existing', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft({ payroll: { basicSalary: '5200', monthlyAllowance: '400' } });
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);

    // Assert the created row FIELD BY FIELD, not by counting — r73 Decision 3's lesson (a writer
    // silently dropping a column it predates surfaces only this way).
    const [emp] = await owner.db
      .select({
        companyId: schema.employment.companyId,
        hiredOn: schema.employment.hiredOn,
        joinDate: schema.employment.joinDate,
        employeeCode: schema.employment.employeeCode,
        personId: schema.employment.personId,
      })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(emp.companyId).toBe(b.companyId);
    expect(emp.hiredOn).toBe('2026-06-01');
    // 89ea527b — the two dates start identical, seeded by hireEmployee.
    expect(emp.joinDate).toBe('2026-06-01');
    // The Employee ID is generated HERE and only here.
    expect(emp.employeeCode).toBeTruthy();

    const [p] = await owner.db
      .select({ fullName: schema.person.fullName, email: schema.person.primaryEmail })
      .from(schema.person)
      .where(eq(schema.person.id, emp.personId));
    expect(p.fullName).toBe('Nadia Yusof');
    expect(p.email).toBe(data.profile!.primaryEmail);

    // The initial assignment carries the department and the employment type.
    const [a] = await owner.db
      .select({ departmentId: schema.assignment.departmentId, employmentType: schema.assignment.employmentType })
      .from(schema.assignment)
      .where(eq(schema.assignment.employmentId, employmentId));
    expect(a.departmentId).toBe(b.deptA);
    expect(a.employmentType).toBe('full_time');

    // Compensation was set from the draft, effective from the join date.
    const [c] = await owner.db
      .select({ basic: schema.compensation.basicSalary, from: schema.compensation.validFrom })
      .from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employmentId));
    expect(Number(c.basic)).toBe(5200);
    expect(c.from).toBe('2026-06-01');

    // The draft is gone, and the completion is on the audit trail.
    expect(await getEmployeeDraft(ctx, id)).toBeNull();
    expect(await listEmployeeDrafts(ctx)).toHaveLength(0);
    const [ev] = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'employee-draft.completed'));
    expect(ev?.type).toBe('employee-draft.completed');
  });

  it('opens Employment History with exactly ONE Hired row — no spurious second row', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft();
    data.employment!.reportingManagerEmploymentId = undefined;
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    // r78 (4d391ab7): the initial assignment is SYNTHESIZED as the Hired row from the employment
    // itself. Emitting a movement event for it would give every new employee TWO rows for one
    // action — the exact fault that round fixed for the hire-time reporting line. This asserts the
    // PROJECTION, not the event log, because the projection is what the reporter actually sees.
    const history = await movementHistory(ctx, employmentId);
    expect(history.filter((r) => r.kind === 'hired')).toHaveLength(1);
    // A wizard-created employee DOES have an `employment.hired` event, so its Hired row is the
    // event-derived one with a real entry date — core/movement.ts only synthesizes an entry-date-less
    // Hired row for seed/legacy employments that never had the event. What matters here is the COUNT.
    // Exactly ONE row, and it is the Hired row. The initial salary is deliberately part of Hired
    // rather than a movement of its own (core/movement.ts: "Initial salary at hire is part of Hired"),
    // which is why a correct wizard produces a single-row history for a brand-new employee.
    expect(history.map((r) => r.kind)).toEqual(['hired']);
    // And nothing recorded a movement of its own.
    const recorded = await owner.db
      .select({ type: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.subjectEmploymentId, employmentId));
    expect(recorded.map((r) => r.type)).not.toContain('employment.movement.recorded');
  });

  it('discarding a draft removes it and creates nothing', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: completeDraft(), currentStep: 3 });
    await discardEmployeeDraft(ctx, id);
    expect(await listEmployeeDrafts(ctx)).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  it('a non-admin cannot save, complete or discard', async () => {
    const employee = { ...adminCtx(b), roles: ['employee'] };
    await expect(saveEmployeeDraft(employee, { data: {}, currentStep: 1 })).rejects.toThrow(/Only an admin/);
    await expect(completeEmployeeDraft(employee, randomUUID())).rejects.toThrow(/Only an admin/);
    await expect(discardEmployeeDraft(employee, randomUUID())).rejects.toThrow(/Only an admin/);
  });

  it('an invalid identity number is refused BEFORE anything is created', async () => {
    const ctx = adminCtx(b);
    const before = await counts();
    const data = completeDraft();
    data.profile!.icNumber = '12345'; // not 12 digits
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Invalid identity number/);
    expect(await counts()).toEqual(before);
  });
});

/** Person / employment counts — the two things a draft must never create. */
async function counts(): Promise<{ people: number; employments: number }> {
  const [p] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.person);
  const [e] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.employment);
  return { people: Number(p.n), employments: Number(e.n) };
}

// ── §4 the migration ──────────────────────────────────────────────────────────────────────────────
describe('§4 migration 0337', () => {
  const mig = read('db/migrations/0337_employee_draft.sql');

  it('creates the table with RLS, idempotently', () => {
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS employee_draft');
    expect(mig).toContain('ALTER TABLE employee_draft ENABLE ROW LEVEL SECURITY');
    expect(mig).toContain('DROP POLICY IF EXISTS employee_draft_rls');
    expect(mig).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON employee_draft TO ai_hr_app');
  });

  it('is visible to the AUTHOR or an admin — a different rule from an employment row', () => {
    expect(mig).toContain('app.is_admin() OR app.is_self_person(created_by_person_id)');
    // Deliberately NOT app.can_see_person: a draft is not about a person yet. Asserted against the
    // SQL only — the header comment says the same thing in prose, and a guard that trips on its own
    // explanation is a guard nobody will keep.
    const sqlOnly = mig
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(sqlOnly).not.toContain('can_see_person');
    expect(sqlOnly).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('its journal entry sits ABOVE the deployed watermark (the r84 stale-number trap)', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0337_employee_draft');
    expect(mine).toBeTruthy();
    expect(mine!.idx).toBe(337);
    // drizzle-kit reads the last applied `when` as a watermark and SILENTLY SKIPS anything below it.
    // The invariant is monotonicity against everything that runs BEFORE this migration — not against
    // every entry in the journal. Comparing against the global maximum passed in isolation and then
    // failed the moment a SIBLING agent's higher-numbered migration merged alongside it, which is an
    // integration artefact rather than the trap being guarded.
    const priorMax = Math.max(...journal.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when).toBeGreaterThan(priorMax);
  });
});

// ── §5 the Employee ID rule, against a real database (item bd271009) ──────────────────────────────
//
// §1b pins the DECISION; this pins that the decision is what actually happens to a row. Every case here
// goes through `completeEmployeeDraft`, which is the only path the wizard has.
describe('§5 which Employee ID a wizard-created employee gets', () => {
  /** A draft with NO hand-typed ID (the fixture above carries one, because seedBase has no setup). */
  const autoDraft = (over: Partial<EmployeeDraftData> = {}): EmployeeDraftData => {
    const d = completeDraft(over);
    delete d.profile!.employeeCode;
    return d;
  };
  const codeOf = async (employmentId: string) => {
    const [row] = await owner.db
      .select({ code: schema.employment.employeeCode })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    return row.code;
  };

  it('a company with NO setup refuses a blank Employee ID, and creates nothing', async () => {
    const ctx = adminCtx(b);
    // seedBase configures no Employee ID Auto Running Number Setup at all.
    expect((await employeeIdRuleFor(ctx, b.companyId)).hasConfig).toBe(false);
    const before = await counts();
    const { id } = await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/Cannot create the employee yet.*employeeCode/);
    expect(await counts()).toEqual(before);
    // The typed work survives the refusal.
    expect(await getEmployeeDraft(ctx, id)).not.toBeNull();
  });

  it('the IMPORTER path is deliberately untouched — a blank code still falls back to the legacy counter', async () => {
    // The new rule lives in the wizard's own validation, NOT inside hireEmployee, precisely so bulk
    // import and the seed corpus keep working exactly as they do today.
    const { employmentId } = await hireEmployee(adminCtx(b), {
      person: { fullName: 'Imported', primaryEmail: `imp_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    });
    expect(await codeOf(employmentId)).toBe('EMP-0001');
  });

  it('with an ACTIVE setup, Auto issues the previewed running number and advances the counter', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 123, numberLength: 6, increment: 1,
      allowManualOverride: true,
    });
    const rule = await employeeIdRuleFor(ctx, b.companyId);
    expect(rule).toMatchObject({ hasConfig: true, scope: 'company', sampleCode: 'ABC000123' });

    const { id } = await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    // The sample the wizard showed is the ID that was issued.
    expect(await codeOf(employmentId)).toBe('ABC000123');
    expect((await listConfigs(ctx))[0].currentRunningNumber).toBe(123);
  });

  it('with "Allow manual override" OFF, a hand-keyed ID is REFUSED — the switch finally does something', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: false,
    });
    const before = await counts();
    const data = completeDraft(); // carries a hand-typed ID
    data.profile!.employeeIdMode = 'manual';
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/does not allow manual entry/);
    expect(await counts()).toEqual(before);
  });

  it('with the switch ON, a hand-keyed ID is honoured and the running counter does NOT move', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: true,
    });
    const data = completeDraft({ profile: { fullName: 'Manual Mary', primaryEmail: `mm_${randomUUID().slice(0, 8)}@t.local`, employeeCode: 'X-777', employeeIdMode: 'manual' } });
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect(await codeOf(employmentId)).toBe('X-777');
    // Nothing was burned off the sequence — that is the "gaps are possible, duplicates are not" contract.
    expect((await listConfigs(ctx))[0].currentRunningNumber).toBe(0);
  });

  it('a code left behind by switching Manual → Auto is IGNORED, not used', async () => {
    const ctx = adminCtx(b);
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 500, numberLength: 6, increment: 1,
      allowManualOverride: true,
    });
    const data = completeDraft();
    data.profile!.employeeCode = 'LEFTOVER-1';
    data.profile!.employeeIdMode = 'auto'; // the mode on screen is the promise
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    const { employmentId } = await completeEmployeeDraft(ctx, id);
    expect(await codeOf(employmentId)).toBe('ABC000500');
  });

  it('the rule is read at CREATION, so editing the setup between draft and create is obeyed', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft(); // hand-typed ID, valid while no setup exists
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    // An administrator now adds a setup that forbids hand-keying. A rule STORED on the draft would
    // still say "manual is fine" and the wizard would promise an ID the engine will not issue.
    await createConfig(ctx, {
      companyId: b.companyId, prefix: 'ABC', startNumber: 1, numberLength: 4, increment: 1,
      allowManualOverride: false,
    });
    await expect(completeEmployeeDraft(ctx, id)).rejects.toThrow(/does not allow manual entry/);
  });

  it('the duplicate look-ahead names a clash, is case-insensitive, and a DRAFT reserves nothing', async () => {
    const ctx = adminCtx(b);
    const data = completeDraft();
    data.profile!.employeeCode = 'DUP-1';
    const { id } = await saveEmployeeDraft(ctx, { data, currentStep: 5 });
    // A saved draft has taken NOTHING — the look-ahead still says the ID is free.
    expect(await isEmployeeCodeTaken(ctx, 'DUP-1')).toBe(false);
    await completeEmployeeDraft(ctx, id);
    expect(await isEmployeeCodeTaken(ctx, 'DUP-1')).toBe(true);
    expect(await isEmployeeCodeTaken(ctx, 'dup-1')).toBe(true); // same identifier, either case
    expect(await isEmployeeCodeTaken(ctx, '  dup-1  ')).toBe(true);
    expect(await isEmployeeCodeTaken(ctx, 'DUP-2')).toBe(false);
    expect(await isEmployeeCodeTaken(ctx, '')).toBe(false);
    // And the create refuses the second one, naming it, exactly as the look-ahead warned.
    const second = completeDraft();
    second.profile!.employeeCode = 'DUP-1';
    const { id: id2 } = await saveEmployeeDraft(ctx, { data: second, currentStep: 5 });
    await expect(completeEmployeeDraft(ctx, id2)).rejects.toThrow(/Employee ID "DUP-1" is already in use/);
  });

  it('the drafts LIST still counts what it always did — it has no single rule to apply', async () => {
    const ctx = adminCtx(b);
    // A draft with no ID, for a company with no setup. `completeEmployeeDraft` would refuse it, but the
    // list spans many companies and must not start calling every such draft incomplete.
    await saveEmployeeDraft(ctx, { data: autoDraft(), currentStep: 5 });
    expect((await listEmployeeDrafts(ctx))[0].missing).toEqual([]);
  });
});

// ── §6 migration 0355 ─────────────────────────────────────────────────────────────────────────────
describe('§6 migration 0355 — allow_manual_override on existing active setups', () => {
  const mig = read('db/migrations/0355_employee_id_manual_override_default_on.sql');

  it('flips ACTIVE configs only, and touches no counter', () => {
    expect(mig).toContain('UPDATE "employee_id_config"');
    expect(mig).toContain('"allow_manual_override" = true');
    expect(mig).toContain(`"status" = 'active'`);
    // The running counters are the one thing in this table an employee's ID depends on.
    const sqlOnly = mig.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(sqlOnly).not.toContain('current_running_number');
    expect(sqlOnly).not.toContain('DELETE');
    expect(sqlOnly).not.toContain('employment');
  });

  it('its journal entry sits ABOVE everything that runs before it (the r84 stale-number trap)', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = journal.entries.find((e) => e.tag === '0355_employee_id_manual_override_default_on');
    expect(mine).toBeTruthy();
    expect(mine!.idx).toBe(355);
    const priorMax = Math.max(...journal.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when).toBeGreaterThan(priorMax);
  });

  it('a NEW setup created through the settings form starts with manual entry permitted', () => {
    // The screen's checkbox now defaults to ticked; without it, 0355 would flip the old rows on and the
    // very next setup an administrator created would silently be off again.
    expect(read('app/admin/settings/employee-id/page.tsx')).toContain('editing?.allowManualOverride ?? true');
  });
});
