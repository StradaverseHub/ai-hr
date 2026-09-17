/**
 * r301 (board e5018593) — GENERATE ENTITLEMENT ALSO ADDS EARNED ANNUAL LEAVE.
 *
 * THE GAP. `openLeaveYear` logs an earned Annual Leave pair as `earned_method` and writes nothing for it — the
 * days are `accrueEarnedLeave`'s (ADR-0040) — and nothing called that engine from Generate Entitlement, so
 * those employees were listed as Failed and got no days until someone ran Earned Accrual separately.
 *
 * THE CHANGE, and what each section pins:
 *   §1  PREVIEW — carries the earned figures and writes nothing (no ledger row, no accrual event, no run row).
 *   §2  COMMIT == PREVIEW — the same `dryRun` variable reaches both engines, so the figures cannot differ;
 *       the ledger holds exactly the previewed days; the stored outcome stays `earned_method`.
 *   §3  RE-RUN — adds nothing; and a pair reached with nothing outstanding reads "already up to date".
 *   §4  FUTURE YEAR — nothing is accrued in advance, and the result says so.
 *   §5  ACCRUAL FAILURE — the generation stays committed and the result carries the error, preview included.
 *   §6  NOT ANNUAL LEAVE — an earned method on any other type is never accrued, only counted.
 *   §7  EMPLOYEE SCOPE — `accrueEarnedLeave`'s new `employmentIds`: exactly those employees; `[]` is NOBODY;
 *       absent is today's unscoped run. Through the generation and against the engine directly.
 *   §8  FAILED — a reached earned Annual Leave line no longer counts as Failed; an unreached one still does.
 *   §9  THE MESSAGE — one message, truthful nouns, in all six locales; the static shape of the one path.
 *
 * Dates derive from the clock (CLAUDE.md §8): the CURRENT year is today's in Kuala Lumpur, PAST and FUTURE
 * are one either side. The exact-figure arms use the PAST year, whose accrual runs to 31 December and is
 * therefore a full 12 days whatever day the suite runs on; the current year is asserted by relation only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createTranslator } from 'next-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, PROFILE_RECALC_REASON_PREFIX } from '../core/leave';
import { previewLeaveGeneration, runLeaveGeneration, type LeaveGenerationResult } from '../core/leave-generation';
import { leaveGenerationMessages, type GenerationTranslate } from '../lib/leave-generation-message';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

/**
 * §5's failure switch, and the "was the accrual engine asked at all" counter.
 *
 * ⚠️ WHY NOT MOCK `accrueEarnedLeave` ITSELF. core/leave.ts reaches core/leave-generation.ts through an import
 * cycle (leave → attendance → absence-days → packs/leave/service → leave-generation → leave), so a mock
 * factory for '../core/leave' is still pending when leave-generation binds its import, and it binds the REAL
 * function — the first cut of this file did exactly that and its failure arm never fired. Mocked one level
 * down instead: `leaveTypeIdsWithTemplatesAt` is read by core/leave.ts in `accrueEarnedLeave` and nowhere else
 * in that module (the year-open reads `templateStartsWithinWindow`), core/entitlement-template.ts has no
 * cycle back, and the wrapper passes through to the real reader unless `failAccrual.message` is set. So every
 * other arm runs the real engines, and `calls` counts accrual runs that got past the leave-type filter.
 */
const failAccrual = vi.hoisted(() => ({ message: null as string | null, calls: 0 }));
vi.mock('../core/entitlement-template', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/entitlement-template')>();
  return {
    ...actual,
    leaveTypeIdsWithTemplatesAt: async (...args: Parameters<typeof actual.leaveTypeIdsWithTemplatesAt>) => {
      failAccrual.calls += 1;
      if (failAccrual.message) throw new Error(failAccrual.message);
      return actual.leaveTypeIdsWithTemplatesAt(...args);
    },
  };
});

const ROOT = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['en', 'zh', 'ms', 'ta', 'th', 'vi'] as const;
const msgs = (loc: string) => JSON.parse(read(`messages/${loc}.json`));

const TODAY = todayInKualaLumpur();
const YEAR = Number(TODAY.slice(0, 4));
const PAST = YEAR - 1;
const FUTURE = YEAR + 1;

let b: Base;
const ctx = () => adminCtx(b);

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  failAccrual.message = null;
  failAccrual.calls = 0;
});
afterAll(closeAll);

const mkType = async (code: string, name: string) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};

const setMethod = (leaveTypeId: string, method: string | null) =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: method as never })
    .where(eq(schema.leaveType.id, leaveTypeId));

/** 12 days a year, in force from two years before the current one — covering PAST, CURRENT and FUTURE. */
const configure = (leaveTypeId: string, days = 12) =>
  seedEntitlement(ctx(), { leaveTypeId, annualDays: days, gradeId: null, validFrom: `${YEAR - 2}-01-01` });

/** The seeded ANNUAL type (Annual Leave by the unclassified-code fallback), earned monthly, 12 days. */
const earnedAnnual = async () => {
  await setMethod(b.annualLeaveTypeId, 'earned_monthly');
  await configure(b.annualLeaveTypeId);
  return b.annualLeaveTypeId;
};

const hire = (name: string) =>
  hireEmployee(ctx(), {
    person: { fullName: name, primaryEmail: `r301_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: `${YEAR - 3}-01-01`,
    gradeId: null,
    grantLeaveTypes: [],
  });

const ledgerFor = (leaveTypeId: string) =>
  owner.db
    .select({
      employmentId: schema.leaveLedger.employmentId,
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
    })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.leaveTypeId, leaveTypeId))
    .orderBy(asc(schema.leaveLedger.employmentId), asc(schema.leaveLedger.effectiveOn), asc(schema.leaveLedger.days));

const ledgerSum = async (leaveTypeId: string, employmentId?: string) => {
  const [r] = await owner.db
    .select({ s: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        employmentId ? eq(schema.leaveLedger.employmentId, employmentId) : undefined,
      ),
    );
  return Number(r.s);
};

const eventCount = async (eventType: string) => {
  const [r] = await owner.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, eventType)));
  return r.n;
};

const runRowCount = async () => {
  const [r] = await owner.db.select({ n: sql<number>`count(*)::int` }).from(schema.leaveGenerationRun);
  return r.n;
};

const everyone = (year: number) => ({ year, targetMode: 'criteria' as const, criteria: {} });

/** The figures a preview and a commit must agree on, line verdicts included. */
const figures = (r: LeaveGenerationResult) => ({
  granted: r.granted,
  skipped: r.skipped,
  forfeits: r.forfeits,
  employeesPassed: r.employeesPassed,
  employeesFailed: r.employeesFailed,
  accrual: r.accrual,
  lines: r.lines
    .map((l) => `${l.employmentId}|${l.leaveTypeId}|${l.outcome}|${l.days}|${l.earnedAccrual}`)
    .sort(),
});

// ── §1 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§1 the preview carries the earned figures and writes nothing', () => {
  it('PAST year: 2 employees topped up, 24 days, lines marked, nothing written', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');
    expect(await ledgerFor(al), 'precondition: no Annual Leave row before the preview').toEqual([]);

    const preview = await previewLeaveGeneration(ctx(), everyone(PAST));

    expect(preview.accrual).toEqual({
      annualLeaveLines: 2,
      notAnnualLeaveLines: 0,
      skippedFutureYear: false,
      heldBackNextYearStarted: 0,
      forfeits: 0,
      asOf: `${PAST}-12-31`,
      posted: 2,
      upToDate: 0,
      days: 24,
      byLeaveType: [{ leaveTypeId: al, leaveTypeName: expect.any(String), posted: 2, upToDate: 0, days: 24 }],
      error: null,
    });
    const alLines = preview.lines.filter((l) => l.leaveTypeId === al);
    expect(alLines.map((l) => `${l.employmentId}|${l.outcome}|${l.earnedAccrual}`).sort()).toEqual(
      [`${a.employmentId}|earned_method|topped_up`, `${c.employmentId}|earned_method|topped_up`].sort(),
    );
    // NOTHING WRITTEN, by either engine.
    expect(await ledgerFor(al)).toEqual([]);
    expect(await eventCount('leave.earned-accrual.run')).toBe(0);
    expect(await eventCount('leave-year.opened')).toBe(0);
    expect(await eventCount('leave-generation.run')).toBe(0);
    expect(await runRowCount()).toBe(0);
    expect(preview.runId).toBeUndefined();
  });

  it('CURRENT year: accrues to TODAY, and the figures are the accrual engine’s own for the same scope', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');

    const preview = await previewLeaveGeneration(ctx(), everyone(YEAR));
    const direct = await accrueEarnedLeave(ctx(), {
      asOf: TODAY,
      leaveTypeIds: [al],
      employmentIds: [a.employmentId, c.employmentId],
      dryRun: true,
    });

    expect(preview.accrual?.asOf).toBe(TODAY);
    expect(preview.accrual?.skippedFutureYear).toBe(false);
    expect(preview.accrual?.posted).toBe(direct.granted);
    expect(preview.accrual?.upToDate).toBe(direct.breakdown.reduce((n, g) => n + g.employeeCount, 0) - direct.granted);
    expect(preview.accrual?.days).toBe(direct.breakdown.reduce((n, g) => n + g.entitlementGenerated, 0));
    // Both employees are REACHED whatever today is (topped up, or up to date on the first days of January).
    expect((preview.accrual?.posted ?? 0) + (preview.accrual?.upToDate ?? 0)).toBe(2);
    expect(await ledgerFor(al)).toEqual([]);
  });
});

// ── §2 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§2 the commit equals the preview', () => {
  it('PAST year: identical figures and verdicts; the ledger holds exactly the previewed days; outcome stored verbatim', async () => {
    const al = await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14); // a LUMP type beside it, so the year-open half grants something too
    const a = await hire('Aina');
    const c = await hire('Chen');

    const preview = await previewLeaveGeneration(ctx(), everyone(PAST));
    const commit = await runLeaveGeneration(ctx(), everyone(PAST));

    expect(figures(commit)).toEqual(figures(preview));
    expect(commit.accrual?.days).toBe(24);
    expect(await ledgerSum(al)).toBe(24);
    expect(await ledgerSum(al, a.employmentId)).toBe(12);
    expect(await ledgerSum(al, c.employmentId)).toBe(12);
    // Dated at the generation's late edge, as an accrual row.
    expect(new Set((await ledgerFor(al)).map((r) => `${r.entryType}@${r.effectiveOn}`))).toEqual(
      new Set([`accrual@${PAST}-12-31`]),
    );
    expect(await ledgerSum(sick)).toBe(28);
    expect(await eventCount('leave.earned-accrual.run')).toBe(1);

    // The processing log keeps the ENGINE's outcome, not a new stored value, and records the reached lines as passed.
    const [run] = await owner.db
      .select()
      .from(schema.leaveGenerationRun)
      .where(eq(schema.leaveGenerationRun.id, commit.runId!));
    expect(run.employeesPassed).toBe(2);
    expect(run.employeesFailed).toBe(0);
    const stored = await owner.db
      .select({ outcome: schema.leaveGenerationRunItem.outcome })
      .from(schema.leaveGenerationRunItem)
      .where(and(eq(schema.leaveGenerationRunItem.runId, commit.runId!), eq(schema.leaveGenerationRunItem.leaveTypeId, al)));
    expect(stored.map((s) => s.outcome)).toEqual(['earned_method', 'earned_method']);
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave-generation.run')));
    expect((ev.payload as { earnedAccrual: unknown }).earnedAccrual).toEqual({
      posted: 2,
      upToDate: 0,
      days: 24,
      skippedFutureYear: false,
      heldBackNextYearStarted: 0,
      forfeits: 0,
      failed: false,
    });
  });

  it('CURRENT year: identical figures, and every posted row is dated today', async () => {
    const al = await earnedAnnual();
    await hire('Aina');
    await hire('Chen');

    const preview = await previewLeaveGeneration(ctx(), everyone(YEAR));
    const commit = await runLeaveGeneration(ctx(), everyone(YEAR));

    expect(figures(commit)).toEqual(figures(preview));
    expect(await ledgerSum(al)).toBe(commit.accrual?.days);
    expect((await ledgerFor(al)).every((r) => r.effectiveOn === TODAY && r.entryType === 'accrual')).toBe(true);
  });

  it('the accrual engine is handed the SAME dryRun the generation was given — once per call, never a literal', () => {
    const code = read('core/leave-generation.ts')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code.match(/accrueEarnedLeave\(/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/accrueEarnedLeave\(ctx,\s*\{[^}]*\bemploymentIds:[^}]*\bdryRun,?\s*\}\)/);
    expect(code.includes('dryRun: true')).toBe(false);
    expect(code.includes('dryRun: false')).toBe(false);
    expect(code.match(/openLeaveYear\(/g) ?? []).toHaveLength(1);
  });
});

// ── §3 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§3 running it again adds nothing', () => {
  it('a second commit posts no row: the Annual Leave pairs read already_open, are handed over anyway, and are up to date', async () => {
    const al = await earnedAnnual();
    await hire('Aina');
    await hire('Chen');
    await runLeaveGeneration(ctx(), everyone(PAST));
    const rowsAfterFirst = await ledgerFor(al);
    expect(rowsAfterFirst).toHaveLength(2);

    const second = await runLeaveGeneration(ctx(), everyone(PAST));
    expect(await ledgerFor(al)).toEqual(rowsAfterFirst);
    expect(second.lines.filter((l) => l.leaveTypeId === al).every((l) => l.outcome === 'already_open')).toBe(true);
    // Parent hand-fix — an already-open earned Annual Leave pair IS handed to the accrual (the cron makes every pair
    // already_open on a live tenant); the shortfall is nil, so it reads up to date and writes nothing.
    expect(second.accrual).toMatchObject({ annualLeaveLines: 2, posted: 0, upToDate: 2, days: 0 });
    expect(second.lines.filter((l) => l.leaveTypeId === al).every((l) => l.earnedAccrual === 'up_to_date')).toBe(true);
    expect(second.employeesFailed).toBe(0);
  });

  it('a pair the monthly run ALREADY OPENED this year is topped up to today by Generate (the cron case)', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    // An earlier accrual run inside THIS leave year, as the monthly cron would have posted: the year-open now calls
    // the pair `already_open`, and before the hand-fix Generate never reached it.
    const firstOfYear = `${YEAR}-01-31`;
    await accrueEarnedLeave(ctx(), { asOf: firstOfYear, leaveTypeIds: [al], employmentIds: [a.employmentId] });
    const before = await ledgerSum(al, a.employmentId);

    const commit = await runLeaveGeneration(ctx(), everyone(YEAR));
    const line = commit.lines.find((l) => l.employmentId === a.employmentId && l.leaveTypeId === al);
    expect(line?.outcome).toBe('already_open');
    const after = await ledgerSum(al, a.employmentId);
    if (Number(TODAY.slice(5, 7)) > 1) {
      // Earned more since 31 January: Generate adds it.
      expect(after, 'Generate tops the already-opened pair up to today').toBeGreaterThan(before);
      expect(line?.earnedAccrual).toBe('topped_up');
    } else {
      expect(line?.earnedAccrual).toBe('up_to_date');
    }
  });

  it('a pair reached with NOTHING outstanding reads "already up to date": counted, passed, nothing posted', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');
    // Aina's full year already sits on the ledger as a profile-recalc credit — an adjustment, so it is not
    // the year-open marker (her line stays `earned_method`), but the accrual counts it as already accrued.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: a.employmentId,
      leaveTypeId: al,
      entryType: 'adjustment',
      days: '12.00',
      effectiveOn: `${PAST}-06-30`,
      reason: `${PROFILE_RECALC_REASON_PREFIX}:r301-fixture`,
    });

    const preview = await previewLeaveGeneration(ctx(), everyone(PAST));
    const commit = await runLeaveGeneration(ctx(), everyone(PAST));
    expect(figures(commit)).toEqual(figures(preview));
    expect(commit.accrual).toMatchObject({ posted: 1, upToDate: 1, days: 12 });
    expect(commit.accrual?.byLeaveType).toEqual([
      { leaveTypeId: al, leaveTypeName: expect.any(String), posted: 1, upToDate: 1, days: 12 },
    ]);
    const verdict = (id: string) => commit.lines.find((l) => l.employmentId === id && l.leaveTypeId === al)?.earnedAccrual;
    expect(verdict(a.employmentId)).toBe('up_to_date');
    expect(verdict(c.employmentId)).toBe('topped_up');
    expect(commit.employeesFailed).toBe(0);
    expect(await ledgerSum(al, a.employmentId)).toBe(12); // nothing added on top of the credit
    expect(await ledgerSum(al, c.employmentId)).toBe(12);
  });
});

// ── §4 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§4 a FUTURE year posts no accrual and says so', () => {
  it('preview and commit: skippedFutureYear, no Annual Leave row, no accrual event, lines not reached', async () => {
    const al = await earnedAnnual();
    await hire('Aina');
    await hire('Chen');

    failAccrual.calls = 0; // counted from here: the generation alone
    const preview = await previewLeaveGeneration(ctx(), everyone(FUTURE));
    const commit = await runLeaveGeneration(ctx(), everyone(FUTURE));

    for (const r of [preview, commit]) {
      expect(r.accrual).toEqual({
        annualLeaveLines: 2,
        notAnnualLeaveLines: 0,
        skippedFutureYear: true,
        heldBackNextYearStarted: 0,
        forfeits: 0,
        asOf: null,
        posted: 0,
        upToDate: 0,
        days: 0,
        byLeaveType: [],
        error: null,
      });
      expect(r.lines.filter((l) => l.leaveTypeId === al).every((l) => l.earnedAccrual === null)).toBe(true);
    }
    expect(failAccrual.calls, 'the accrual engine must not be called for a future year').toBe(0);
    expect(await ledgerFor(al)).toEqual([]);
    expect(await eventCount('leave.earned-accrual.run')).toBe(0);
    // …and the message says the days come as the year goes by.
    const en = createTranslator({ locale: 'en', messages: msgs('en'), namespace: 'admin.leave' });
    const m = leaveGenerationMessages(en as unknown as GenerationTranslate, commit);
    expect(m.toast).toContain(en('generateToastAccrualFuture', { year: FUTURE }));
    expect(m.error).toBeNull();
  });
});

// ── §5 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§5 an accrual failure leaves the generation committed and is returned', () => {
  it('COMMIT: a REAL mid-write refusal — the lump grant and the run log stay, the accrual rolls back whole, the error is returned', async () => {
    const al = await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14);
    const a = await hire('Aina');
    const c = await hire('Chen');
    // Postgres refuses the SECOND employee's earned-accrual row. Whatever order the engine visits them in, a
    // committed partial accrual would leave the other employee's row behind; the transaction must take it back.
    await owner.db.execute(sql.raw(`
      create or replace function r301_refuse_accrual() returns trigger language plpgsql as $$
      begin
        if new.leave_type_id = '${al}' and new.employment_id = '${c.employmentId}' then
          raise exception 'r301 simulated ledger refusal';
        end if;
        return new;
      end $$;
      create trigger r301_refuse_accrual before insert on leave_ledger
        for each row execute function r301_refuse_accrual();
    `));
    try {
      const commit = await runLeaveGeneration(ctx(), everyone(PAST));

      expect(typeof commit.accrual?.error).toBe('string');
      expect(commit.accrual?.error?.length).toBeGreaterThan(0);
      expect(commit.accrual).toMatchObject({ posted: 0, upToDate: 0, days: 0, byLeaveType: [], asOf: `${PAST}-12-31` });
      // THE GENERATION STAYS: Medical Leave granted to both, the run logged, the event appended.
      expect(await ledgerSum(sick, a.employmentId)).toBe(14);
      expect(await ledgerSum(sick, c.employmentId)).toBe(14);
      expect(commit.runId).toBeTruthy();
      expect(await eventCount('leave-generation.run')).toBe(1);
      // THE ACCRUAL IS ALL-OR-NOTHING: not even the first employee's row survives, and no accrual event.
      expect(await ledgerFor(al)).toEqual([]);
      expect(await eventCount('leave.earned-accrual.run')).toBe(0);
      // No Annual Leave line was reached, so none carries an earned verdict.
      expect(commit.lines.filter((l) => l.leaveTypeId === al).every((l) => l.earnedAccrual === null)).toBe(true);
      // The message: the generation sentence as a toast, the failure as the error — naming where to run it.
      const en = createTranslator({ locale: 'en', messages: msgs('en'), namespace: 'admin.leave' });
      const m = leaveGenerationMessages(en as unknown as GenerationTranslate, commit);
      expect(m.toast).toContain(`Leave year ${PAST}`);
      expect(m.error).toContain(commit.accrual!.error!);
      expect(m.error).toContain('Run Earned Accrual');
    } finally {
      await owner.db.execute(sql.raw('drop trigger if exists r301_refuse_accrual on leave_ledger; drop function if exists r301_refuse_accrual();'));
    }
  });

  it('COMMIT, thrown before any write: the error is returned verbatim and the generation is committed', async () => {
    const al = await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14);
    const a = await hire('Aina');
    failAccrual.message = 'simulated accrual outage';
    failAccrual.calls = 0;

    const commit = await runLeaveGeneration(ctx(), everyone(PAST));

    expect(failAccrual.calls).toBe(1);
    expect(commit.accrual?.error).toBe('simulated accrual outage');
    expect(await ledgerSum(sick, a.employmentId)).toBe(14);
    expect(commit.runId).toBeTruthy();
    expect(await ledgerFor(al)).toEqual([]);
    expect(commit.employeesPassed).toBe(1); // Medical Leave was granted
  });

  it('PREVIEW: the failure is returned rather than thrown, and the screen’s counts still arrive', async () => {
    await earnedAnnual();
    await hire('Aina');
    failAccrual.message = 'simulated accrual outage';
    const preview = await previewLeaveGeneration(ctx(), everyone(PAST));
    expect(preview.accrual?.error).toBe('simulated accrual outage');
    expect(preview.employeesSelected).toBe(1);
  });

  it('the accrual runs in a transaction of its own, AFTER the year-open has committed', () => {
    // Sequenced, never nested: the header's rule. The only transactions this module opens are its own
    // `withTenant` calls; the two engines open theirs. A nested call would share one transaction and roll
    // the grant back with the accrual.
    const code = read('core/leave-generation.ts');
    const openAt = code.indexOf('await openLeaveYear(ctx');
    const accrueAt = code.indexOf('await accrueEarnedLeave(ctx');
    expect(openAt).toBeGreaterThan(0);
    expect(accrueAt).toBeGreaterThan(openAt);
    const between = code.slice(openAt, accrueAt);
    expect(between.includes('withTenant(')).toBe(false);
    // …and it is inside a try whose catch RECORDS the error rather than rethrowing it.
    const tail = code.slice(accrueAt, code.indexOf('const accruedBy'));
    expect(tail).toMatch(/catch \(e\) \{\s*accrual\.error = /);
    expect(tail.includes('throw')).toBe(false);
  });
});

describe('§5b the Run Earned Accrual actions require an administrator', () => {
  it('preview and run call requireAdmin, not a bare session (the 4b0e76ae hole on openLeaveYearAction)', () => {
    const reasonSrc = read('app/admin/leave-config/earned-accrual/actions.ts');
    expect(reasonSrc, 'the preview the Run Earned Accrual screen actually calls').toContain('await requireAdmin()');
    expect(reasonSrc).not.toContain('getSession(');
    const src = read('app/admin/actions.ts');
    for (const name of ['previewEarnedAccrualAction', 'runEarnedAccrualAction']) {
      const at = src.indexOf(`export async function ${name}(`);
      expect(at, name).toBeGreaterThan(0);
      const head = src.slice(at, src.indexOf('try {', at));
      expect(head, `${name} must gate on requireAdmin`).toContain('await requireAdmin()');
      expect(head).not.toContain('await getSession()');
    }
  });
});

// ── §6 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§5c parent hand-fix — what the accrual verifier found', () => {
  it('a carry FORFEIT the accrual posts is counted in preview AND commit, not only the earned days', async () => {
    const al = await earnedAnnual();
    await owner.db
      .update(schema.leaveType)
      .set({ carryForwardEnabled: true, carryForwardMax: '2' as never })
      .where(eq(schema.leaveType.id, al));
    const a = await hire('Aina');
    // A prior-year balance of 12, above the cap of 2: the first accrual of THIS cycle forfeits the excess.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId, employmentId: a.employmentId, leaveTypeId: al, entryType: 'accrual', days: '12.00', effectiveOn: `${PAST}-06-30`,
    });
    const preview = await previewLeaveGeneration(ctx(), everyone(YEAR));
    const commit = await runLeaveGeneration(ctx(), everyone(YEAR));
    expect(preview.accrual?.forfeits, 'the preview discloses the forfeit').toBe(1);
    expect(commit.accrual?.forfeits).toBe(1);
    expect(commit.forfeits, 'folded into the run total the toast, log and event report').toBe(preview.forfeits);
    expect(commit.forfeits).toBeGreaterThanOrEqual(1);
  });

  it('a PAST year does not top up a pair whose following year has already started, and says so', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');
    // Aina's CURRENT year has begun on the ledger (as the monthly cron would have made it); Chen's has not.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId, employmentId: a.employmentId, leaveTypeId: al, entryType: 'accrual', days: '1.00', effectiveOn: `${YEAR}-01-31`,
    });
    const before = await ledgerSum(al, a.employmentId);
    const commit = await runLeaveGeneration(ctx(), everyone(PAST));
    expect(commit.accrual?.heldBackNextYearStarted).toBe(1);
    expect(await ledgerSum(al, a.employmentId), 'nothing added to a pair whose next year started').toBe(before);
    expect((await ledgerSum(al, c.employmentId)) > 0, 'the other employee is still topped up').toBe(true);
  });

  it('the not-Annual-Leave count stays right when already-opened Annual Leave pairs are handed over', async () => {
    const al = await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14);
    await setMethod(sick, 'earned_monthly');
    await hire('Aina');
    await hire('Chen');
    await runLeaveGeneration(ctx(), everyone(PAST)); // opens Annual Leave for both
    const second = await runLeaveGeneration(ctx(), everyone(PAST));
    expect(second.lines.filter((l) => l.leaveTypeId === al).every((l) => l.outcome === 'already_open')).toBe(true);
    expect(second.accrual?.notAnnualLeaveLines).toBe(2);
  });

  it('a 0-day earned Annual Leave entitlement is NOT "already up to date" and does not pass', async () => {
    const al = b.annualLeaveTypeId;
    await setMethod(al, 'earned_monthly');
    await configure(al, 0);
    const a = await hire('Aina');
    const commit = await runLeaveGeneration(ctx(), everyone(PAST));
    const line = commit.lines.find((l) => l.employmentId === a.employmentId && l.leaveTypeId === al);
    expect(line?.earnedAccrual ?? null).toBeNull();
    expect(commit.accrual?.upToDate ?? 0).toBe(0);
  });
});

describe('§6 an earned type that is NOT Annual Leave is never accrued', () => {
  it('SICK on earned_monthly: counted as not-Annual-Leave, no row; Annual Leave beside it is accrued (positive control)', async () => {
    const al = await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14);
    await setMethod(sick, 'earned_monthly'); // raw: the service refuses this since r299 — the legacy shape
    const a = await hire('Aina');

    const commit = await runLeaveGeneration(ctx(), everyone(PAST));

    const line = (id: string) => commit.lines.find((l) => l.employmentId === a.employmentId && l.leaveTypeId === id)!;
    expect(line(sick)).toMatchObject({ outcome: 'earned_method', earnedMethodNotAnnualLeave: true, earnedAccrual: null });
    expect(line(al)).toMatchObject({ outcome: 'earned_method', earnedMethodNotAnnualLeave: false, earnedAccrual: 'topped_up' });
    expect(commit.accrual).toMatchObject({ annualLeaveLines: 1, notAnnualLeaveLines: 1, posted: 1, days: 12 });
    expect(await ledgerFor(sick)).toEqual([]);
    expect(await ledgerSum(al)).toBe(12);
    // The accrual was scoped to Annual Leave only.
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave.earned-accrual.run')));
    expect((ev.payload as { leaveTypeIds: string[] }).leaveTypeIds).toEqual([al]);
  });

  it('ONLY a stranded type selected: the accrual engine is not called, and the result counts the lines', async () => {
    await earnedAnnual();
    const sick = await mkType('SICK', 'Medical Leave');
    await configure(sick, 14);
    await setMethod(sick, 'earned_monthly');
    await hire('Aina');

    failAccrual.calls = 0;
    const commit = await runLeaveGeneration(ctx(), { ...everyone(PAST), leaveTypeIds: [sick] });
    expect(failAccrual.calls).toBe(0);
    expect(commit.accrual).toMatchObject({ annualLeaveLines: 0, notAnnualLeaveLines: 1, asOf: null, posted: 0 });
    expect(await ledgerFor(sick)).toEqual([]);
    expect(await ledgerSum(b.annualLeaveTypeId)).toBe(0);
    const en = createTranslator({ locale: 'en', messages: msgs('en'), namespace: 'admin.leave' });
    expect(leaveGenerationMessages(en as unknown as GenerationTranslate, commit).toast).toContain(
      en('generateToastAccrualNotAnnualLeave', { count: 1 }),
    );
  });
});

// ── §7 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§7 employee scoping', () => {
  it('THROUGH GENERATION: two of three employees generated ⇒ exactly those two accrued; the third untouched', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');
    const d = await hire('Dev');

    const commit = await runLeaveGeneration(ctx(), {
      year: PAST,
      targetMode: 'individual',
      employmentIds: [a.employmentId, c.employmentId],
    });
    expect(commit.accrual).toMatchObject({ posted: 2, days: 24 });
    expect(await ledgerSum(al, a.employmentId)).toBe(12);
    expect(await ledgerSum(al, c.employmentId)).toBe(12);
    expect(await ledgerSum(al, d.employmentId)).toBe(0);
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.tenantId, b.tenantId), eq(schema.domainEvent.eventType, 'leave.earned-accrual.run')));
    expect([...(ev.payload as { employmentIds: string[] }).employmentIds].sort()).toEqual(
      [a.employmentId, c.employmentId].sort(),
    );
  });

  it('THE ENGINE: a list reaches exactly its members; [] reaches NOBODY, even on commit; absent reaches everyone', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    const c = await hire('Chen');
    const d = await hire('Dev');
    const asOf = `${PAST}-12-31`;

    const two = await accrueEarnedLeave(ctx(), { asOf, leaveTypeIds: [al], employmentIds: [a.employmentId, c.employmentId], dryRun: true });
    expect(two.pairs.map((p) => p.employmentId).sort()).toEqual([a.employmentId, c.employmentId].sort());
    expect(two.granted).toBe(2);

    const nobody = await accrueEarnedLeave(ctx(), { asOf, leaveTypeIds: [al], employmentIds: [] });
    expect(nobody.granted).toBe(0);
    expect(nobody.breakdown).toEqual([]);
    expect(nobody.pairs).toEqual([]);
    expect(nobody.emptyReason?.kind).toBe('no_employment_in_scope');
    expect(await ledgerFor(al)).toEqual([]);
    expect(await eventCount('leave.earned-accrual.run')).toBe(0);

    // A list that only held blanks is still a list: nobody, never everyone.
    const blanks = await accrueEarnedLeave(ctx(), { asOf, leaveTypeIds: [al], employmentIds: [''], dryRun: true });
    expect(blanks.granted).toBe(0);

    const all = await accrueEarnedLeave(ctx(), { asOf, leaveTypeIds: [al], dryRun: true });
    expect(all.pairs.map((p) => p.employmentId).sort()).toEqual([a.employmentId, c.employmentId, d.employmentId].sort());
  });

  it('pairs are the breakdown unrolled: count, top-ups and days agree with the grouped figures', async () => {
    const al = await earnedAnnual();
    const a = await hire('Aina');
    await hire('Chen');
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: a.employmentId,
      leaveTypeId: al,
      entryType: 'adjustment',
      days: '5.00',
      effectiveOn: `${PAST}-06-30`,
      reason: `${PROFILE_RECALC_REASON_PREFIX}:r301-fixture`,
    });
    const r = await accrueEarnedLeave(ctx(), { asOf: `${PAST}-12-31`, dryRun: true });
    expect(r.pairs.length).toBe(r.breakdown.reduce((n, g) => n + g.employeeCount, 0));
    expect(r.pairs.filter((p) => p.days > 0).length).toBe(r.granted);
    expect(r.pairs.reduce((n, p) => n + p.days, 0)).toBe(r.breakdown.reduce((n, g) => n + g.entitlementGenerated, 0));
    expect(r.pairs.find((p) => p.employmentId === a.employmentId)?.days).toBe(7);
  });
});

// ── §8 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('§8 Failed no longer counts earned Annual Leave the accrual reached', () => {
  it('the same fixture: PAST year (reached) passes everyone; FUTURE year (not reached) still fails them', async () => {
    await earnedAnnual();
    await hire('Aina');
    await hire('Chen');

    const past = await previewLeaveGeneration(ctx(), everyone(PAST));
    expect(past.employeesPassed).toBe(2);
    expect(past.employeesFailed).toBe(0);

    const future = await previewLeaveGeneration(ctx(), everyone(FUTURE));
    expect(future.employeesPassed).toBe(0);
    expect(future.employeesFailed).toBe(2);
  });
});

// ── §9 ───────────────────────────────────────────────────────────────────────────────────────────────

const NEW_KEYS = [
  'generateToastAccrualAdded',
  'generateToastAccrualNothing',
  'generateToastAccrualFuture',
  'generateToastAccrualNotAnnualLeave',
  'generateToastAccrualFailed',
  'generateGrantTitle',
  'generateGrantNone',
  'generateGrantColEmployees',
  'generateGrantColDays',
  'generateAccrualTitle',
  'generateAccrualColToppedUp',
  'generateAccrualColUpToDate',
  'generateAccrualAsAt',
  'generateAccrualFuture',
  'generateAccrualFailed',
  'generateAccrualNothing',
  'generateAccrualNotAnnualLeave',
  'generateIssuesAria',
] as const;

const accrualOf = (over: Partial<NonNullable<LeaveGenerationResult['accrual']>>): NonNullable<LeaveGenerationResult['accrual']> => ({
  annualLeaveLines: 2,
  notAnnualLeaveLines: 0,
  skippedFutureYear: false,
  heldBackNextYearStarted: 0,
  forfeits: 0,
  asOf: `${PAST}-12-31`,
  posted: 1,
  upToDate: 1,
  days: 12,
  byLeaveType: [],
  error: null,
  ...over,
});

describe('§9 one message, truthful nouns, six locales', () => {
  it('every new key exists in all six catalogues and is TRANSLATED (not the English string)', () => {
    const en = msgs('en').admin.leave;
    for (const loc of LOCALES) {
      const leave = msgs(loc).admin.leave;
      for (const k of [...NEW_KEYS, 'generateToast']) {
        expect(typeof leave[k], `${loc} admin.leave.${k}`).toBe('string');
        expect(String(leave[k]).length, `${loc} admin.leave.${k}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(leave[k], `${loc} admin.leave.${k} is still English`).not.toBe(en[k]);
      }
      // The Failed-preview sentence keeps its link tag, or the way to Run Earned Accrual silently vanishes.
      expect(String(leave.generateAccrualFailed), `${loc} generateAccrualFailed <link>`).toMatch(/<link>[^<]+<\/link>/);
    }
  });

  it('the toast no longer calls a record an employee', () => {
    const en = msgs('en').admin.leave.generateToast as string;
    expect(en).toContain('{granted}');
    expect(en).not.toMatch(/\{granted\} employee/);
  });

  it('every state formats in every locale with its figures substituted — no FORMATTING_ERROR, no stray brace', () => {
    const states: { name: string; res: Parameters<typeof leaveGenerationMessages>[1]; error: boolean }[] = [
      { name: 'no earned line', res: { year: PAST, granted: 4, skipped: 1, forfeits: 0, accrual: null }, error: false },
      { name: 'added', res: { year: PAST, granted: 4, skipped: 1, forfeits: 0, accrual: accrualOf({ posted: 7, upToDate: 3, days: 84 }) }, error: false },
      { name: 'nothing reached', res: { year: PAST, granted: 4, skipped: 1, forfeits: 0, accrual: accrualOf({ posted: 0, upToDate: 0, days: 0 }) }, error: false },
      { name: 'future', res: { year: FUTURE, granted: 4, skipped: 1, forfeits: 0, accrual: accrualOf({ skippedFutureYear: true, asOf: null, posted: 0, upToDate: 0, days: 0 }) }, error: false },
      { name: 'failed', res: { year: PAST, granted: 4, skipped: 1, forfeits: 0, accrual: accrualOf({ error: 'boom-reason', posted: 0, upToDate: 0, days: 0 }) }, error: true },
      { name: 'stranded', res: { year: PAST, granted: 4, skipped: 1, forfeits: 0, accrual: accrualOf({ annualLeaveLines: 0, notAnnualLeaveLines: 3, posted: 0, upToDate: 0, days: 0 }) }, error: false },
    ];
    for (const loc of LOCALES) {
      const t = createTranslator({ locale: loc, messages: msgs(loc), namespace: 'admin.leave' });
      for (const s of states) {
        const m = leaveGenerationMessages(t as unknown as GenerationTranslate, s.res);
        const all = `${m.toast} ${m.error ?? ''}`;
        expect(all, `${loc} ${s.name}`).not.toMatch(/[{}]/);
        expect(all, `${loc} ${s.name}`).not.toContain('admin.leave');
        expect(m.toast, `${loc} ${s.name} names the year`).toContain(String(s.res.year));
        expect(m.error !== null, `${loc} ${s.name} error channel`).toBe(s.error);
        if (s.name === 'added') for (const n of ['7', '3', '84']) expect(m.toast, `${loc} added ${n}`).toContain(n);
        if (s.name === 'failed') expect(m.error, `${loc} failed reason`).toContain('boom-reason');
        if (s.name === 'stranded') expect(m.toast, `${loc} stranded count`).toContain('3');
      }
      // The screen's own formatted strings, including the rich link.
      expect(t('generateAccrualAsAt', { date: `${PAST}-12-31` })).toContain(`${PAST}-12-31`);
      expect(t('generateAccrualFuture', { year: FUTURE })).toContain(String(FUTURE));
      expect(t('generateAccrualNotAnnualLeave', { count: 2 })).toContain('2');
      expect(t('generateAccrualNothing', { date: TODAY })).toContain(TODAY);
      const rich = t.markup('generateAccrualFailed', { reason: 'boom', link: (c) => `[${c}]` });
      expect(rich, `${loc} rich`).toContain('boom');
      expect(rich, `${loc} rich link`).toMatch(/\[[^\]]+\]/);
    }
  });
});
