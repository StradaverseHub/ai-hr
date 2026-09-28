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
  listTp1DeclarationsForPersonYear,
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
const NEW = src('app/payroll/transactions/tp1/new/page.tsx');
const PAGE_SRC = src('app/payroll/transactions/tp1/page.tsx');
const FORM_LIST = src('components/tp1-declarations-list.tsx');
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

/**
 * ⚠️ FOUR OF THESE FIVE CASES WERE UPDATED BY r352 (item 0df7dd44), NOT LOOSENED, and what moved is worth
 * naming. The three actions that carried keyed amounts — save draft, submit, submit-and-approve — all
 * `redirect()`ED ON REFUSAL, to the TP1 Relief LIST rather than to the form, which unmounted the form and
 * discarded every figure in it. They are now ONE `useActionState`-shaped action, `adminTp1FormAction`,
 * with the pressed button's `name="intent"` choosing between them; submit-and-approve became a private
 * helper of that action and the `requireAdmin()` door moved to the one public entry point.
 *
 * Every decision these cases were written to pin still holds and is still asserted here: the two services
 * are composed in that order, no status is written directly, an administrator is required at the door, an
 * employee's own screen can reach neither control, and each button is drawn only where it is enabled.
 */
describe('27605faa · submit and approve in one press', () => {
  it('composes the two services in order, and writes no status itself', () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf('async function adminSubmitAndApproveTp1'),
      ACTIONS.indexOf('// ── Section F — employer consent'),
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
    // r352 — the door is the ONE public action, and submit-and-approve is only reachable through it.
    const entry = ACTIONS.slice(ACTIONS.indexOf('export async function adminTp1FormAction'));
    expect(entry.slice(0, 400), 'the form action is not admin-gated').toContain('requireAdmin()');
    expect(entry, 'submitApprove is reachable without passing that gate').toContain(
      "if (intent === 'submitApprove') return adminSubmitAndApproveTp1(",
    );
    // …and the helper is NOT exported, so there is no second, ungated way in.
    expect(ACTIONS, 'the combined press is exported past its own gate').not.toContain(
      'export async function adminSubmitAndApproveTp1',
    );
  });

  it('is ADMIN-ONLY on the screen too: only the HR page passes it', () => {
    const hr = src('app/payroll/transactions/tp1/[year]/[month]/page.tsx');
    expect(hr, 'the HR screen offers the one-press control').toContain('canSubmitApprove');
    expect(hr).toContain('formAction={adminTp1FormAction}');
    // The employee's own screen renders the SAME component and must not hand it either control.
    const me = src('app/me/tax-relief/page.tsx');
    expect(me, 'an employee cannot approve their own').not.toContain('canSubmitApprove');
    expect(me, 'nor discard through this path').not.toContain('discardDraftAction');
  });

  it('the buttons are drawn only when their actions are supplied', () => {
    expect(FORM).toContain('{canSubmitApprove && (');
    expect(FORM).toContain("{discardDraftAction && status === 'draft' && (");
  });
});

/**
 * 27605faa REVISION 2 — the year and month moved OFF the viewing screen and INTO Add New TP1.
 *
 * ⚠️ THESE FOUR CASES WERE UPDATED, NOT DELETED, because they pinned a decision the reporter then
 * contested. r324 put a month picker on app/payroll/transactions/tp1/page.tsx beside the Add button, and
 * asserted it there. Their words: "The Assessment Year and Deduction Month selection is currently
 * displayed on the TP1 viewing page. This is not the correct workflow because these fields are relevant
 * when creating a new TP1 transaction, not when viewing existing transaction history."
 *
 * They were right, and the fault was narrower than either report suggested: the month was never fixed to
 * the current month — any month was reachable by opening it — but the CONTROL for choosing one sat on the
 * viewing screen. So what the assertions protect is unchanged (a month is chosen, not assumed; a month
 * outside 1-12 is refused; the names come from Intl); WHERE they protect it has moved.
 */
/**
 * 27605faa rev 2 — THE COLLAPSE KEY, which is where showing every year could have gone quietly wrong.
 *
 * `listTp1DeclarationsForPersonYear` collapses the append-only rows to one per month (a correction is
 * another row; the newest wins, the rest are counted as `versions`). That collapse keyed on the MONTH
 * alone — sound while the query was fenced to one year, and silently wrong the moment it is not:
 * January 2025 and January 2026 would share a bucket, one would be reported as a "version" of the other,
 * and a whole year's declaration would vanish from the history while inflating another's count.
 *
 * These cases are the reason the key gained the year. Both would pass against the old code for a
 * single-year call, which is exactly why the cross-year one has to exist.
 */
describe('27605faa rev 2 · every year at once, without two Januaries colliding', () => {
  it('keeps the same month in different years as separate records', async () => {
    const { personId } = await hire();
    const a = await saveTp1DraftForPerson(adminCtx(b), {
      personId, assessmentYear: 2025, deductionMonth: 1, tp1Amount: 500,
    });
    const c = await saveTp1DraftForPerson(adminCtx(b), {
      personId, assessmentYear: 2026, deductionMonth: 1, tp1Amount: 900,
    });
    expect(a.id).not.toBe(c.id);

    const all = await listTp1DeclarationsForPersonYear(adminCtx(b), { personId });
    const januaries = all.filter((r) => r.deductionMonth === 1);
    expect(januaries, 'two Januaries, two records').toHaveLength(2);
    expect(januaries.map((r) => r.assessmentYear).sort()).toEqual([2025, 2026]);
    // …and NEITHER is reported as a superseded version of the other.
    for (const j of januaries) expect(j.versions, 'no cross-year version inflation').toBe(1);
  });

  it('newest year first, January first within a year', async () => {
    const { personId } = await hire();
    for (const [y, m] of [[2025, 3], [2026, 2], [2026, 1]] as const) {
      await saveTp1DraftForPerson(adminCtx(b), {
        personId, assessmentYear: y, deductionMonth: m, tp1Amount: 100,
      });
    }
    const all = await listTp1DeclarationsForPersonYear(adminCtx(b), { personId });
    expect(all.map((r) => `${r.assessmentYear}-${r.deductionMonth}`)).toEqual(['2026-1', '2026-2', '2025-3']);
  });

  /** Passing a year still behaves exactly as it always did — the existing callers must not shift. */
  it('a single-year call is unchanged', async () => {
    const { personId } = await hire();
    await saveTp1DraftForPerson(adminCtx(b), { personId, assessmentYear: 2025, deductionMonth: 1, tp1Amount: 500 });
    await saveTp1DraftForPerson(adminCtx(b), { personId, assessmentYear: 2026, deductionMonth: 1, tp1Amount: 900 });

    const only2026 = await listTp1DeclarationsForPersonYear(adminCtx(b), { personId, assessmentYear: 2026 });
    expect(only2026).toHaveLength(1);
    expect(only2026[0].assessmentYear).toBe(2026);
  });

  it('a malformed year is still refused rather than read as every year', async () => {
    const { personId } = await hire();
    await expect(
      listTp1DeclarationsForPersonYear(adminCtx(b), { personId, assessmentYear: 1899 }),
      'an out-of-range year must throw, not silently widen to all years',
    ).rejects.toThrow();
  });
});

describe('27605faa rev 2 · Add New TP1 asks for the year and month, on its own step', () => {
  it('the viewing screen no longer carries the control at all', () => {
    expect(LIST, 'the month picker has left the history screen').not.toContain('name="addMonth"');
    expect(LIST, 'and so has its resolution').not.toContain('defaultAddMonth');
    // Add now opens the step rather than a month directly.
    expect(LIST).toContain('/payroll/transactions/tp1/new?employmentId=');
  });

  it('the step asks for both, and neither is assumed', () => {
    expect(NEW).toContain('name="year"');
    expect(NEW).toContain('name="month"');
    expect(NEW).toContain("t('tp1.addStepContinue')");
  });

  it('keeps today as the DEFAULT, which is what a reader usually means', () => {
    expect(NEW).toContain('const currentYear = Number(todayIso.slice(0, 4));');
    expect(NEW).toContain('const currentMonth = Number(todayIso.slice(5, 7));');
    expect(NEW).toContain('defaultValue={String(month)}');
    expect(NEW).toContain('defaultValue={String(year)}');
  });

  /** Untrusted url values: month 13 or year 3000 must fall back rather than reach the redirect. */
  it('refuses a month outside 1-12 and a year outside 2000-2100', () => {
    expect(NEW).toContain('askedMonth >= 1 && askedMonth <= 12');
    expect(NEW).toContain('askedYear >= YEAR_MIN && askedYear <= YEAR_MAX');
    expect(NEW).toContain('Number.isInteger(askedMonth)');
    expect(NEW).toContain('Number.isInteger(askedYear)');
  });

  it('names the months through Intl, never a hardcoded list', () => {
    expect(NEW).toContain('monthFmt.format(');
    expect(NEW, 'no second calendar').not.toMatch(/'January'|'Januari'/);
  });

  /**
   * ⚠️ IT CREATES NOTHING. The step resolves a year and a month and redirects to the declaration form
   * that already exists. A second write path to tp1_relief is the one thing this must not become.
   */
  it('writes nothing — it resolves and redirects', () => {
    expect(NEW).toContain('redirect(');
    expect(NEW).toContain('/payroll/transactions/tp1/${year}/${month}');
    for (const f of ['saveTp1Draft', 'submitTp1', 'db.insert', '.update(tp1Relief']) {
      expect(NEW, `${f} would make this a second writer`).not.toContain(f);
    }
  });

  it('is scoped and re-guards the employment, like the screen it returns to', () => {
    expect(NEW).toContain('scopedAdmin');
    expect(NEW).toContain('requireAdmin()');
    expect(NEW).toContain('employees.find((e) => e.employmentId === sp.employmentId)');
    expect(NEW, 'an unknown or out-of-scope employee is the same bare 404').toContain('notFound()');
  });
});

describe('27605faa rev 2 · Delete lives in the Transaction History', () => {
  it('every deletable row offers it, and a rejected one does not', () => {
    expect(PAGE_SRC).toContain("d.status === 'rejected'");
    expect(PAGE_SRC).toContain('deleteHref:');
    expect(FORM_LIST).toContain("t('history.delete')");
    expect(FORM_LIST, 'a link, never an action prop across the client boundary').toContain('href={r.deleteHref}');
  });

  it('asks before it deletes, server-rendered', () => {
    expect(PAGE_SRC).toContain("t('tp1.history.deleteConfirmTitle')");
    expect(PAGE_SRC).toContain('action={adminDeleteTp1}');
    expect(PAGE_SRC, 'the status routes the service, and rides a hidden field').toContain('name="status"');
  });

  it('the action routes by status so neither service loosens', () => {
    const fn = ACTIONS.slice(
      ACTIONS.indexOf('export async function adminDeleteTp1'),
      ACTIONS.indexOf('export async function adminDiscardTp1Draft'),
    );
    expect(fn).toContain("status === 'draft'");
    expect(fn).toContain('discardTp1DraftForPerson');
    expect(fn).toContain('cancelTp1ForPerson');
    // Still not a row delete: tp1_relief is a tax record.
    for (const f of ['.delete(', 'DELETE FROM']) {
      expect(fn, `${f} would destroy a tax record`).not.toContain(f);
    }
  });

  it('a deleted record leaves the list but stays reachable', () => {
    expect(PAGE_SRC).toContain("r.status !== 'cancelled'");
    expect(PAGE_SRC).toContain("t('tp1.history.showDeleted'");
  });

  it('the history spans every year, with the year as a column', () => {
    expect(PAGE_SRC, 'no year filter on the read').toContain(
      'listTp1DeclarationsForPersonYear(s, { personId: selectedEmp.personId })',
    );
    expect(FORM_LIST).toContain("sortTh('year', t('history.colYear'))");
    expect(FORM_LIST).toContain('{r.assessmentYear}');
  });
});
