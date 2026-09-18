/**
 * d58bfa3f — WHO MOVES, AND BY HOW MUCH, before anything is applied.
 *
 * The approved plan promises the reporter, in these words: "We check every other first-year employee at the
 * same time, and tell you whose figures move and by how much BEFORE anything is applied." r307 shipped the
 * engine fix but moved no figure — `accrueEarnedLeave` only writes when it RUNS, and the next automatic run
 * is the monthly `accrue-earned` cron. This report is what has to reach the reporter before that.
 *
 * READ-ONLY, BY CONSTRUCTION. Every call is `accrueEarnedLeave(..., { dryRun: true })`, whose own contract
 * is "compute everything, write NOTHING (no ledger rows, no event)". This script contains no insert, no
 * update and no delete. Run it as often as you like.
 *
 * WHY NOT `accrueEarnedLeave`'s OWN dry run, once? Because it returns a breakdown GROUPED by company /
 * grade / leave type (see its header), and "27 employees in this group" is not "whose figures move". So it
 * is invoked once per employment, scoped with `employmentIds`, and the per-person figure is read off the
 * same computation the real commit would perform — not a re-implementation of it, which would be a second
 * definition of the arithmetic this whole item exists to unify.
 *
 * THE TWO NUMBERS.
 *   · BEFORE — what the type's ledger holds for this employee today.
 *   · AFTER  — what the engine would credit at `asOf`, which post-r307 is the a2c up-front part-year figure
 *              for an employee in their hire year on an a2c type, and the ordinary earned slice otherwise.
 *   · DELTA  — AFTER − BEFORE. The accrual engine only ever tops UP, so a negative delta is NOT something
 *              the sweep would apply; it is surfaced anyway, loudly, because it would mean the ledger
 *              already holds more than the engine thinks it should and that is worth a human looking at.
 *
 * OUTPUT. The per-employee list is written to a FILE and the console gets only counts and totals. That is
 * deliberate: the list names individual employees, and it belongs in the owner's hands and the reporter's
 * report, not scrolling through an agent's terminal.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-a2c-hire-year-deltas.ts [YYYY-MM-DD]
 */
import { writeFileSync } from 'node:fs';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { loadSweepScope } from '../core/sweep-scope';
import { accrueEarnedLeave, todayInKualaLumpur } from '../core/leave';
import { employment, leaveLedger, leaveType, person } from '../db/schema';

const asOf = process.argv[2] ?? todayInKualaLumpur();
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`usage: report-a2c-hire-year-deltas.ts [YYYY-MM-DD]  (got ${asOf})`);
  process.exit(2);
}
const yearStart = `${asOf.slice(0, 4)}-01-01`;
const OUT = `/var/tmp/a2c-hire-year-deltas-${asOf}.txt`;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const db = owner.db;
  // Standing is consulted before anything else, exactly as scripts/accrue-earned.ts does: a tenant that is
  // not in good standing is stepped over rather than attempted.
  const scope = await loadSweepScope(db);
  const inScope = new Set(scope.run.map((t) => t.id));

  // The types this can possibly touch: a2c, carrying an earned method. Anything else is untouched by r307.
  const types = await db
    .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name, tenantId: leaveType.tenantId })
    .from(leaveType)
    .where(and(eq(leaveType.yearCycleOverride, 'a2c'), sql`${leaveType.accrualMethod} like 'earned%'`));

  if (types.length === 0) {
    console.log('No a2c leave type carries an earned method. r307 changes nothing here.');
    return;
  }

  // Only an employee in their HIRE year can be affected — `isA2cFirstYear` is false once the year turns.
  const emps = await db
    .select({
      employmentId: employment.id,
      tenantId: employment.tenantId,
      code: employment.employeeCode,
      name: person.fullName,
      hiredOn: employment.hiredOn,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .where(and(isNull(employment.terminatedOn), gte(employment.hiredOn, yearStart)));
  const scoped = emps.filter((e) => inScope.has(e.tenantId));

  const lines: string[] = [
    `d58bfa3f — a2c hire-year figures, BEFORE vs AFTER r307`,
    `as of ${asOf}   ·   generated ${new Date().toISOString()}   ·   READ-ONLY (dry run)`,
    `leave types in scope: ${types.map((t) => `${t.code ?? t.id} (${t.name})`).join(', ')}`,
    ``,
    `EMPLOYEE ID | NAME | HIRED | LEAVE TYPE | BEFORE | AFTER | DELTA`,
    `-`.repeat(96),
  ];

  let moved = 0;
  let unchanged = 0;
  let negative = 0;
  let totalDelta = 0;

  for (const e of scoped) {
    for (const t of types.filter((x) => x.tenantId === e.tenantId)) {
      const [held] = await db
        .select({ n: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
        .from(leaveLedger)
        .where(and(eq(leaveLedger.employmentId, e.employmentId), eq(leaveLedger.leaveTypeId, t.id)));
      const before = Number(held.n);

      // The REAL engine, scoped to this one employment and type, writing nothing. The context is the one
      // scripts/accrue-earned.ts uses for the monthly sweep — a SYSTEM context with the hr_admin role and
      // the sweeps entitlement exemption — so this previews exactly what that cron would do.
      const preview = await accrueEarnedLeave(
        { tenantId: e.tenantId, roles: ['hr_admin'], entitlementsExempt: 'sweeps' },
        { asOf, dryRun: true, employmentIds: [e.employmentId], leaveTypeIds: [t.id] },
      );
      const after = Number(preview.earnedToDateTotal ?? 0);
      const delta = Math.round((after - before) * 100) / 100;

      if (delta === 0) {
        unchanged += 1;
        continue;
      }
      if (delta < 0) negative += 1;
      moved += 1;
      totalDelta = Math.round((totalDelta + delta) * 100) / 100;
      lines.push(
        `${e.code ?? '—'} | ${e.name} | ${e.hiredOn} | ${t.code ?? t.name} | ` +
          `${before.toFixed(2)} | ${after.toFixed(2)} | ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`,
      );
    }
  }

  lines.push(``, `moved: ${moved}   unchanged: ${unchanged}   negative: ${negative}   total delta: ${totalDelta.toFixed(2)}`);
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  // Console gets COUNTS ONLY — the list names individuals and belongs in the file, not in a terminal.
  console.log(`a2c hire-year preview @ ${asOf}`);
  console.log(`  employees in hire year : ${scoped.length}`);
  console.log(`  leave types in scope   : ${types.length}`);
  console.log(`  figures that MOVE      : ${moved}`);
  console.log(`  unchanged              : ${unchanged}`);
  console.log(`  NEGATIVE deltas        : ${negative}  ${negative ? '  <-- look at these' : ''}`);
  console.log(`  total delta (days)     : ${totalDelta.toFixed(2)}`);
  console.log(`  per-employee list      : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
