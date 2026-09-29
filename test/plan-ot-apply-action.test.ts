/**
 * ce5ded11 (r362) · `myRequestOvertime`, EXERCISED — the Apply OT Plan form's server action end to end.
 *
 * WHY THIS FILE RATHER THAN A SOURCE SCAN. Three of this round's fixes live entirely in the action, and
 * each of them is a SENTENCE THE EMPLOYEE READS or a ROW THAT IS OR IS NOT WRITTEN — nothing a static
 * check can settle:
 *
 *  1 · WITH JAVASCRIPT OFF THE FORM COULD NEVER SUCCEED. The hours are derived by the client island, so
 *      with scripting off the hidden `otHours` posts blank, `requestedOtMinutes` was null, and the
 *      service refused with "Provide at least one of a clock-in time, a clock-out time, or overtime
 *      hours." — about the only field on the screen the employee cannot fill in. The action now derives
 *      the figure from the planned window, and §1 posts the form the way a browser with no JavaScript
 *      posts it and reads the row that comes out.
 *  2 · "The planned end time must be after the planned start time." WAS UNREACHABLE from this screen for
 *      the same reason: an inverted pair collapsed to "no hours at all" and tripped the generic message
 *      instead. §2 reads the sentence.
 *  3 · A REFUSAL USED TO LOSE THE DATE. The non-negative-hours redirect dropped `&date=`, so a mistyped
 *      figure threw the employee back to a form reset to tomorrow. §4 reads the address.
 *
 * And two capabilities that already existed and were simply never offered on this form — the remark
 * column and the attachment table — are exercised in §5, including the ORPHAN-PREVENTION order: a file
 * the service would refuse must be refused BEFORE the request row commits, or a rejected upload leaves
 * a pending request behind that the employee then has to withdraw.
 *
 * The framework edges are faked the way test/r299-leave-credit-cancel.test.ts fakes them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setAttendancePolicy } from '../core/attendance';
import type { SessionContext } from '../db/client';

// The action calls getSession() (a request the harness has no equivalent of). ME carries the seeded
// PERSON, because myEmployment resolves the employment off ctx.personId — that resolution is the thing
// the action does before anything else, and a context without it would not reach the code under test.
let ME: SessionContext;
vi.mock('../lib/session', () => ({ getSession: async () => ME }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({
  redirect: (p: string): never => {
    throw new Error(`NEXT_REDIRECT:${p}`);
  },
  notFound: vi.fn(() => undefined),
}));
/**
 * ec30b2e9 (r364) — THE REAL CATALOGUE, NOT A KEY-ECHOING STUB. Two of this action's refusals are now
 * localized (`me.otPlanApprovedNotCounted`, `me.otAlreadyCountedForDate`), and the whole point of §2 is
 * that it reads the SENTENCE the employee reads. A stub returning the key would have let a missing key, a
 * wrong key or a dropped `{date}` through, which is exactly the class of defect this file exists for.
 *
 * ⚠️ `onError` THROWS, deliberately: next-intl swallows MISSING_MESSAGE and FORMATTING_ERROR and hands
 * back the key, so a silently-broken message would read as a pass. (Same reasoning as
 * test/r292-anomaly-threshold-disclosure.ts.) `getLocale` is mocked too because app/me/actions.ts imports
 * it — an un-mocked named export of a mocked module is an error, not a fallback.
 */
vi.mock('next-intl/server', async () => {
  const { createTranslator: make } = await import('next-intl');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const messages = JSON.parse(readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'));
  return {
    getLocale: async () => 'en',
    getTranslations: async (ns: string | { namespace?: string }) =>
      make({
        locale: 'en',
        messages,
        namespace: (typeof ns === 'string' ? ns : ns?.namespace) as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

import { myRequestOvertime } from '../app/me/actions';

let b: Base;
let employmentId: string;

const FUTURE = '2027-06-02'; // a Wednesday under the default Mon–Fri policy
const FUTURE_2 = '2027-06-03';
const FUTURE_3 = '2027-06-09';
// r364 — a date in the past, where an approved plan's hours are COUNTED at approval time rather than
// waiting for the day. 2025-06-04 is a Wednesday, an ordinary working day under the policy above.
const PAST = '2025-06-04';

const uniq = () => `otapply_${Math.random().toString(36).slice(2)}@t.local`;

/** The address a redirect threw, or '' when the call did not redirect. */
async function redirectOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return '';
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.startsWith('NEXT_REDIRECT:')) throw e;
    return msg.slice('NEXT_REDIRECT:'.length);
  }
}

/** The `error=` message a redirect carried, decoded — the sentence the employee actually reads. */
const errorOf = (url: string): string | null => {
  const m = /[?&]error=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
};

/** The form a BROWSER posts. `otHours` is omitted wherever JavaScript would have filled it in. */
function form(fields: Record<string, string>, file?: File): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set('attachment', file);
  return fd;
}

/** r364 — the English catalogue the action resolves its refusals from. Read from the FILE rather than
 *  restated here: a copy of the sentence in the test is a second source of truth for the wording, and the
 *  two drift the first time somebody improves one of them. What the assertions pin is the SUBSTANCE (the
 *  date is interpolated, the route is named), which a copied string cannot check. */
const MESSAGES: { me: Record<string, string> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../messages/en.json', import.meta.url)), 'utf8'),
);

const planFor = async (date: string) =>
  (
    await owner.db
      .select()
      .from(schema.attendanceCorrection)
      .where(
        and(eq(schema.attendanceCorrection.employmentId, employmentId), eq(schema.attendanceCorrection.attendanceDate, date)),
      )
  )[0];

const plansCount = async () =>
  (await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.employmentId, employmentId)))
    .length;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Apply OT Worker', primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setAttendancePolicy(a, {
    companyId: b.companyId,
    workStart: '09:00',
    workEnd: '18:00',
    breakMinutes: 60,
    lateAfter: '09:15',
    halfDayBefore: '13:00',
    workingDays: [1, 2, 3, 4, 5],
  });
  employmentId = e.employmentId;
  ME = { ...a, personId: e.personId };
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · with JavaScript off, the form now succeeds', () => {
  it('derives the hours from the planned window when the hidden field arrives blank', async () => {
    const url = await redirectOf(() =>
      myRequestOvertime(
        form({
          date: FUTURE,
          plannedStart: '18:00',
          plannedEnd: '20:30',
          reason: 'Cut-over rehearsal for the new server',
          otReasonCategory: 'project_deadline',
          // NO otHours — this is exactly what a browser with no scripting posts.
        }),
      ),
    );
    expect(errorOf(url), `the submission was refused: ${url}`).toBeNull();
    const row = await planFor(FUTURE);
    expect(row, 'a plan row must exist').toBeTruthy();
    expect(row.requestedOtMinutes, 'two and a half hours, worked out from the window').toBe(150);
    expect(row.plannedStartTime).toBe('18:00:00');
    expect(row.plannedEndTime).toBe('20:30:00');
    expect(row.otReasonCategory).toBe('project_deadline');
  });

  it('and with JavaScript ON the posted figure is still what the engine reads, unchanged', async () => {
    const url = await redirectOf(() =>
      myRequestOvertime(
        form({
          date: FUTURE,
          plannedStart: '18:00',
          plannedEnd: '20:30',
          otHours: '2.5000', // the island's own 4-dp figure
          reason: 'Cut-over rehearsal for the new server',
          otReasonCategory: 'project_deadline',
        }),
      ),
    );
    expect(errorOf(url)).toBeNull();
    expect((await planFor(FUTURE)).requestedOtMinutes).toBe(150);
  });

  it('an hours-only plan with no window at all still works — the shape that always worked', async () => {
    const url = await redirectOf(() => myRequestOvertime(form({ date: FUTURE, otHours: '3', reason: 'Claimed after the fact' })));
    expect(errorOf(url)).toBeNull();
    expect((await planFor(FUTURE)).requestedOtMinutes).toBe(180);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · the refusals the employee reads are the ones that are TRUE of what they typed', () => {
  it('an inverted window says so, instead of the generic "provide at least one"', async () => {
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE, plannedStart: '21:00', plannedEnd: '18:00', reason: 'Typed them the wrong way round' })),
    );
    expect(errorOf(url)).toBe('The planned end time must be after the planned start time.');
    expect(await plansCount(), 'nothing is written on a refusal').toBe(0);
  });

  it('half a window says so', async () => {
    const url = await redirectOf(() => myRequestOvertime(form({ date: FUTURE, plannedStart: '18:00', reason: 'Only filled in the start' })));
    expect(errorOf(url)).toBe('A planned overtime window needs both a start time and an end time.');
    expect(await plansCount()).toBe(0);
  });

  it('nothing filled in at all still gets the generic message, which is the true one there', async () => {
    const url = await redirectOf(() => myRequestOvertime(form({ date: FUTURE, reason: 'Nothing filled in' })));
    expect(errorOf(url)).toBe('Provide at least one of a clock-in time, a clock-out time, or overtime hours.');
  });

  it('a duplicate approved plan is still refused, with the date in the sentence', async () => {
    await redirectOf(() => myRequestOvertime(form({ date: FUTURE, otHours: '2', reason: 'First plan' })));
    const first = await planFor(FUTURE);
    await owner.db
      .update(schema.attendanceCorrection)
      .set({ status: 'approved', approvedOtMinutes: 120 })
      .where(eq(schema.attendanceCorrection.id, first.id));
    const url = await redirectOf(() => myRequestOvertime(form({ date: FUTURE, otHours: '1', reason: 'Second plan' })));
    // ── ec30b2e9 (r364) · THIS ASSERTION IS UPDATED, NOT LOOSENED ──────────────────────────────────────
    // IT USED TO READ, and was right to:
    //   expect(errorOf(url)).toBe(
    //     `You already have an approved overtime plan for ${FUTURE}. Withdraw it first if it is wrong.`,
    //   );
    // That was a RAW ENGLISH Error.message travelling through `?error=` into ErrorBanner — so a Tamil,
    // Thai, Malay, Vietnamese or Chinese employee read English on a screen with six catalogues. The refusal
    // is now a typed error the action maps to `me.otPlanApprovedNotCounted`. What is pinned is the same
    // two things it always pinned, and one more: the sentence names the DATE, it says to WITHDRAW the
    // first, and it now comes out of the catalogue rather than out of a throw.
    expect(errorOf(url)).toBe(MESSAGES.me.otPlanApprovedNotCounted.replace('{date}', FUTURE));
    expect(errorOf(url)).toContain(FUTURE);
    expect(errorOf(url)).toContain('Withdraw the first');
  });

  it('r364 — once the hours are COUNTED the sentence changes: this is a correction, not a new request', async () => {
    // THE TWO REFUSALS ARE DIFFERENT SENTENCES BECAUSE THE WAY OUT IS DIFFERENT. Above, the plan is still
    // waiting and can be withdrawn. Here the hours are on the attendance day and in what payroll reads, so
    // withdrawal is refused by design and the only route is an attendance correction.
    //
    // The stored state is set directly, the way the case above sets `approved`: this file's subject is the
    // ACTION and the sentence it produces. That the SERVICE reaches this state by itself — and that a clock
    // correction is still accepted here — is pinned against the real engine in test/plan-ot.test.ts §4.
    await redirectOf(() => myRequestOvertime(form({ date: PAST, otHours: '3', reason: 'Last Wednesday' })));
    const first = await planFor(PAST);
    await owner.db
      .update(schema.attendanceCorrection)
      .set({ status: 'approved', approvedOtMinutes: 180, appliedAt: new Date(), decidedAt: new Date() })
      .where(eq(schema.attendanceCorrection.id, first.id));
    // The premise in its own right: this fixture is in the COUNTED window, not the unapplied one.
    expect((await planFor(PAST)).appliedAt, 'counted means applied_at is stamped').not.toBeNull();

    const url = await redirectOf(() => myRequestOvertime(form({ date: PAST, otHours: '0.5', reason: 'The half hour I forgot' })));
    expect(errorOf(url)).toBe(MESSAGES.me.otAlreadyCountedForDate.replace('{date}', PAST));
    // It must name the day and point somewhere real, or the refusal is a dead end.
    expect(errorOf(url)).toContain(PAST);
    expect(errorOf(url)).toContain('attendance request');
    // And it must NOT be the withdraw sentence: withdrawal is refused in this state.
    expect(errorOf(url)).not.toContain('Withdraw');
    // Refused at the door — the second request was never written.
    expect(await plansCount()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · the employee lands back on the calendar, with the date they picked', () => {
  it('a successful submission stays on Apply OT Plan and carries the date and the confirmation', async () => {
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Cut-over rehearsal' })),
    );
    expect(url).toContain('/attendance/plan-ot/apply');
    expect(url).toContain(`date=${FUTURE}`);
    expect(url).toContain('toast=Overtime+plan+submitted');
    // Being thrown to the list is what this replaced: planning a second day meant navigating back in.
    expect(url.startsWith('/attendance/plan-ot?')).toBe(false);
  });

  it('every refusal comes back to the form with the same date still selected', async () => {
    const cases: Record<string, string>[] = [
      { date: FUTURE_2, plannedStart: '21:00', plannedEnd: '18:00', reason: 'Inverted' },
      { date: FUTURE_2, plannedStart: '18:00', reason: 'Half a window' },
      { date: FUTURE_2, reason: 'Nothing at all' },
      { date: FUTURE_2, otHours: '-3', reason: 'A negative figure' },
      { date: FUTURE_2, otHours: 'not a number', reason: 'Not a number' },
    ];
    for (const fields of cases) {
      const url = await redirectOf(() => myRequestOvertime(form(fields)));
      expect(url, `refused submission must return to the form: ${JSON.stringify(fields)}`).toContain(
        '/attendance/plan-ot/apply',
      );
      expect(url, `refused submission must keep the date: ${JSON.stringify(fields)}`).toContain(`date=${FUTURE_2}`);
    }
  });

  it('a non-negative-hours refusal reads as itself', async () => {
    const url = await redirectOf(() => myRequestOvertime(form({ date: FUTURE, otHours: '-3', reason: 'A negative figure' })));
    expect(errorOf(url)).toBe('Overtime hours must be a non-negative number.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · the reason category is still never trusted from the post', () => {
  it('an unknown category is dropped rather than meeting the database CHECK', async () => {
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE, otHours: '2', reason: 'Valid reason', otReasonCategory: 'made_up_category' })),
    );
    expect(errorOf(url)).toBeNull();
    expect((await planFor(FUTURE)).otReasonCategory).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · the remark and the attachment — existing capability, finally offered here', () => {
  it('a remark posted from the overtime form is stored on the request', async () => {
    await redirectOf(() =>
      myRequestOvertime(
        form({ date: FUTURE, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Cut-over rehearsal', remark: 'Client asked in writing' }),
      ),
    );
    expect((await planFor(FUTURE)).remark).toBe('Client asked in writing');
  });

  it('an empty remark stores NULL, not a blank note nobody wrote', async () => {
    await redirectOf(() => myRequestOvertime(form({ date: FUTURE, otHours: '2', reason: 'Cut-over rehearsal', remark: '   ' })));
    expect((await planFor(FUTURE)).remark).toBeNull();
  });

  it('an accepted file is attached to the request the form just created', async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'client-email.pdf', { type: 'application/pdf' });
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Cut-over rehearsal' }, file)),
    );
    expect(errorOf(url)).toBeNull();
    const row = await planFor(FUTURE);
    const files = await owner.db
      .select({ name: schema.attendanceCorrectionAttachment.fileName, mime: schema.attendanceCorrectionAttachment.mimeType })
      .from(schema.attendanceCorrectionAttachment)
      .where(eq(schema.attendanceCorrectionAttachment.attendanceCorrectionId, row.id));
    expect(files).toEqual([{ name: 'client-email.pdf', mime: 'application/pdf' }]);
  });

  it('ORPHAN PREVENTION: a refused file leaves NO request row behind', async () => {
    // The rule the leave path learned the hard way: validate the file BEFORE the request row commits.
    // With the order the other way round the employee gets an error AND a pending request they never
    // meant to file — and the database allows only one pending request per date, so the next attempt
    // is refused by a row they cannot see.
    const bad = new File([new Uint8Array([1, 2, 3])], 'plan.exe', { type: 'application/x-msdownload' });
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE_3, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Cut-over rehearsal' }, bad)),
    );
    expect(errorOf(url)).toBe('That file type is not accepted — attach a photo or a PDF.');
    expect(await plansCount(), 'a rejected upload must not leave a pending request behind').toBe(0);
    expect(await owner.db.select().from(schema.attendanceCorrectionAttachment)).toEqual([]);
  });

  it('an EMPTY file input is not a file — the form posts one on every submission', async () => {
    // A browser posts a zero-byte File for an untouched `<input type="file">`, so presence cannot be the
    // test; size is.
    const empty = new File([], '', { type: 'application/octet-stream' });
    const url = await redirectOf(() =>
      myRequestOvertime(form({ date: FUTURE, plannedStart: '18:00', plannedEnd: '20:00', reason: 'Cut-over rehearsal' }, empty)),
    );
    expect(errorOf(url)).toBeNull();
    expect(await planFor(FUTURE)).toBeTruthy();
    expect(await owner.db.select().from(schema.attendanceCorrectionAttachment)).toEqual([]);
  });
});
