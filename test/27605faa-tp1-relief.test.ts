/**
 * 27605faa — three TP1 Relief enhancements, and a hole the third of them would have made easy to fall in.
 *
 * WHAT THE TICKET ASKED FOR, AND WHAT MEASURING IT CHANGED. The plan corrected two of the three premises
 * before anything was built, and both corrections are pinned here:
 *
 *   · "Allow Admin to delete a record" — a SUBMITTED or APPROVED declaration could already be cancelled,
 *     which is right for a tax record because it keeps the history. A DRAFT could not be removed by any
 *     means at all: `cancelTp1ForPerson` refuses anything that is not submitted or approved. That is the
 *     real gap, it is wider than reported, and production held two unreachable drafts.
 *   · "Deduction month is automatically the current month" — it never was. The month is the `[month]`
 *     path segment and any month was reachable. The ONE place it was imposed is the "+ Add New TP1"
 *     button, which is a screen constant and not a rule about declarations.
 *
 * ⚠️ AND THE ONE NOBODY ASKED FOR. `requireAdminTarget` checks `isAdmin` and nothing else, so an
 * administrator could approve their OWN tax relief. Attendance and leave both refuse a decider who is
 * the subject; TP1 reduces PCB, which is money, so it should too. Measured on production before closing
 * it: two approvals carry an approver, ZERO are self-approved — so this breaks nothing that exists. It
 * belongs in THIS round because the same round adds a one-press "submit and approve", and a one-press
 * hole is a different animal from a two-screen one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  approveTp1ForPerson,
  cancelTp1ForPerson,
  discardTp1DraftForPerson,
  getTp1ByIdForPerson,
  saveTp1DraftForPerson,
  submitTp1ForPerson,
  TaxReliefError,
} from '../core/tax-relief';
import {
  adminCtx,
  closeAll,
  createAppUser,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

const ROOT = join(__dirname, '..');
const src = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
const LIST = src('app/payroll/transactions/tp1/page.tsx');
const ACTIONS = src('app/payroll/transactions/deductions-actions.ts');
const FORM = src('components/tp1-declaration-form.tsx');
const CORE = src('core/tax-relief.ts');

let b: Base;
const YEAR = 2026;

async function hire(name = 'TP1 Subject') {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `tp1_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
}

/**
 * An HR ADMIN who is also a PERSON — the case `refuseSelfApproval` exists for, and the one `adminCtx`
 * cannot express: it carries no `personId`, so `isSelf` can never be true for it.
 */
const adminAsPerson = (personId: string, role: 'hr_admin' | 'super_admin' = 'hr_admin') =>
  ({
    tenantId: b.tenantId,
    userId: b.adminUserId,
    personId,
    roles: [role],
    entitlements: harnessSnapshot(b.tenantId),
  }) satisfies SessionContext;

const statusOf = async (id: string) => {
  const [r] = await owner.db
    .select({ status: schema.tp1Relief.status })
    .from(schema.tp1Relief)
    .where(eq(schema.tp1Relief.id, id));
  return r?.status;
};

const draftFor = async (personId: string) =>
  saveTp1DraftForPerson(adminCtx(b), { personId, assessmentYear: YEAR, tp1Amount: 1200 });

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

describe('27605faa · a draft can be discarded, and only a draft', () => {
  it('discards a draft that nothing else could remove', async () => {
    const { personId } = await hire();
    const { id } = await draftFor(personId);
    expect(await statusOf(id), 'starts as a draft').toBe('draft');

    await discardTp1DraftForPerson(adminCtx(b), { personId, id });
    expect(await statusOf(id), 'cancelled, not deleted — the history is the point').toBe('cancelled');
  });

  /** THE REGRESSION ARM: the gap this closes. Cancel still refuses a draft, so the two acts stay apart. */
  it('cancel still refuses a draft, which is why discard had to exist', async () => {
    const { personId } = await hire();
    const { id } = await draftFor(personId);
    await expect(cancelTp1ForPerson(adminCtx(b), { personId, id })).rejects.toThrow(
      /submitted or approved/i,
    );
    expect(await statusOf(id), 'and it is untouched by the refusal').toBe('draft');
  });

  it('discard refuses anything that has been declared', async () => {
    const { personId } = await hire();
    await draftFor(personId);
    const { id } = await submitTp1ForPerson(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      tp1Amount: 1200,
      declarationAccepted: true,
    });
    expect(await statusOf(id)).toBe('submitted');

    await expect(
      discardTp1DraftForPerson(adminCtx(b), { personId, id }),
      'a submitted declaration is cancelled, never discarded',
    ).rejects.toBeInstanceOf(TaxReliefError);
    expect(await statusOf(id)).toBe('submitted');
  });

  it('the row survives as a record, readable after the discard', async () => {
    const { personId } = await hire();
    const { id } = await draftFor(personId);
    await discardTp1DraftForPerson(adminCtx(b), { personId, id });
    const row = await getTp1ByIdForPerson(adminCtx(b), { personId, id });
    expect(row, 'a discarded draft is still there to be audited').toBeTruthy();
    expect(row!.status).toBe('cancelled');
  });
});

describe('27605faa · an administrator may not approve their own tax relief', () => {
  /** ⚠️ THE SECURITY CASE. TP1 relief reduces PCB, and an admin is very often also an employee. */
  it('refuses when the approver is the subject', async () => {
    const { personId } = await hire('Admin Who Is Also Staff');
    const self = adminAsPerson(personId);
    await saveTp1DraftForPerson(self, { personId, assessmentYear: YEAR, tp1Amount: 900 });
    const { id } = await submitTp1ForPerson(self, {
      personId,
      assessmentYear: YEAR,
      tp1Amount: 900,
      declarationAccepted: true,
    });

    await expect(approveTp1ForPerson(self, { personId, id })).rejects.toThrow(/your own TP1/i);
  });

  /** …AND THE WORK IS NOT LOST. The refusal leaves it SUBMITTED: it needs a second person, not a redo. */
  it('and the declaration stays submitted, needing a second person', async () => {
    const { personId } = await hire('Admin Who Is Also Staff');
    const self = adminAsPerson(personId);
    await saveTp1DraftForPerson(self, { personId, assessmentYear: YEAR, tp1Amount: 900 });
    const { id } = await submitTp1ForPerson(self, {
      personId, assessmentYear: YEAR, tp1Amount: 900, declarationAccepted: true,
    });
    await expect(approveTp1ForPerson(self, { personId, id })).rejects.toThrow();

    expect(await statusOf(id), 'submitted, not reverted to draft').toBe('submitted');
  });

  it('a DIFFERENT administrator may approve it — the rule is about the subject, not the requester', async () => {
    const { personId } = await hire('Subject');
    const other = await hire('Another Admin');
    void (await createAppUser(b.tenantId, other.personId, 'hr_admin'));

    await saveTp1DraftForPerson(adminCtx(b), { personId, assessmentYear: YEAR, tp1Amount: 900 });
    const { id } = await submitTp1ForPerson(adminCtx(b), {
      personId, assessmentYear: YEAR, tp1Amount: 900, declarationAccepted: true,
    });

    await approveTp1ForPerson(adminAsPerson(other.personId), { personId, id });
    expect(await statusOf(id)).toBe('approved');
  });

  /**
   * THE ESCAPE HATCH, COPIED FROM `assertCanDecide` RATHER THAN INVENTED. A company whose only
   * administrator is also an employee must not be stranded with a declaration nobody can approve.
   */
  it('a super_admin may still approve their own, exactly as assertCanDecide allows', async () => {
    const { personId } = await hire('Sole Administrator');
    const su = adminAsPerson(personId, 'super_admin');
    await saveTp1DraftForPerson(su, { personId, assessmentYear: YEAR, tp1Amount: 900 });
    const { id } = await submitTp1ForPerson(su, {
      personId, assessmentYear: YEAR, tp1Amount: 900, declarationAccepted: true,
    });

    await approveTp1ForPerson(su, { personId, id });
    expect(await statusOf(id)).toBe('approved');
  });

  /** It guards the SERVICE, so the two-step screen and the one-press button are both covered. */
  it('lives in approveTp1ForPerson, not in the combined action', () => {
    expect(CORE).toContain('function refuseSelfApproval');
    const approve = CORE.slice(CORE.indexOf('export async function approveTp1ForPerson'));
    expect(approve.slice(0, 600), 'the guard runs inside the service').toContain('refuseSelfApproval(ctx');
    expect(ACTIONS, 'the action must not re-implement it').not.toContain('refuseSelfApproval');
  });
});

describe('27605faa · submit and approve in one press', () => {
  it('composes the two services in order, and writes no status itself', () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf('export async function adminSubmitAndApproveTp1'),
      ACTIONS.indexOf('export async function adminDiscardTp1Draft'),
    );
    expect(fn).toContain('submitTp1ForPerson');
    expect(fn).toContain('approveTp1ForPerson');
    expect(fn.indexOf('submitTp1ForPerson(')).toBeLessThan(fn.indexOf('approveTp1ForPerson('));
    // A direct status write would bypass decide(), which is what stamps the event and the approver.
    for (const f of ['.update(tp1Relief', 'db.insert', "status: 'approved'"]) {
      expect(fn, `${f} would bypass decide()`).not.toContain(f);
    }
  });

  it('is gated to an administrator at the door', () => {
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function adminSubmitAndApproveTp1'));
    expect(fn.slice(0, 400)).toContain('requireAdmin()');
  });

  it('is ADMIN-ONLY on the screen too: only the HR page passes it', () => {
    expect(src('app/payroll/transactions/tp1/[year]/[month]/page.tsx')).toContain(
      'submitApproveAction={adminSubmitAndApproveTp1}',
    );
    // The employee's own screen renders the SAME component and must not hand it either control.
    const me = src('app/me/tax-relief/page.tsx');
    expect(me, 'an employee cannot approve their own').not.toContain('submitApproveAction');
    expect(me, 'nor discard through this path').not.toContain('discardDraftAction');
  });

  it('the buttons are drawn only when their actions are supplied', () => {
    expect(FORM).toContain('{submitApproveAction && (');
    expect(FORM).toContain("{discardDraftAction && status === 'draft' && (");
  });
});

describe('27605faa · the Add button asks which month', () => {
  it('no longer hardcodes the current month as the only answer', () => {
    // The constant that WAS the whole fault.
    expect(LIST, 'the old one-line rule must be gone').not.toMatch(
      /const addMonth = selectedYear === currentYear \? Number\(todayInKualaLumpur\(\)\.slice\(5, 7\)\) : 1;/,
    );
    expect(LIST).toContain('const defaultAddMonth =');
    expect(LIST).toContain("name=\"addMonth\"");
    expect(LIST, 'and the chosen month is what Add opens').toContain('monthHref(selectedYear, addMonth)');
  });

  it('keeps the current month as the DEFAULT, which is what a reader usually means', () => {
    expect(LIST).toContain('selectedYear === currentYear ? Number(todayInKualaLumpur().slice(5, 7)) : 1');
    expect(LIST).toContain('defaultValue={String(addMonth)}');
  });

  /** An untrusted url value: month 13, a word, or nothing must fall back rather than be honoured. */
  it('refuses a month outside 1–12 rather than passing it on', () => {
    expect(LIST).toContain('askedAddMonth >= 1 && askedAddMonth <= 12');
    expect(LIST).toContain('Number.isInteger(askedAddMonth)');
  });

  it('names the months through the screen’s own formatter, never a hardcoded list', () => {
    expect(LIST).toContain('label: monthFmt.format(');
    expect(LIST, 'no second calendar on this screen').not.toMatch(/'January'|'Januari'/);
  });
});
