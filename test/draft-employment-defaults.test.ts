/**
 * WHAT THE EMPLOYMENT TAB SHOWS IS WHAT IT STORES — item a72610af.
 *
 * THE DEFECT, AND WHY A SOURCE GREP WOULD NOT HAVE CAUGHT IT. The Employment Type select rendered
 * `value={data.employment?.employmentType ?? 'full_time'}` and the Hire Date input
 * `value={data.employment?.hiredOn ?? today}`. Both are DISPLAY fallbacks, and neither had a matching
 * write. A draft nobody touched therefore showed "Full Time" and today's date and stored NEITHER:
 * `missingByTab` correctly reported both outstanding, Activate stayed switched off, and reopening the
 * draft showed exactly the same two values again. Two of six live production drafts were stuck in that
 * state, including one created the morning the ticket was raised.
 *
 * Nothing was wrong with the saving or the checking — they agreed with each other. The fault lived in the
 * CONTRACT BETWEEN TWO FILES: the screen that displayed the default and the blob that never received it.
 * So this file pins it across both, exactly as §8 of CLAUDE.md requires, and it does it by SAVING an
 * untouched draft and reading `employee_draft.data` back out of Postgres. Asserting that the seed is
 * computed would only prove the seed is written; these assertions prove it LANDS.
 *
 * NON-VACUITY IS ASSERTED, NOT ASSUMED. §2 below re-creates the old behaviour — the same untouched draft
 * saved WITHOUT the seed — and asserts it stores neither field and reports both outstanding. That case is
 * the defect itself, kept as a live statement of what changed, so a future revert of the fix cannot leave
 * this file green.
 *
 * NO HARDCODED DATES. Every expected date is derived from `todayInKualaLumpur()` and `computeProvisionalEndOn`,
 * the same two functions the screen derives them from, so this file does not expire.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  DEFAULT_EMPLOYMENT_TYPE,
  missingByTab,
  withEmploymentDefaults,
  type EmployeeDraftData,
} from '../lib/employee-draft-schema';
import {
  createEmployeeDraftWithReservedCode,
  getEmployeeDraft,
  saveEmployeeDraft,
} from '../core/employee-draft';
import { computeProvisionalEndOn } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

let b: Base;

/** The clock the screen reads, read the same way, so nothing here is pinned to a calendar date. */
const today = () => todayInKualaLumpur();
/** The END DATE the OLD (pre-r392) seed wrote onto a full-time draft for a company with no configured
 *  override. Still needed: drafts carrying it exist on production, and §3/§6 pin that they keep it. */
const probationDefault = () => computeProvisionalEndOn(today(), 'full_time', 3) ?? today();

/** The seed EXACTLY as app/admin/personnel/new/page.tsx applies it to a loaded draft (r392: the company's
 *  hiring-defaults probation LENGTH, 3 months when unconfigured — no longer an end date). */
const seeded = (data: EmployeeDraftData, probationMonths = 3) =>
  withEmploymentDefaults(data, { hiredOn: today(), probationMonths });

/** A draft as it really arrives after Create — through the real Create path, not a hand-built blob. */
async function createDraft(): Promise<string> {
  const { id } = await createEmployeeDraftWithReservedCode(adminCtx(b), {
    companyId: b.companyId,
    fullName: 'Nadia Yusof',
    primaryEmail: `nadia.${Math.random().toString(36).slice(2, 10)}@defaults.test`,
    employeeIdMode: 'manual',
    employeeCode: `DEF${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  });
  return id;
}

/** The blob as POSTGRES holds it — read as the owner, so no RLS session can flatter the result. */
async function storedData(id: string): Promise<EmployeeDraftData> {
  const [row] = await owner.db
    .select({ data: schema.employeeDraft.data })
    .from(schema.employeeDraft)
    .where(eq(schema.employeeDraft.id, id));
  expect(row, 'the draft row is still there').toBeTruthy();
  return row.data as EmployeeDraftData;
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

// ── §1 the landing ────────────────────────────────────────────────────────────────────────────────
describe('§1 an UNTOUCHED draft stores the two values its Employment tab shows', () => {
  it('saving without touching anything puts employmentType and hiredOn in the stored blob', async () => {
    const ctx = adminCtx(b);
    const id = await createDraft();
    const loaded = await getEmployeeDraft(ctx, id);
    expect(loaded, 'the draft loads').toBeTruthy();

    // Exactly what the screen does: the server seeds the loaded draft, the client holds it, Save posts it
    // back untouched. No field is typed anywhere in this test.
    await saveEmployeeDraft(ctx, { id, data: seeded(loaded!.data), currentStep: 2 });

    const stored = await storedData(id);
    expect(stored.employment?.employmentType, 'employee_draft.data.employment.employmentType')
      .toBe(DEFAULT_EMPLOYMENT_TYPE);
    expect(stored.employment?.hiredOn, 'employee_draft.data.employment.hiredOn').toBe(today());
  });

  it('and the Employment tab therefore reports nothing outstanding for either of them', async () => {
    const ctx = adminCtx(b);
    const id = await createDraft();
    const loaded = await getEmployeeDraft(ctx, id);
    await saveEmployeeDraft(ctx, { id, data: seeded(loaded!.data), currentStep: 2 });

    // Judged from the STORED blob, not from the in-memory copy: the reporter's complaint was that
    // reopening the draft showed the same two values and the same refusal.
    const job = missingByTab(await storedData(id)).job;
    expect(job, 'the Employment tab still needs a Department — that field genuinely is empty').toEqual([
      'department',
    ]);
  });

  it('the draft reopens carrying them, so Activate is no longer waiting on a value nobody can supply', async () => {
    const ctx = adminCtx(b);
    const id = await createDraft();
    const first = await getEmployeeDraft(ctx, id);
    await saveEmployeeDraft(ctx, { id, data: seeded(first!.data), currentStep: 2 });

    // Re-read through the service the screen re-reads through, and re-apply the seed as the page does.
    const reopened = seeded((await getEmployeeDraft(ctx, id))!.data);
    expect(reopened.employment?.employmentType).toBe(DEFAULT_EMPLOYMENT_TYPE);
    expect(reopened.employment?.hiredOn).toBe(today());
    expect(missingByTab(reopened).job).not.toContain('employmentType');
    expect(missingByTab(reopened).job).not.toContain('hiredOn');
  });
});

// ── §2 the defect itself, kept as a live statement of what changed ────────────────────────────────
describe('§2 the OLD behaviour — a display fallback with no matching write', () => {
  it('saving the loaded draft WITHOUT the seed stores neither field and refuses activation', async () => {
    const ctx = adminCtx(b);
    const id = await createDraft();
    const loaded = await getEmployeeDraft(ctx, id);

    // This is precisely what the screen used to post: the draft as loaded, with the two defaults living
    // only in the JSX. If the seed ever stops being applied, §1 goes red and this stays green — which is
    // the pair of statements that makes §1 non-vacuous.
    await saveEmployeeDraft(ctx, { id, data: loaded!.data, currentStep: 2 });

    const stored = await storedData(id);
    expect(stored.employment?.employmentType, 'nothing entered the blob').toBeUndefined();
    expect(stored.employment?.hiredOn, 'nothing entered the blob').toBeUndefined();
    expect(missingByTab(stored).job).toContain('employmentType');
    expect(missingByTab(stored).job).toContain('hiredOn');
  });
});

// ── §3 the drafts that are stuck on production right now ──────────────────────────────────────────
describe('§3 a draft already stuck in this state is unstuck WITHOUT anything being re-typed', () => {
  it('a provisional end date present, an employment type absent — the shape the live rows are in', async () => {
    const ctx = adminCtx(b);
    const id = await createDraft();
    const loaded = await getEmployeeDraft(ctx, id);

    // THE PRODUCTION SHAPE, and the reason it looks like this: the old `withProbationDefault` derived the
    // end date from `(e.employmentType ?? 'full_time')` and seeded THAT, while the type it had just
    // assumed went nowhere. So a stuck row carries a probation-derived end date and no type at all.
    const stuck: EmployeeDraftData = {
      ...loaded!.data,
      employment: {
        ...loaded!.data.employment,
        departmentId: b.deptA,
        provisionalEndOn: probationDefault(),
      },
    };
    await saveEmployeeDraft(ctx, { id, data: stuck, currentStep: 2 });
    expect(missingByTab(await storedData(id)).job, 'stuck before the fix').toEqual([
      'employmentType',
      'hiredOn',
    ]);

    // Reopening it is all it takes: the page seeds, HR presses Save (or Activate, which saves first).
    const reopened = seeded((await getEmployeeDraft(ctx, id))!.data);
    await saveEmployeeDraft(ctx, { id, data: reopened, currentStep: 2 });
    const stored = await storedData(id);
    expect(stored.employment?.employmentType).toBe(DEFAULT_EMPLOYMENT_TYPE);
    expect(stored.employment?.hiredOn).toBe(today());
    // The end date it was already carrying is untouched — it was never the problem.
    expect(stored.employment?.provisionalEndOn).toBe(probationDefault());
    // r392 — and NO probation period is seeded beside it: the legacy guard. A period would make
    // `draftProvisionalEndOn` derive a fresh end date and silently replace the one this draft was promised.
    expect(stored.employment?.probationValue, 'no period seeded over a legacy end date').toBeUndefined();
    expect(stored.employment?.probationUnit, 'no period seeded over a legacy end date').toBeUndefined();
    expect(missingByTab(stored).job, 'nothing outstanding on the Employment tab').toEqual([]);
  });
});

// ── §4 the seed's own rules ───────────────────────────────────────────────────────────────────────
describe('§4 the seed defaults, it does not overrule', () => {
  it('a type and a date the administrator chose are left exactly as they are', () => {
    const chosen: EmployeeDraftData = {
      employment: { employmentType: 'intern', hiredOn: '2024-02-29', provisionalEndOn: '2024-08-31' },
    };
    expect(seeded(chosen)).toEqual(chosen);
  });

  it('a CLEARED field stays cleared — an emptied box is a statement, not an absence', () => {
    // `''` is what a date input holds after the administrator clears it, and `undefined` is what a field
    // nobody has touched holds. Only the second is seeded, which is exactly what the `??` on the screen
    // used to mean. Re-filling a box somebody had just emptied would be this same defect, inverted.
    const cleared: EmployeeDraftData = { employment: { hiredOn: '', employmentType: 'contract' } };
    const out = seeded(cleared);
    expect(out.employment?.hiredOn, 'still cleared').toBe('');
    expect(missingByTab(out).job, 'and still named as outstanding').toContain('hiredOn');
  });

  it('the type is resolved BEFORE the probation default is decided from it', () => {
    // The ordering hazard the plan names. An untouched draft is a full-time hire, so it gets the
    // company's probation PERIOD (r392 — no longer an end date: the end is worked out from the period)…
    expect(seeded({}).employment).toEqual({
      employmentType: DEFAULT_EMPLOYMENT_TYPE,
      hiredOn: today(),
      probationValue: '3',
      probationUnit: 'month',
    });
    // …and a contract hire does NOT: the configurable default has only ever applied to full-time.
    const contract = seeded({ employment: { employmentType: 'contract' } });
    expect(contract.employment?.provisionalEndOn, 'no probation date on a contract hire').toBeUndefined();
    expect(contract.employment?.probationValue, 'no probation period on a contract hire').toBeUndefined();
    expect(contract.employment?.hiredOn, 'but the hire date is still seeded').toBe(today());
  });

  it('nothing outside the employment section is touched', () => {
    const data: EmployeeDraftData = {
      profile: { fullName: 'Nadia Yusof' },
      statutory: { epfNumber: '11223344' },
      payroll: { basicSalary: '5200' },
      family: [{ fullName: 'Farah Aziz', relationship: 'spouse' }],
    };
    const out = seeded(data);
    expect(out.profile).toEqual(data.profile);
    expect(out.statutory).toEqual(data.statutory);
    expect(out.payroll).toEqual(data.payroll);
    expect(out.family).toEqual(data.family);
  });
});

// ── §5 the wiring, so the seed cannot quietly stop being applied ──────────────────────────────────
describe('§5 the screen that shows the defaults is the screen that seeds them', () => {
  it('the continue form hands the SEEDED data to the wizard, not the raw draft', () => {
    const src = read('app/admin/personnel/new/page.tsx');
    expect(src, 'page.tsx applies the seed').toContain('withEmploymentDefaults(draft.data');
    expect(src).toMatch(/initialData=\{withEmploymentDefaults\(/);
    // The old half-fix is gone rather than sitting alongside the new one: two seeding functions is how
    // the end date and the type came to disagree in the first place.
    expect(src, 'the superseded provisional-end-only seed is gone').not.toMatch(
      /function withProbationDefault\(/,
    );
  });

  it('the wizard displays the SAME constant it stores, rather than a second literal', () => {
    const src = read('app/admin/personnel/new/wizard.tsx');
    expect(src).toContain('DEFAULT_EMPLOYMENT_TYPE');
    // The bare literal is what made the screen's answer and the blob's answer two separate claims.
    expect(src, "no second hand-typed 'full_time' on the draft screen").not.toContain("?? 'full_time'");
  });
});

// ── §6 r392 (685d2380 step 1) — the probation PERIOD is seeded, the end date no longer is ─────────────
describe('§6 a new full-time draft is seeded the company probation LENGTH, not an end date', () => {
  it('the length comes from the hiring default the page passes — 6 months here, not the code default', () => {
    const out = seeded({}, 6).employment!;
    expect(out.probationValue, 'employment.probationValue from company.probation_months').toBe('6');
    expect(out.probationUnit, 'employment.probationUnit').toBe('month');
    // THE INVERSION: before r392 this very call stored an end date. It must not any more — for a
    // full-time draft the end is DERIVED from the period, on screen and at Activate, by one function.
    expect(out.provisionalEndOn, 'no end date is seeded for a new full-time draft').toBeUndefined();
  });

  it('only when BOTH halves of the period are untouched — a cleared value stays cleared', () => {
    const cleared = seeded({ employment: { employmentType: 'full_time', probationValue: '' } });
    expect(cleared.employment?.probationValue, 'a cleared box stays cleared').toBe('');
    expect(cleared.employment?.probationUnit, 'and its unit is not filled in behind it').toBeUndefined();
    const chosen = seeded({ employment: { employmentType: 'full_time', probationUnit: 'week' } });
    expect(chosen.employment?.probationValue, 'a unit somebody picked is not paired with our value').toBeUndefined();
  });

  it('never for part-time, contract or intern', () => {
    for (const employmentType of ['part_time', 'contract', 'intern']) {
      const out = seeded({ employment: { employmentType } }).employment!;
      expect(out.probationValue, `${employmentType} probationValue`).toBeUndefined();
      expect(out.probationUnit, `${employmentType} probationUnit`).toBeUndefined();
    }
  });

  it('the page passes the hiring-defaults probation length, not an end date', () => {
    const src = read('app/admin/personnel/new/page.tsx');
    expect(src).toContain('withEmploymentDefaults(draft.data, { hiredOn: today, probationMonths })');
    expect(src, 'read from core/hiring-defaults, defaulted by resolveProbationMonths').toMatch(
      /resolveProbationMonths\(\(await getHiringDefaults\(session, draftCompanyId\)\)\?\.probationMonths\)/,
    );
  });
});
