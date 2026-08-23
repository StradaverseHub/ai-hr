/**
 * r219 (7966ee35) — "Replacement Leave in Lieu Option Not Available": THE REASON IS THE DELIVERABLE.
 *
 * The reporter's tenant carried nine active modules and no `toil` row at all, so
 * `replacementRequestAvailability` returned `module_off` for every employee in every company before a
 * single policy column was read — and both surfaces that asked it rendered the boolean and threw the
 * reason away. They turned the Leave config switches on, twice, against a cause that sits above Leave
 * config and cannot be reached from it. The module grant is commercial provisioning and is deliberately
 * NOT in this file, in any fixture, or in any migration: what ships is the sentence.
 *
 * ⚠️ THIS IS THE THIRD TIME A SURFACE COMPUTED A PRECISE CAUSE AND RENDERED SILENCE (`no_eligibility_match`,
 * 8ebf77ae, was the second). So this file pins the whole chain rather than one end of it:
 *
 *   1. EACH CAUSE PRODUCES ITS OWN REASON — including `first_schedule_protected`, which r219 SPLIT OUT of
 *      `not_eligible`. Those two call for opposite actions: one is a criteria list an administrator can
 *      widen, the other is a statutory floor whose only lawful remedy is the company's recorded override
 *      plus the employee's own agreement. Flattening them sent people to edit the wrong screen.
 *   2. EVERY REASON HAS COPY, in all six catalogues, admin variants included. A reason with no entry is a
 *      `MISSING_MESSAGE` behind a green tsc, a green suite and a green `next build` (AGENTS rule 6); the
 *      RENDER half of that proof is test/r219-replacement-availability-notice.dom.test.tsx.
 *   3. BOTH SURFACES MOUNT IT — the employee's own My Absence page and HR's Employee Balances view of that
 *      same employee — and neither of them maps a reason to a sentence itself. Two `if` ladders over one
 *      object is exactly how one configuration came to be described two ways last time.
 *
 * AND THE PLAN'S OTHER PROMISE, kept here: "a test that fails if anyone ever hardcodes the company list or
 * the expiry period, using two companies with different settings side by side". c1b14600 already asserted
 * that shape for the self-submission switch and the expiry; this file extends it to the two things r219
 * touches — the REASON and the First Schedule override — and closes the one gap in the original: company B
 * never actually had a request approved there, so "B's expiry is read for B's employee" was asserted
 * through `resolveExpiry` in isolation rather than end to end. Both companies now approve.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import {
  decideReplacementLeaveRequest,
  replacementRequestAvailability,
  submitReplacementLeaveRequest,
} from '../core/replacement-request';
import { REPLACEMENT_CONSENT_NOTICE, REPLACEMENT_UNAVAILABLE_COPY } from '../lib/replacement-availability';

const TODAY = '2026-07-20';
const WORKED = '2026-07-04';
/** Well after the worked date, so an expiry anchored on the wrong day is a visibly different answer. */
const DECIDED_AT = new Date('2026-07-25T03:00:00.000Z');
/** Comfortably below the RM4,000 First Schedule ceiling: this employee is owed overtime CASH by law. */
const FIRST_SCHEDULE_WAGE = 2000;

let b: Base;
let ctx: SessionContext;

const uniqEmail = () => `r219_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  ...over,
});

async function hire(p: { companyId: string; departmentId: string; basic?: number }) {
  const e = await hireEmployee(ctx, {
    person: { fullName: 'R219 Requester', primaryEmail: uniqEmail() },
    companyId: p.companyId,
    departmentId: p.departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: p.basic ?? 8000,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  return e.employmentId;
}

/** A second company in the SAME tenant, with its own department to hire into. */
async function secondCompany(name: string) {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: name })
    .returning({ id: schema.company.id });
  const [dept] = await owner.db
    .insert(schema.department)
    .values({ tenantId: b.tenantId, companyId: co.id, name: `${name} Ops` })
    .returning({ id: schema.department.id });
  return { companyId: co.id, departmentId: dept.id };
}

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
/** Source-shape guards read CODE, not prose — AGENTS rule 27: no scanner in this repo strips comments. */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ── 1. Each cause resolves to its OWN reason ─────────────────────────────────────────────────────────
describe('r219: every refusal names its own cause', () => {
  it("THE REPORTER'S CASE — no toil row at all ⇒ module_off, even with the policy fully switched on", async () => {
    // Reproduced in the shape production actually had it: `setModule(…, null)` DELETES the row rather than
    // writing `disabled`, because "no row for this tenant" is what was measured on 2026-08-21 and a
    // disabled row is a different state that a future entitlements change could resolve differently.
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA });
    // Everything below the module is CORRECT and stays correct — this is the reporter's configuration.
    await setToilPolicy(ctx, policy(b.companyId));
    expect((await replacementRequestAvailability(ctx, employmentId, TODAY)).allowed).toBe(true);

    await setModule(b.tenantId, 'toil', null);
    const withoutModule = await entitledCtx(b);
    const avail = await replacementRequestAvailability(withoutModule, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    // Not `not_enabled`: the policy IS enabled. The whole defect was a screen that could not tell the
    // customer which of those two it was, so they went and re-checked the one that was already right.
    expect(avail.reason).toBe('module_off');
  });

  it('no employment on record ⇒ no_employment, not a policy verdict', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    await setToilPolicy(ctx, policy(b.companyId));
    const avail = await replacementRequestAvailability(ctx, '00000000-0000-0000-0000-0000000000ff', TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('no_employment');
  });

  it("the company's Enable switch off ⇒ not_enabled", async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA });
    // Enable OFF while employee submission is ON, so the two switches cannot be confused for each other.
    await setToilPolicy(ctx, policy(b.companyId, { enabled: false, employeeRequestEnabled: true }));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('not_enabled');
  });

  it('THE OTHER COMPANY SWITCH — employee submission off ⇒ employee_requests_off, not not_enabled', async () => {
    // The approved plan enumerates these to the reporter as two separate causes and they are: with
    // `enabled` off nothing about replacement leave works, while with only this one off the company still
    // banks credits off the roster and merely does not let employees ask. One name for both would have
    // left the screen saying "one of these two switches is off" — the guess they were already making.
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA });
    await setToilPolicy(ctx, policy(b.companyId, { enabled: true, employeeRequestEnabled: false }));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('employee_requests_off');
    expect(avail.reason).not.toBe('not_enabled');
  });

  it('a company with NO replacement-leave policy row at all ⇒ not_enabled', async () => {
    // The third state the old single name covered, and the one with no switch to point at yet. It shares
    // `not_enabled` on purpose: the remedy is the same first switch, which does not exist until the
    // company's policy is saved for the first time.
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA });
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('not_enabled');
  });

  it('outside the eligibility criteria ⇒ not_eligible', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const outside = await hire({ companyId: b.companyId, departmentId: b.deptB });
    await setToilPolicy(ctx, policy(b.companyId, { requestEligibility: { departmentIds: [b.deptA] } }));
    const avail = await replacementRequestAvailability(ctx, outside, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('not_eligible');
  });

  it('THE r219 SPLIT — the statutory floor ⇒ first_schedule_protected, NEVER not_eligible', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    // Inside the criteria in every respect. The ONLY thing stopping this employee is the overtime
    // protection rule, and before r219 the screen would have sent an administrator to widen a criteria
    // list that already included them.
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA, basic: FIRST_SCHEDULE_WAGE });
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: false }));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(false);
    expect(avail.reason).toBe('first_schedule_protected');
    expect(avail.reason).not.toBe('not_eligible');
  });

  it('inside the First Schedule WITH the company override ⇒ allowed, and the consent flag is set', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const employmentId = await hire({ companyId: b.companyId, departmentId: b.deptA, basic: FIRST_SCHEDULE_WAGE });
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: true }));
    const avail = await replacementRequestAvailability(ctx, employmentId, TODAY);
    expect(avail.allowed).toBe(true);
    // The one ALLOWED state the notice still says something about — the form is about to ask this person
    // to trade statutory overtime cash for banked time, which is a legal position, not a preference.
    expect(avail.requiresFirstScheduleConsent).toBe(true);
  });
});

// ── 2. Every reason has copy, in every catalogue ─────────────────────────────────────────────────────
describe('r219: no reason can reach a screen without a sentence', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const catalogue = (loc: string) => JSON.parse(read(`messages/${loc}.json`)) as Record<string, unknown>;
  const at = (root: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), root);

  it('the copy map covers exactly the reasons the service can return', () => {
    // Read off the SERVICE, not off a second hand-kept list: `replacementRequestAvailability` types its
    // `reason` from the same union `REPLACEMENT_UNAVAILABLE_COPY` is keyed by, so a sixth reason added
    // there fails tsc here rather than rendering an empty box. This case pins the count as well, so a
    // reason DELETED from the map without being deleted from the union cannot pass unnoticed.
    expect(Object.keys(REPLACEMENT_UNAVAILABLE_COPY).sort()).toEqual([
      'employee_requests_off',
      'first_schedule_protected',
      'module_off',
      'no_employment',
      'not_eligible',
      'not_enabled',
    ]);
  });

  for (const loc of LOCALES) {
    it(`[${loc}] every mapped key resolves to a non-empty string`, () => {
      const ns = at(catalogue(loc), 'replacementRequest');
      const keys = [
        ...Object.values(REPLACEMENT_UNAVAILABLE_COPY).flatMap((c) => [c.title, c.body, ...(c.bodyAdmin ? [c.bodyAdmin] : [])]),
        REPLACEMENT_CONSENT_NOTICE.title,
        REPLACEMENT_CONSENT_NOTICE.body,
        REPLACEMENT_CONSENT_NOTICE.bodyAdmin,
      ];
      const missing = keys.filter((k) => typeof at(ns, k) !== 'string' || String(at(ns, k)).trim() === '');
      expect(missing, `${loc}: replacementRequest.${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the two reasons about a PERSON carry an admin wording; the ones about the account do not', () => {
    // Not decoration: "you are outside the criteria" and "this employee is outside the criteria" are the
    // same fact with different subjects, and HR reading about somebody else must not be told the first.
    // Where the cause is the account or the company, ONE sentence serves both audiences and a second key
    // would only be a second thing to keep in step.
    expect(REPLACEMENT_UNAVAILABLE_COPY.not_eligible.bodyAdmin).toBeTruthy();
    expect(REPLACEMENT_UNAVAILABLE_COPY.first_schedule_protected.bodyAdmin).toBeTruthy();
    expect(REPLACEMENT_UNAVAILABLE_COPY.module_off.bodyAdmin).toBeUndefined();
    expect(REPLACEMENT_UNAVAILABLE_COPY.not_enabled.bodyAdmin).toBeUndefined();
    expect(REPLACEMENT_UNAVAILABLE_COPY.employee_requests_off.bodyAdmin).toBeUndefined();
    expect(REPLACEMENT_UNAVAILABLE_COPY.no_employment.bodyAdmin).toBeUndefined();
  });
});

// ── 3. Both surfaces mount it, and neither one re-words a reason itself ──────────────────────────────
describe('r219: the employee and the admin looking that employee up are told the same cause', () => {
  const EMPLOYEE_PAGE = 'app/leave/page.tsx';
  const ADMIN_PAGE = 'app/leave/employee-balances/page.tsx';

  it('the employee page renders the notice for the SELF audience', () => {
    const src = read(EMPLOYEE_PAGE);
    expect(src).toContain('<ReplacementAvailabilityNotice availability={replacementRequest} audience="self" />');
    // …and the button gate is untouched: this item ADDED an explanation, it did not change who may submit.
    expect(src).toContain('{ess && replacementRequest.allowed && replacementLeaveTypeOptions.length > 0 && (');
  });

  it("the admin's Employee Balances page renders it for the ADMIN audience, about the selected employee", () => {
    const src = read(ADMIN_PAGE);
    expect(src).toContain('<ReplacementAvailabilityNotice availability={replacementRequest} audience="admin" />');
    expect(src).toContain('replacementRequestAvailability(session, selected.employmentId, today)');
    // Asked as of TODAY, never as of the screen's as-at date: every figure on that screen answers for
    // `asOf`, but "can this person press the button" is a question about now, and a verdict resolved
    // against a back-date would be a true sentence about the wrong day.
    expect(stripComments(src)).not.toContain('replacementRequestAvailability(session, selected.employmentId, asOf)');
  });

  for (const page of [EMPLOYEE_PAGE, ADMIN_PAGE]) {
    it(`${page} maps no reason to copy of its own`, () => {
      const code = stripComments(read(page));
      for (const reason of Object.keys(REPLACEMENT_UNAVAILABLE_COPY)) {
        expect(code, `${page} branches on ${reason} itself`).not.toContain(reason);
      }
    });
  }
});

// ── 4. Two companies, side by side, each reading its OWN settings ────────────────────────────────────
describe('r219: nothing about this workflow is hardcoded (the plan promised the reporter this case)', () => {
  /**
   * ONE TENANT, TWO COMPANIES, DIFFERENT SETTINGS, AT THE SAME MOMENT — the only shape that tells "reads
   * the company's own policy" apart from "reads a policy". Every setting below is set to a DIFFERENT value
   * per company, so a hardcoded list, a shared default, or a read that resolved the wrong company's row
   * fails on at least one assertion:
   *
   *   Company A: eligibility = its own department · expiry 3 MONTHS · First Schedule override OFF
   *   Company B: eligibility = its own named employee · expiry 90 DAYS · First Schedule override ON
   *
   * One approval date, two different expiries; one wage level, two different verdicts.
   */
  it('each company resolves its own eligibility, its own expiry period and its own First Schedule override', async () => {
    await setModule(b.tenantId, 'toil', 'active');
    ctx = await entitledCtx(b);
    const coB = await secondCompany('R219 Second Sdn Bhd');

    const inA = await hire({ companyId: b.companyId, departmentId: b.deptA });
    const inB = await hire({ companyId: coB.companyId, departmentId: coB.departmentId });

    await setToilPolicy(
      ctx,
      policy(b.companyId, {
        expiryUnit: 'months',
        expiryMonths: 3,
        requestEligibility: { departmentIds: [b.deptA] },
        allowFirstScheduleEligible: false,
      }),
    );
    await setToilPolicy(
      ctx,
      policy(coB.companyId, {
        expiryUnit: 'days',
        expiryDays: 90,
        requestEligibility: { employmentIds: [inB] },
        allowFirstScheduleEligible: true,
      }),
    );

    // 1. ELIGIBILITY is each company's own list. The two criteria have nothing in common — A names a
    //    department that exists only in A, B names one employment that exists only in B — so a resolver
    //    reading one company's list for the other refuses somebody here.
    expect((await replacementRequestAvailability(ctx, inA, TODAY)).allowed).toBe(true);
    expect((await replacementRequestAvailability(ctx, inB, TODAY)).allowed).toBe(true);

    // 2. THE FIRST SCHEDULE OVERRIDE is each company's own switch, and it is the one the notice tells an
    //    administrator to go and change — so the sentence would send them to the wrong company's screen
    //    if this were shared. Same wage, same day, opposite answers.
    const lowA = await hire({ companyId: b.companyId, departmentId: b.deptA, basic: FIRST_SCHEDULE_WAGE });
    const lowB = await hire({ companyId: coB.companyId, departmentId: coB.departmentId, basic: FIRST_SCHEDULE_WAGE });
    await setToilPolicy(
      ctx,
      policy(coB.companyId, {
        expiryUnit: 'days',
        expiryDays: 90,
        requestEligibility: { employmentIds: [inB, lowB] },
        allowFirstScheduleEligible: true,
      }),
    );
    const aLow = await replacementRequestAvailability(ctx, lowA, TODAY);
    expect(aLow.allowed).toBe(false);
    expect(aLow.reason).toBe('first_schedule_protected');
    const bLow = await replacementRequestAvailability(ctx, lowB, TODAY);
    expect(bLow.allowed).toBe(true);
    expect(bLow.requiresFirstScheduleConsent).toBe(true);

    // 3. THE EXPIRY PERIOD is each company's own, counted from the SAME approval date, and asserted END TO
    //    END rather than through the resolver in isolation — c1b14600's version never approved anything in
    //    company B, so "B's row is the one read for B's employee" was the half it could not see.
    const reqA = await submitReplacementLeaveRequest(ctx, {
      employmentId: inA,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });
    const reqB = await submitReplacementLeaveRequest(ctx, {
      employmentId: inB,
      unit: 'day',
      lines: [{ workedDate: WORKED, days: 1 }],
      today: TODAY,
    });
    const decidedA = await decideReplacementLeaveRequest(ctx, {
      requestId: reqA.requestId,
      decision: 'approved',
      decidedAt: DECIDED_AT,
    });
    const decidedB = await decideReplacementLeaveRequest(ctx, {
      requestId: reqB.requestId,
      decision: 'approved',
      decidedAt: DECIDED_AT,
    });
    expect(decidedA.expiresOn).toBe('2026-10-25'); // A: approval 2026-07-25 + 3 CALENDAR MONTHS
    expect(decidedB.expiresOn).toBe('2026-10-23'); // B: the same approval + 90 DAYS
    expect(decidedA.expiresOn).not.toBe(decidedB.expiresOn);

    // …and the stored credits carry those two different dates, so the difference survives the write.
    const accruals = await owner.db
      .select({ employmentId: schema.toilAccrual.employmentId, expiresOn: schema.toilAccrual.expiresOn })
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.tenantId, b.tenantId));
    expect(accruals.find((a) => a.employmentId === inA)?.expiresOn).toBe('2026-10-25');
    expect(accruals.find((a) => a.employmentId === inB)?.expiresOn).toBe('2026-10-23');

    // 4. THE ENABLE SWITCH is each company's own too — the third of the three settings the plan named to
    //    the reporter (Enable, self-submission, expiry period). Switched off for B ONLY: B's employee is
    //    refused with B's own reason while A's is untouched, which a shared or hardcoded read cannot do.
    await setToilPolicy(
      ctx,
      policy(coB.companyId, {
        enabled: false,
        expiryUnit: 'days',
        expiryDays: 90,
        requestEligibility: { employmentIds: [inB, lowB] },
        allowFirstScheduleEligible: true,
      }),
    );
    const bOff = await replacementRequestAvailability(ctx, inB, TODAY);
    expect(bOff.allowed).toBe(false);
    expect(bOff.reason).toBe('not_enabled');
    expect((await replacementRequestAvailability(ctx, inA, TODAY)).allowed).toBe(true);
  });
});
