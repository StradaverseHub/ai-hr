/**
 * Create New Employee — step-by-step wizard with Save as Draft. Item 6d671f44.
 *
 * The reporter's requirements are mostly ABOUT WHAT A DRAFT IS NOT: it must not appear as an
 * employee, must not enter payroll, must not trigger statutory calculation, must not appear in
 * reports, and must not consume an Employee ID. Those are all true here by CONSTRUCTION rather than
 * by exclusion, because a draft is captured input in its own table and no employee exists until the
 * final step — so §3 proves the construction rather than testing each list read one by one.
 *
 * §1 the completeness rules (pure, shared by the browser and the server)
 * §2 the computed-key guard — `t(`steps.${k}`)` and `t(`fields.${f}`)` are INVISIBLE to
 *    test/i18n-coverage.test.ts check C, which only resolves literal keys
 * §3 the draft lifecycle against a real database
 * §4 source guards on the migration and its journal entry
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
import {
  completeEmployeeDraft,
  discardEmployeeDraft,
  getEmployeeDraft,
  listEmployeeDrafts,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { movementHistory } from '../core/movement';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');
const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;

let b: Base;

/** A draft that has everything creation needs, for the fixtures below. */
function completeDraft(over: Partial<EmployeeDraftData> = {}): EmployeeDraftData {
  return {
    profile: { fullName: 'Nadia Yusof', primaryEmail: `nadia.${randomUUID().slice(0, 8)}@demo.test` },
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
    expect(m.profile).toEqual(['fullName', 'primaryEmail']);
    expect(m.employment).toEqual(['company', 'department', 'employmentType', 'hiredOn']);
    expect(m.statutory).toEqual([]); // nothing on Bank & Statutory is required by any writer
    expect(m.payroll).toEqual(['basicSalary']);
    expect(m.review).toEqual([]);
  });

  it('a complete draft has nothing outstanding', () => {
    expect(missingForCreation(completeDraftShape())).toEqual([]);
  });

  it('the Employee ID is NOT required — that is the "a draft consumes no ID" rule', () => {
    const d = completeDraftShape();
    delete d.profile!.employeeCode;
    expect(missingForCreation(d)).toEqual([]);
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
    const trip: EmployeeDraftData[] = [
      {},
      { profile: { fullName: 'X', primaryEmail: 'bad', dateOfBirth: 'nope' } },
      { employment: { provisionalEndOn: 'nope' } },
      { statutory: { bankName: 'Maybank' } },
      { payroll: { basicSalary: '1', payMode: 'hourly' } },
    ];
    const names = new Set(trip.flatMap((d) => missingForCreation(d)));
    // Sanity: the sweep really did reach every step's rules.
    for (const expected of ['fullName', 'primaryEmail', 'dateOfBirth', 'company', 'department',
      'employmentType', 'hiredOn', 'provisionalEndOn', 'bankAccount', 'basicSalary', 'rateAmount']) {
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
