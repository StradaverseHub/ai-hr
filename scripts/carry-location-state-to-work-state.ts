/**
 * 0fe1ca2e — STEP TWO of removing the per-company site register, and it must run BEFORE step three.
 *
 * THE ORDER IS THE WHOLE POINT. `location.state` is the TOP rung of the holiday-state precedence
 * (core/holidays.ts: location.state → holiday group → employment.work_state → company.default_work_state
 * → national). Two production employees take Kuala Lumpur from a site while their company defaults to
 * Selangor, so dropping the site input without first moving that state onto the employee takes Federal
 * Territory Day off two named people — a one-way loss on a figure that fixes the attendance day-type (OT
 * class = money) and the working-day leave count. This script moves the state DOWN one rung, from the
 * site to the employee, while the site is still there. Today that changes nobody's calendar, because the
 * site still outranks it; it is what makes step three change nobody's calendar either.
 *
 * READ scripts/report-location-holiday-deltas.ts FIRST, and put its output in front of the reporter. This
 * script is the apply half of the same question and deliberately re-proves it per employee rather than
 * trusting that the report was run.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`. The dry run performs every read, every skip
 * decision and every before/after resolution, and writes the same file — so the apply run has nothing
 * left to decide.
 *
 * IT WRITES THROUGH THE SERVICE THAT DECIDES THE ROW, never with a raw UPDATE.
 * `setEmploymentHolidayCalendar` (core/org.ts) owns the work_state ⊕ holiday_group_id rule that
 * `employment_holiday_assignment_xor` is only the backstop for, and appends
 * `employment.holiday-calendar.changed` so the change is attributable. A raw UPDATE here would be a
 * second writer of that rule and would leave no event.
 *
 * WHAT IT REFUSES TO DO, rather than forcing:
 *   · an employment that already carries a holiday GROUP is SKIPPED, loudly. work_state and
 *     holiday_group_id are mutually exclusive, so "carrying the state over" would mean taking the group
 *     away — a different decision, belonging to a human, not to a data script.
 *   · a site mapped to a named CALENDAR is SKIPPED, loudly. A work_state cannot carry a calendar, so
 *     nothing this script writes would preserve that employee's days. Step three must not proceed for
 *     them on this script's say-so.
 *   · an employment with more than one OPEN assignment is SKIPPED: `holidayDatesFor` takes an arbitrary
 *     one via `.limit(1)`, so which site it is carrying is not a defined question.
 *   · a site with no state has nothing to carry, and is counted rather than touched.
 *
 * AND IT VERIFIES, per employee, before and after the write:
 *   · the calendar TODAY must be unchanged by the write (the site still outranks work_state, so a
 *     difference means the precedence is not what this script believes);
 *   · the calendar AFTER the site is gone (previewed through the real resolver — see HolidayWhatIf in
 *     core/holidays.ts, no writes) must equal the calendar today. That equality IS the promise made to
 *     the reporter, checked on the row rather than argued.
 * A failure of either check is reported per employee and makes the run exit non-zero. Earlier employees'
 * writes are NOT rolled back — each is its own transaction — which is why the dry run exists.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/carry-location-state-to-work-state.ts [YYYY] [--apply]
 */
import { writeFileSync } from 'node:fs';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { createDb, withTenant } from '../db/client';
import { holidayDatesFor } from '../core/holidays';
import { setEmploymentHolidayCalendar } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { assignment, company, employment, holidayGroup, location, person } from '../db/schema';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const year = args.find((a) => /^\d{4}$/.test(a)) ?? todayInKualaLumpur().slice(0, 4);
const startDate = `${year}-01-01`;
const endDate = `${year}-12-31`;
const OUT = `/var/tmp/carry-location-state-${year}${apply ? '-applied' : '-dryrun'}.txt`;

const sorted = (s: Set<string>) => [...s].sort();
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((d) => b.has(d));

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this script requires MIGRATION_DATABASE_URL (the owner role) to read across tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  // The population, read as the owner so no tenant is invisible. Same open-assignment predicate as the
  // resolver's own (valid_to IS NULL AND superseded_at IS NULL), and ordered so the list is stable.
  const rows = await owner.db
    .select({
      employmentId: employment.id,
      tenantId: employment.tenantId,
      code: employment.employeeCode,
      name: person.fullName,
      terminatedOn: employment.terminatedOn,
      workState: employment.workState,
      empHolidayGroupId: employment.holidayGroupId,
      empHolidayGroupName: holidayGroup.name,
      companyDefaultState: company.defaultWorkState,
      locationCode: location.code,
      locationName: location.name,
      locationState: location.state,
      locationCalendarId: location.holidayGroupId,
      openCount: sql<number>`(
        select count(*)::int from assignment a
        where a.employment_id = ${employment.id} and a.valid_to is null and a.superseded_at is null
      )`,
    })
    .from(assignment)
    .innerJoin(employment, eq(employment.id, assignment.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .innerJoin(company, eq(company.id, employment.companyId))
    .innerJoin(location, eq(location.id, assignment.locationId))
    .leftJoin(holidayGroup, eq(holidayGroup.id, employment.holidayGroupId))
    .where(and(isNotNull(assignment.locationId), isNull(assignment.validTo), isNull(assignment.supersededAt)))
    .orderBy(employment.employeeCode, employment.id);

  const lines: string[] = [
    `0fe1ca2e — carrying the site's state onto employment.work_state`,
    `${apply ? 'APPLY' : 'DRY RUN — nothing was written'}   ·   calendar year ${year}   ·   ${new Date().toISOString()}`,
    ``,
  ];
  let wrote = 0;
  let already = 0;
  let noState = 0;
  let skippedGroup = 0;
  let skippedCalendar = 0;
  let skippedAmbiguous = 0;
  let failed = 0;

  for (const r of rows) {
    const head = `${r.code ?? '—'}  ${r.name}${r.terminatedOn ? `  (terminated ${r.terminatedOn})` : ''}  ·  site ${r.locationCode} — ${r.locationName} (state ${r.locationState ?? 'none'})  ·  company default ${r.companyDefaultState ?? 'none'}`;

    if (r.empHolidayGroupId) {
      skippedGroup += 1;
      lines.push(`SKIP (holiday group)  ${head}`, `    carries holiday group "${r.empHolidayGroupName ?? r.empHolidayGroupId}"; work_state and holiday_group_id are mutually exclusive, so carrying the site's state over would take the group away. A human decides that, not this script.`, ``);
      continue;
    }
    if (r.locationCalendarId) {
      skippedCalendar += 1;
      lines.push(`SKIP (named calendar) ${head}`, `    the site maps to a named holiday calendar; a work_state cannot carry one, so nothing written here would preserve this employee's days.`, ``);
      continue;
    }
    if (r.openCount > 1) {
      skippedAmbiguous += 1;
      lines.push(`SKIP (ambiguous)      ${head}`, `    ${r.openCount} open assignment rows; holidayDatesFor takes an arbitrary one via .limit(1), so which site is being carried is undefined.`, ``);
      continue;
    }
    if (!r.locationState) {
      noState += 1;
      lines.push(`NOTHING TO CARRY      ${head}`, ``);
      continue;
    }
    if (r.workState === r.locationState) {
      already += 1;
      lines.push(`ALREADY SET           ${head}`, ``);
      continue;
    }

    const ctx = { tenantId: r.tenantId, roles: ['hr_admin'], entitlementsExempt: 'sweeps' as const };
    const window = { employmentId: r.employmentId, startDate, endDate };
    const before = await withTenant(ctx, (tx) => holidayDatesFor(tx, window));

    if (apply) {
      await setEmploymentHolidayCalendar(ctx, {
        employmentId: r.employmentId,
        selection: { kind: 'state', state: r.locationState },
      });
      wrote += 1;
    }

    // Today's calendar must be UNCHANGED by the write (the site still outranks work_state)…
    const afterWrite = apply ? await withTenant(ctx, (tx) => holidayDatesFor(tx, window)) : before;
    // …and the calendar once the site is gone must equal it. Previewed through the real resolver; no write.
    const afterRemoval = await withTenant(ctx, (tx) =>
      holidayDatesFor(tx, { ...window, whatIf: { dropLocation: true, workState: r.locationState } }),
    );

    // In a dry run there IS no write, so this check has NOT been performed — say so rather than print a
    // reassuring "UNCHANGED" that nothing tested. Same rule the report applies to an empty gazette.
    const okToday = same(before, afterWrite);
    const okAfter = same(before, afterRemoval);
    if ((apply && !okToday) || !okAfter) failed += 1;

    lines.push(
      `${apply ? 'SET' : 'WOULD SET'} work_state ${r.workState ?? '(none)'} → ${r.locationState}   ${head}`,
      `    calendar today            : ${before.size} days  ${sorted(before).join(' ')}`,
      `    …after this write         : ${!apply ? 'not tested — a dry run writes nothing' : okToday ? 'UNCHANGED' : `CHANGED — ${sorted(afterWrite).join(' ')}   <-- the site no longer outranks work_state; STOP`}`,
      `    …once the site is removed : ${okAfter ? 'UNCHANGED' : `CHANGED — ${sorted(afterRemoval).join(' ')}   <-- removing the site WOULD move this calendar; STOP`}`,
      ``,
    );
  }

  if (rows.length === 0) lines.push(`No open assignment carries a location. Nothing to carry.`);
  lines.push(
    ``,
    `${apply ? 'written' : 'would write'}: ${apply ? wrote : rows.length - already - noState - skippedGroup - skippedCalendar - skippedAmbiguous}   already set: ${already}   nothing to carry: ${noState}`,
    `skipped — holiday group: ${skippedGroup}   named calendar: ${skippedCalendar}   ambiguous: ${skippedAmbiguous}   VERIFICATION FAILURES: ${failed}`,
  );
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  console.log(`carry location state → work_state (${apply ? 'APPLY' : 'DRY RUN'}) for ${year}`);
  console.log(`  employees on a site        : ${rows.length}`);
  console.log(`  ${apply ? 'written                   ' : 'would write               '}: ${apply ? wrote : rows.length - already - noState - skippedGroup - skippedCalendar - skippedAmbiguous}`);
  console.log(`  already set                : ${already}`);
  console.log(`  nothing to carry (no state): ${noState}`);
  console.log(`  skipped — holiday group    : ${skippedGroup}${skippedGroup ? '   <-- a human decides these' : ''}`);
  console.log(`  skipped — named calendar   : ${skippedCalendar}${skippedCalendar ? '   <-- the site register cannot be removed for these yet' : ''}`);
  console.log(`  skipped — ambiguous        : ${skippedAmbiguous}`);
  console.log(`  VERIFICATION FAILURES      : ${failed}${failed ? '   <-- do NOT proceed to the removal' : ''}`);
  console.log(`  per-employee list          : ${OUT}`);
  await owner.client.end();
  if (failed > 0) process.exit(3);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
