/**
 * 154865f4 — REMOVING A ROSTER DAY IS NOW PROTECTED UNDERNEATH, LIKE ADDING AND CHANGING ONE.
 *
 * THE GAP THIS FILE PINS SHUT. `roster_assignment_rls` (0075_shift_roster.sql:51-53) is a single
 * FOR ALL policy. Postgres applies its WITH CHECK (`app.can_admin_employment`) to INSERT and to the NEW
 * row of an UPDATE only; a DELETE is matched against USING ALONE, which is `app.can_see_employment` —
 * a predicate the subject's administrative manager AND the employee themselves both pass. Measured
 * 2026-08-12 as `ai_hr_app` in a rolled-back transaction with a real active reporting line: INSERT
 * 42501, constraint-valid UPDATE of a future-dated row 42501, and `DELETE 1` for that same row.
 * 0436_roster_assignment_delete_guard.sql adds a RESTRICTIVE FOR DELETE policy, which ANDs with the
 * permissive one; the FOR ALL policy is untouched, so reads are unchanged.
 *
 * ⚠️ READ THIS BEFORE "FIXING" THE DELETE ASSERTIONS TO EXPECT 42501 — THEY ARE NOT AN OVERSIGHT.
 * A restrictive policy for DELETE is a `USING` clause, and a USING clause FILTERS: "rows for which the
 * expression returns false or null … will not be available for modification (in an UPDATE or DELETE).
 * Such rows are silently suppressed; no error is reported." Only WITH CHECK raises 42501, and DELETE has
 * no WITH CHECK. So the refusal shows as **zero rows removed and no error**, not as a SQLSTATE — the
 * same behaviour this repo already recorded for the identical guard on leave_year_config
 * (0385_leave_year_config_reset.sql:13-14, "removes NOTHING and raises NO error"). The item's build
 * notes asked for a SQLSTATE on the delete leg; that is the one place they are not achievable, and
 * asserting the row's SURVIVAL is strictly the stronger claim anyway — it is the outcome that matters,
 * and it is read back as the OWNER so RLS cannot be what makes the row look absent.
 *
 * WHAT IS DELIBERATELY ALSO ASSERTED: that the manager and the employee can still SELECT the row. If
 * anyone ever "simplifies" this by narrowing the FOR ALL policy's USING clause to
 * `can_admin_employment` instead of adding a restrictive one, the delete legs here would still pass and
 * only those read assertions would catch it — a supervisor losing sight of the roster is a visible
 * behaviour change and is explicitly not what 154865f4 asked for.
 *
 * NOTHING IN THE APPLICATION CHANGED. `assertRosterAdmin` still runs first in every caller and still
 * produces the friendly message (test/roster-write-guard.test.ts owns that); this file is about the
 * layer underneath it, exercised directly through `withTenant` so the application guard cannot be what
 * produces the result.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { assignShift, createShift } from '../core/roster';

/** Dates far enough ahead that no past-date rule anywhere could be what answers. */
const FUTURE = '2099-03-10';
const FUTURE_SPARE = '2099-03-11';

/** `insufficient_privilege` — what a WITH CHECK violation raises. */
const RLS_REFUSED = '42501';

type Outcome = { ok: true; rows: number } | { ok: false; code: string | undefined; text: string };

/** Run one statement as the app role and report WHAT HAPPENED, rather than merely that it threw.
 *  `rejects.toThrow()` would pass on the wrong throw, and on this table the interesting refusal does
 *  not throw at all — so the shape of the outcome has to be part of the assertion. */
async function outcomeOf(run: () => Promise<{ id: string }[]>): Promise<Outcome> {
  try {
    return { ok: true, rows: (await run()).length };
  } catch (e) {
    // drizzle wraps the driver error as `Failed query: …` and hangs the real PostgresError off `cause`.
    const chain: string[] = [];
    let code: string | undefined;
    let cur: unknown = e;
    for (let i = 0; i < 8 && cur instanceof Error; i++) {
      chain.push(cur.message);
      code ??= (cur as Error & { code?: string }).code;
      cur = (cur as Error & { cause?: unknown }).cause;
    }
    return { ok: false, code, text: chain.join(' | ') };
  }
}

describe('154865f4 — roster_assignment: the store refuses a non-administrator all THREE verbs', () => {
  let b: Base;
  let admin: SessionContext;
  /** The rostered employee, their own session, their manager's session, and an unrelated peer's. */
  let subjectEmploymentId = '';
  let employeeCtx: SessionContext;
  let managerCtx: SessionContext;
  let peerCtx: SessionContext;
  let shiftId = '';
  /** The one future-dated roster row every leg below aims at, seeded by an administrator. */
  let rowId = '';

  beforeAll(async () => {
    await migrateTestDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
    admin = adminCtx(b);

    const hire = (fullName: string, employeeCode: string) =>
      hireEmployee(admin, {
        person: { fullName, primaryEmail: `${employeeCode.toLowerCase()}@roster.test` },
        companyId: b.companyId,
        departmentId: b.deptA,
        positionId: b.positionId,
        employmentType: 'full_time' as const,
        hiredOn: '2020-01-01',
        employeeCode,
      });

    const subject = await hire('Nurul Aina', 'RD001');
    const manager = await hire('Tan Wei Ming', 'RD002');
    const peer = await hire('Suresh Kumar', 'RD003');
    subjectEmploymentId = subject.employmentId;

    // A REAL administrative reporting line — the branch of can_see_employment the manager passes.
    await setReportingLine(admin, {
      subordinateEmploymentId: subject.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2020-01-01',
    });

    employeeCtx = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, subject.personId, 'employee'), roles: ['employee'] };
    managerCtx = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, manager.personId, 'manager'), roles: ['manager'] };
    peerCtx = { tenantId: b.tenantId, userId: await createAppUser(b.tenantId, peer.personId, 'employee'), roles: ['employee'] };

    shiftId = (
      await createShift(admin, {
        companyId: b.companyId,
        name: 'MORNING FULL (0800 - 1700)',
        code: 'RM01',
        startTime: '08:00:00',
        endTime: '17:00:00',
      })
    ).id;
    rowId = (await assignShift(admin, { employmentId: subjectEmploymentId, shiftDate: FUTURE, shiftId })).id;
  });

  /** The seeded row, read as the OWNER so row-level security cannot be what makes it look absent. */
  const survives = async () => {
    const rows = await owner.db.select().from(schema.rosterAssignment).where(eq(schema.rosterAssignment.id, rowId));
    return rows.length;
  };

  const insertAs = (ctx: SessionContext) =>
    outcomeOf(() =>
      withTenant(ctx, (tx) =>
        tx
          .insert(schema.rosterAssignment)
          .values({ tenantId: b.tenantId, employmentId: subjectEmploymentId, shiftDate: FUTURE_SPARE, shiftId })
          .returning({ id: schema.rosterAssignment.id }),
      ),
    );

  /** A constraint-valid UPDATE: only the note moves, so `roster_assignment_shift_xor_rest` cannot be
   *  what refuses. */
  const updateAs = (ctx: SessionContext) =>
    outcomeOf(() =>
      withTenant(ctx, (tx) =>
        tx
          .update(schema.rosterAssignment)
          .set({ note: 'edited by a non-administrator' })
          .where(eq(schema.rosterAssignment.id, rowId))
          .returning({ id: schema.rosterAssignment.id }),
      ),
    );

  const deleteAs = (ctx: SessionContext, id = rowId) =>
    outcomeOf(() =>
      withTenant(ctx, (tx) =>
        tx.delete(schema.rosterAssignment).where(eq(schema.rosterAssignment.id, id)).returning({ id: schema.rosterAssignment.id }),
      ),
    );

  for (const who of ['the administrative manager', 'the employee themselves'] as const) {
    it(`${who}: INSERT and UPDATE raise 42501, and DELETE now removes NOTHING`, async () => {
      const ctx = who === 'the administrative manager' ? managerCtx : employeeCtx;

      // READ IS UNCHANGED, and is asserted FIRST: it is what proves the two refusals below are the
      // policies deciding, not the row being invisible. It is also the tripwire for anyone tempted to
      // narrow the FOR ALL policy's USING clause instead of adding a restrictive one.
      const seen = await withTenant(ctx, (tx) =>
        tx.select().from(schema.rosterAssignment).where(eq(schema.rosterAssignment.id, rowId)),
      );
      expect(seen, `${who} must still SEE the roster row`).toHaveLength(1);

      const ins = await insertAs(ctx);
      expect(ins.ok, 'INSERT must be refused').toBe(false);
      expect(ins.ok === false && ins.code).toBe(RLS_REFUSED);

      const upd = await updateAs(ctx);
      expect(upd.ok, 'UPDATE must be refused').toBe(false);
      expect(upd.ok === false && upd.code).toBe(RLS_REFUSED);

      // THE NEW LEG. Before 0436 this returned one deleted row. A restrictive DELETE policy is a USING
      // clause, so the refusal is silent suppression rather than a SQLSTATE — see the header.
      const del = await deleteAs(ctx);
      expect(del, `${who} must remove nothing, and must not be handed a driver error either`).toEqual({ ok: true, rows: 0 });
      expect(await survives(), 'the roster row must still be there').toBe(1);
    });
  }

  it('the negative control still behaves as USING does: a row the actor cannot even see removes nothing, silently', async () => {
    // A peer with no reporting line over the subject fails the PERMISSIVE policy, so the row never
    // reaches the restrictive one. Same visible outcome, reached a step earlier — which is why it is
    // worth pinning: it is the measurement that shows the two mechanisms are not being confused.
    const seen = await withTenant(peerCtx, (tx) =>
      tx.select().from(schema.rosterAssignment).where(eq(schema.rosterAssignment.id, rowId)),
    );
    expect(seen, 'a peer cannot see the row at all').toHaveLength(0);

    expect(await deleteAs(peerCtx)).toEqual({ ok: true, rows: 0 });
    expect(await survives()).toBe(1);
  });

  it('an HR administrator is unaffected: all three verbs still work, including clearing a day', async () => {
    // The whole point of a RESTRICTIVE policy rather than a narrowed USING: the permitted path is
    // byte-for-byte what it was. If this test ever goes red the guard is too wide, not too narrow.
    expect(await insertAs(admin)).toEqual({ ok: true, rows: 1 });
    expect(await updateAs(admin)).toEqual({ ok: true, rows: 1 });
    expect(await deleteAs(admin)).toEqual({ ok: true, rows: 1 });
    expect(await survives(), 'the administrator DID remove it').toBe(0);

    // …and the spare day the INSERT above created is still there, so the delete removed one row, not all.
    const left = await owner.db
      .select()
      .from(schema.rosterAssignment)
      .where(and(eq(schema.rosterAssignment.employmentId, subjectEmploymentId), eq(schema.rosterAssignment.shiftDate, FUTURE_SPARE)));
    expect(left).toHaveLength(1);
  });
});
