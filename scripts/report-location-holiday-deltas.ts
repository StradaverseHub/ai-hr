/**
 * 0fe1ca2e — WHOSE PUBLIC HOLIDAYS MOVE if the per-company site register goes, before anything is applied.
 *
 * The approved plan promises the reporter, in these words: "We will show you the two employees' before-and-
 * after holiday lists once the work state is set, so you can see that nothing moved rather than take our
 * word for it." Public holidays drive the attendance day-type (which fixes the OT class = money) and the
 * working-day leave count, so "nothing moved" is a claim that has to be DEMONSTRATED on the real rows, on
 * the real engine, before a single column is dropped.
 *
 * READ-ONLY, BY CONSTRUCTION, TWICE OVER. (1) This file contains no insert, no update and no delete.
 * (2) The whole report runs inside `SET TRANSACTION READ ONLY`, so a write introduced here later does not
 * quietly succeed — Postgres refuses it. Run it as often as you like, on production, during payroll.
 *
 * WHAT "AFTER" MEANS, EXACTLY. The plan's order is load-bearing: `employment.work_state` is set to the
 * state the site was supplying FIRST, and only then does the site input go. So AFTER = the calendar this
 * employment resolves to when (a) the open assignment carries no location and (b) work_state carries the
 * location's state. Both halves are previewed together, because previewing only one of them describes a
 * world that never exists.
 *
 * WHY IT DOES NOT RE-IMPLEMENT THE PRECEDENCE. `holidayDatesFor` (core/holidays.ts) is the single resolver
 * behind leave, payroll and attendance, and its header spends forty lines keeping ONE definition of the
 * business-group → state → national precedence. A report that re-expressed it to compute AFTER would be a
 * second copy, and a second copy that disagreed would produce a reassuring before/after for a change that
 * moves somebody's holiday. So AFTER comes from the SAME resolver, called with its read-only `whatIf`
 * override (see HolidayWhatIf in core/holidays.ts) — the shape scripts/report-a2c-hire-year-deltas.ts uses
 * when it asks the real accrual engine for a figure with `dryRun: true`.
 *
 * WHAT IT CHECKS RATHER THAN ASSUMES. The plan was written against measurements taken on production on
 * 2026-09-22 (8 locations, all with a state, none with a mapped holiday calendar; 2 open assignments using
 * one). Those are inputs to a decision, not facts this script may trust: it re-counts all of them and
 * prints the counts, so a location mapped to a calendar, or a ninth site, or a third employee, shows up in
 * the output instead of being silently resolved by a stale assumption.
 *
 * FOUR SHAPES ARE CALLED OUT BY NAME, because each breaks the plan's promise in a different way:
 *   · BLOCKED  — the employment already carries a holiday GROUP. `employment_holiday_assignment_xor`
 *                (db/schema.ts) makes work_state and holiday_group_id mutually exclusive, so the plan's
 *                "set their work state" step CANNOT be performed without taking their group away. The
 *                group also outranks work_state in the resolver, so the site's state has nowhere to go.
 *   · CALENDAR — the location maps to a named holiday calendar (ADR-0067). A work_state cannot carry a
 *                calendar, so removing the site removes the calendar with it, whatever is set on the
 *                employee. This is the shape the plan measured as absent on production.
 *   · NO STATE — the location has no state override, so there is nothing to carry over; the employee
 *                simply falls to their own work_state / the company default, as they largely already do.
 *   · AMBIGUOUS— more than one OPEN assignment row. `holidayDatesFor` takes an arbitrary one via
 *                `.limit(1)`, so before/after for this employment is not a stable pair of answers.
 *
 * OUTPUT. Counts to the console; the PER-EMPLOYEE list, with both full holiday sets, to a FILE. That is
 * deliberate and copied from report-a2c-hire-year-deltas.ts: the list names individual employees and
 * belongs in the owner's hands and the reporter's report, not scrolling through an agent's terminal.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-location-holiday-deltas.ts [YYYY]
 *
 * The year defaults to the CURRENT Kuala Lumpur year (lib/hr-date.ts todayInKualaLumpur — never a date
 * read off a raw instant). Pass a year to look ahead: the reporter's question is about 2026.
 */
import { writeFileSync } from 'node:fs';
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { holidayDatesFor } from '../core/holidays';
import { todayInKualaLumpur } from '../lib/hr-date';
import { assignment, company, employment, holiday, holidayGroup, location, person } from '../db/schema';

const year = process.argv[2] ?? todayInKualaLumpur().slice(0, 4);
if (!/^\d{4}$/.test(year)) {
  console.error(`usage: report-location-holiday-deltas.ts [YYYY]  (got ${year})`);
  process.exit(2);
}
const startDate = `${year}-01-01`;
const endDate = `${year}-12-31`;
const OUT = `/var/tmp/location-holiday-deltas-${year}.txt`;

/** A holiday set rendered for a human: every date, in order, with the name(s) the gazette gives it. */
function render(dates: Set<string>, names: Map<string, string>): string[] {
  return [...dates].sort().map((d) => `${d}  ${names.get(d) ?? '(no matching holiday row)'}`);
}

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to read across tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  // Deliberately NOT scoped by tenant standing (unlike the sweep previews): a suspended tenant's employees
  // still have public holidays, and this report exists to say who is affected by a SCHEMA change, which
  // reaches every tenant at once regardless of who is paying.
  const report = await owner.db.transaction(async (tx) => {
    // Structural read-only. Must be the first statement in the transaction.
    await tx.execute(sql`set transaction read only`);

    // ── Inventory: the plan's production measurements, RE-TAKEN rather than trusted ──────────────────
    const [siteCounts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        live: sql<number>`count(*) filter (where ${location.archivedAt} is null)::int`,
        withState: sql<number>`count(*) filter (where ${location.state} is not null)::int`,
        withCalendar: sql<number>`count(*) filter (where ${location.holidayGroupId} is not null)::int`,
      })
      .from(location);

    const [openUse] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(assignment)
      .where(and(isNotNull(assignment.locationId), isNull(assignment.validTo), isNull(assignment.supersededAt)));

    // ── The population: every employment whose OPEN assignment points at a location ──────────────────
    // The open-assignment predicate is the RESOLVER's own (valid_to IS NULL AND superseded_at IS NULL), so
    // this reads exactly the rows holidayDatesFor reads. Terminated employments are included and labelled
    // rather than filtered: a terminated employee's frozen attendance rows are historical, but their leave
    // balance can still be settled, and "we did not look" is not a thing this report may say.
    const rows = await tx
      .select({
        employmentId: employment.id,
        tenantId: employment.tenantId,
        code: employment.employeeCode,
        name: person.fullName,
        terminatedOn: employment.terminatedOn,
        workState: employment.workState,
        empHolidayGroupId: employment.holidayGroupId,
        empHolidayGroupName: holidayGroup.name,
        companyId: employment.companyId,
        companyName: company.legalName,
        country: company.country,
        companyDefaultState: company.defaultWorkState,
        locationId: assignment.locationId,
        locationCode: location.code,
        locationName: location.name,
        locationState: location.state,
        locationCalendarId: location.holidayGroupId,
        locationArchivedAt: location.archivedAt,
      })
      .from(assignment)
      .innerJoin(employment, eq(employment.id, assignment.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .innerJoin(company, eq(company.id, employment.companyId))
      .innerJoin(location, eq(location.id, assignment.locationId))
      .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
      .where(and(isNotNull(assignment.locationId), isNull(assignment.validTo), isNull(assignment.supersededAt)))
      // Pin an ORDER (CLAUDE.md §8): no asserted list off an unordered query.
      .orderBy(employment.employeeCode, employment.id);

    // How many OPEN assignment rows each of those employments has — `holidayDatesFor` takes one via
    // `.limit(1)`, so more than one means before/after is not a stable pair.
    const empIds = [...new Set(rows.map((r) => r.employmentId))];
    const openRows = empIds.length
      ? await tx
          .select({ employmentId: assignment.employmentId, n: sql<number>`count(*)::int` })
          .from(assignment)
          .where(and(inArray(assignment.employmentId, empIds), isNull(assignment.validTo), isNull(assignment.supersededAt)))
          .groupBy(assignment.employmentId)
      : [];
    const openCount = new Map(openRows.map((o) => [o.employmentId, o.n]));

    const lines: string[] = [
      `0fe1ca2e — public holidays BEFORE vs AFTER removing the per-company site register`,
      `calendar year ${year} (${startDate} … ${endDate})   ·   generated ${new Date().toISOString()}`,
      `READ-ONLY: every figure below comes from core/holidays.ts holidayDatesFor, inside a`,
      `SET TRANSACTION READ ONLY transaction. Nothing was written.`,
      ``,
      `AFTER = this employment's calendar once work_state carries the site's state and the site is gone.`,
      ``,
      `SITE REGISTER AS IT STANDS`,
      `  location rows                : ${siteCounts?.total ?? 0}  (live ${siteCounts?.live ?? 0})`,
      `  …carrying a state override   : ${siteCounts?.withState ?? 0}`,
      `  …mapped to a named calendar  : ${siteCounts?.withCalendar ?? 0}`,
      `  open assignments using one   : ${openUse?.n ?? 0}`,
      ``,
      `-`.repeat(100),
    ];

    let unchanged = 0;
    let moved = 0;
    const flagged = { blocked: 0, calendar: 0, noState: 0, ambiguous: 0, archived: 0, empty: 0 };

    for (const r of rows) {
      // The state the plan would carry onto the employee. Null location state ⇒ nothing to carry, and
      // work_state is left exactly as it is.
      const workStateAfter = r.locationState ?? r.workState;

      const before = await holidayDatesFor(tx, { employmentId: r.employmentId, startDate, endDate });
      const after = await holidayDatesFor(tx, {
        employmentId: r.employmentId,
        startDate,
        endDate,
        whatIf: { dropLocation: true, workState: workStateAfter },
      });

      const lost = [...before].filter((d) => !after.has(d)).sort();
      const gained = [...after].filter((d) => !before.has(d)).sort();

      // Name every date in either set, for this company's country. A date can carry several rows
      // (national + state); all their names are shown, so "Federal Territory Day" is readable as such.
      const all = [...new Set([...before, ...after])];
      const nameRows = all.length
        ? await tx
            .select({ d: holiday.holidayDate, n: holiday.name })
            .from(holiday)
            .where(and(eq(holiday.country, r.country), gte(holiday.holidayDate, startDate), lte(holiday.holidayDate, endDate), inArray(holiday.holidayDate, all)))
            .orderBy(holiday.holidayDate, holiday.name)
        : [];
      const names = new Map<string, string>();
      for (const h of nameRows) {
        const prev = names.get(h.d);
        names.set(h.d, prev && prev !== h.n ? `${prev} / ${h.n}` : h.n);
      }

      const flags: string[] = [];
      if (r.empHolidayGroupId) {
        flags.push(`BLOCKED: carries holiday group "${r.empHolidayGroupName ?? r.empHolidayGroupId}" — work_state and holiday_group_id are mutually exclusive (employment_holiday_assignment_xor), so the site's state cannot be moved onto this employee without taking the group away`);
        flagged.blocked += 1;
      }
      if (r.locationCalendarId) {
        flags.push(`CALENDAR: the site maps to a named holiday calendar — a work_state cannot carry a calendar, so this one does NOT survive the removal`);
        flagged.calendar += 1;
      }
      if (!r.locationState) {
        flags.push(`NO STATE: the site supplies no state override — nothing to carry over`);
        flagged.noState += 1;
      }
      if ((openCount.get(r.employmentId) ?? 1) > 1) {
        flags.push(`AMBIGUOUS: ${openCount.get(r.employmentId)} open assignment rows — holidayDatesFor takes an arbitrary one via .limit(1), so this pair of answers is not stable`);
        flagged.ambiguous += 1;
      }
      if (r.locationArchivedAt) {
        flags.push(`ARCHIVED SITE: the open assignment points at an archived location (still resolved by the engine)`);
        flagged.archived += 1;
      }
      // ⚠ THE ONE WAY THIS REPORT CAN LIE. Both sets empty reads as "NOTHING MOVES", and it is not
      // evidence of anything: it means no holiday row resolves for this employment in this year at all —
      // an unloaded gazette, the wrong year, or a country with no rows. Said out loud rather than counted
      // as a reassurance, because a before/after taken on an empty calendar is the shape of a report that
      // blesses a change it never tested.
      if (before.size === 0 && after.size === 0) {
        flags.push(`EMPTY GAZETTE: no holiday of any kind resolves for this employment in ${year} — "nothing moves" here is missing data, NOT evidence. Load the gazette (or pass the right year) and run again.`);
        flagged.empty += 1;
      }

      const changed = lost.length > 0 || gained.length > 0;
      if (changed) moved += 1;
      else unchanged += 1;

      lines.push(
        ``,
        `EMPLOYEE   ${r.code ?? '—'}  ${r.name}${r.terminatedOn ? `  (terminated ${r.terminatedOn})` : ''}`,
        `COMPANY    ${r.companyName}  ·  country ${r.country}  ·  company default state ${r.companyDefaultState ?? '(none — national only)'}`,
        `SITE       ${r.locationCode} — ${r.locationName}  ·  state ${r.locationState ?? '(none)'}`,
        `WORK STATE before ${r.workState ?? '(none)'}   →   after ${workStateAfter ?? '(none)'}`,
        `VERDICT    ${changed ? `MOVES — ${lost.length} lost, ${gained.length} gained` : 'NOTHING MOVES'}`,
      );
      for (const f of flags) lines.push(`⚠ ${f}`);
      lines.push(
        ``,
        `  BEFORE (${before.size} days)`,
        ...render(before, names).map((l) => `    ${l}`),
        `  AFTER  (${after.size} days)`,
        ...render(after, names).map((l) => `    ${l}`),
      );
      if (lost.length) lines.push(`  LOST   ${lost.map((d) => `${d} ${names.get(d) ?? ''}`.trim()).join(' | ')}`);
      if (gained.length) lines.push(`  GAINED ${gained.map((d) => `${d} ${names.get(d) ?? ''}`.trim()).join(' | ')}`);
      lines.push(`-`.repeat(100));
    }

    if (rows.length === 0) {
      lines.push(``, `No open assignment carries a location. Removing the site register moves nobody's holidays.`);
    }

    lines.push(
      ``,
      `employees affected: ${rows.length}   nothing moves: ${unchanged}   MOVES: ${moved}`,
      `blocked-by-group: ${flagged.blocked}   site-has-calendar: ${flagged.calendar}   site-has-no-state: ${flagged.noState}   ambiguous-open-assignment: ${flagged.ambiguous}   archived-site: ${flagged.archived}   empty-gazette: ${flagged.empty}`,
    );
    writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

    return { siteCounts, openUse, rows: rows.length, unchanged, moved, flagged };
  });

  // Console gets COUNTS ONLY — the list names individuals and belongs in the file, not in a terminal.
  console.log(`location → holiday preview for ${year}`);
  console.log(`  location rows              : ${report.siteCounts?.total ?? 0}  (live ${report.siteCounts?.live ?? 0})`);
  console.log(`  …with a state override     : ${report.siteCounts?.withState ?? 0}`);
  console.log(`  …mapped to a named calendar: ${report.siteCounts?.withCalendar ?? 0}${(report.siteCounts?.withCalendar ?? 0) > 0 ? '   <-- a calendar cannot be carried by work_state' : ''}`);
  console.log(`  open assignments using one : ${report.openUse?.n ?? 0}`);
  console.log(`  employees affected         : ${report.rows}`);
  console.log(`  NOTHING MOVES              : ${report.unchanged}`);
  console.log(`  holidays MOVE              : ${report.moved}${report.moved ? '   <-- these are the people to show the reporter' : ''}`);
  console.log(`  blocked by a holiday group : ${report.flagged.blocked}${report.flagged.blocked ? '   <-- the work-state step is impossible for these' : ''}`);
  console.log(`  site has a named calendar  : ${report.flagged.calendar}`);
  console.log(`  site has no state override : ${report.flagged.noState}`);
  console.log(`  ambiguous open assignment  : ${report.flagged.ambiguous}`);
  console.log(`  archived site still in use : ${report.flagged.archived}`);
  console.log(`  EMPTY calendar both sides  : ${report.flagged.empty}${report.flagged.empty ? '   <-- NOT evidence: no holiday resolves at all for these, so before==after proves nothing' : ''}`);
  console.log(`  per-employee list          : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
