/**
 * 07ebd04d — WHO IS AFFECTED BY SPLITTING THE "Standard" SCHEDULE GROUP, before anything is moved.
 *
 * THE REPORTER'S OWN SEQUENCE, and this script is steps 2 and 3 of it. Their answer to the blocking
 * question set seven conditions on the restructuring, in this order:
 *
 *   1. Do not modify the existing shifts automatically.
 *   2. Identify which existing employees are assigned to the affected groups/shifts.
 *   3. Show the proposed Schedule Group changes and affected employees.
 *   4. GET CONFIRMATION BEFORE MIGRATION.
 *   5. Move each Shift into the appropriate Schedule Group.
 *   6. Preserve historical assignment/roster records.
 *   7. Do not silently change an employee's working days.
 *
 * So this WRITES NOTHING. No insert, no update, no delete, no migration — the file contains none. It
 * produces the answer to (2) and (3) so that (4) can happen, and it exists because the reporter asked
 * for exactly this artefact rather than for a migration.
 *
 * ⚠️ THE QUESTION THEY ASKED BACK, ANSWERED FROM THE ENGINE RATHER THAN GUESSED. They wrote: "'Saturday
 * not at all' and 'Saturday Off Day' may produce different attendance/roster behaviour in your system.
 * If they are technically intended to mean the same working pattern, [they] can share one group."
 *
 * THEY ARE NOT THE SAME, AND THE DIFFERENCE IS MONEY. `shiftDayKindFor` (core/attendance.ts) is a
 * four-way classifier: a weekday in `weekly_pattern` is FULL, in `half_pattern` is HALF, in
 * `off_pattern` is OFF, and one in NONE of the three is REST — rest is the complement, which is what
 * "not ticked" has always meant. Both rest and off are non-working days, but they are not paid alike:
 *
 *   · REST day  → `policyBranch('rest_day')`  → overtime at 2.0x
 *   · OFF day   → `policyBranch('workday')` with scheduledMinutes 0 → overtime at 1.5x
 *
 * (core/attendance.ts, the `kind === 'off'` branch, and the rate fallback in core/attendance-derive.ts:
 * "workday → 1.5, rest_day → 2.0, holiday → 3.0".) So merging a Saturday-rest shift with a Saturday-off
 * shift into one group would change what somebody's Saturday overtime pays. The reporter's instinct to
 * keep them apart is correct, and this script prints the classification per shift so they can see it
 * rather than take our word for it.
 *
 * ⚠️ AND THE 1.5x IS TRUE ON ONE BRANCH ONLY, WHICH IS WHY THIS REPORT MEASURES IT RATHER THAN ASSERTING
 * IT. The off-day branch quoted above lives inside `scheduleFor`'s DEFAULT-SHIFT step — the step reached
 * only when the date has NO roster row. The rostered step above it is two-way, not four-way:
 *
 *     if (ra?.isRestDay) { … return { ...policyBranch('rest_day'), source: 'roster-rest' }; }
 *
 * and `roster_assignment.is_rest_day` is a BOOLEAN with nowhere to record "off rather than rest". Worse,
 * `generateRosterFromTemplate` (core/roster.ts) writes off days INTO that boolean:
 * `(isWorkingDayKind(kind) ? workingDates : restDates).push(iso)` — Rest and Off both land in
 * `restDates`. So the moment a roster row exists for an off-pattern weekday, that day is paid at
 * rest-day 2.0x, exactly like a rest day, and the distinction this whole item turns on is gone for that
 * date. The OFF-DAY ROSTER COLLISION section below counts those rows. If it is not zero, the split is
 * still right but the reporter must be told that off-day pay is already behaving as rest-day pay on the
 * dates listed, and that is a separate defect, not something this restructuring introduces.
 * test/schedule-group-week-pattern.test.ts pins both halves of that in the engine.
 *
 * THE RENDERING IS A PURE FUNCTION (`buildReport`) AND THE I/O IS NOT, deliberately. This output is a
 * document a human makes a decision from, so what it says is asserted in
 * test/schedule-group-split-report.test.ts against the shape production actually holds, rather than
 * being seen for the first time when it is pasted in front of the reporter.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-schedule-group-split.ts
 */
import { writeFileSync } from 'node:fs';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  attendanceRule,
  employment,
  employmentShiftArrangement,
  person,
  rosterAssignment,
  shift,
} from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
// ADR-0080 D9 — through the PACK FACADE, not core/attendance. The drift ratchet
// (test/attendance-pack-drift.test.ts) refuses a NEW file importing the attendance pack's
// implementation directly, and its allowlist only ever shrinks: adding an entry for this script is
// exactly what that file says not to do. Same discipline as scripts/report-a2c-hire-year-deltas.ts,
// which reaches the leave engine through packs/leave/service for the same reason.
import { isoWeekday, shiftDayKindFor, type ShiftDayKind } from '../packs/attendance/service';

/** A Monday-anchored week, so every weekday can be classified without inventing a calendar. */
const WEEK = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SATURDAY = 5; // index into WEEK / DAY_NAMES

export type PatternTriple = { weeklyPattern: number[] | null; halfPattern: number[] | null; offPattern: number[] | null };
export type ReportShift = PatternTriple & { id: string; code: string | null; name: string; ruleId: string | null };
export type ReportRule = { id: string; name: string; status: string; isDefault: boolean };
export type ReportAttachment = {
  employmentId: string;
  employeeCode: string | null;
  name: string;
  /** The employee's OWN Schedule Group (employment.attendance_rule_id) — a different column from the
   *  shift's. When the two disagree the group guard refuses the next assignment for that person. */
  groupId: string | null;
  terminatedOn: string | null;
  /** How the engine reaches this shift for this person. Both routes count. */
  via: 'arrangement' | 'default_shift_id';
  since: string | null;
};

/** The raw columns, printed so the reporter can check the derived week against what is stored. */
const fmt = (a: number[] | null) => (a == null ? 'NULL' : a.length === 0 ? '[]' : `[${[...a].sort((x, y) => x - y).join(',')}]`);
const columnsOf = (sh: PatternTriple) => `weekly ${fmt(sh.weeklyPattern)}  half ${fmt(sh.halfPattern)}  off ${fmt(sh.offPattern)}`;

/** The shift's week as the engine reads it — full / half / off / rest, per weekday. */
export const kindsOf = (sh: PatternTriple): ShiftDayKind[] =>
  WEEK.map((d) => shiftDayKindFor({ pattern: sh.weeklyPattern, halfPattern: sh.halfPattern, offPattern: sh.offPattern }, d));
const weekOf = (sh: PatternTriple) => kindsOf(sh).map((k, i) => `${DAY_NAMES[i]}=${k}`).join(' ');

/** The signature the split is BY: two shifts share a group only if the engine reads their week alike. */
const signatureOf = (sh: PatternTriple) => weekOf(sh);

/**
 * The group NAME the reporter asked for, and it is derived from the WHOLE week rather than from Saturday
 * alone. Their three names describe a Mon–Fri full week with Sunday rest and only Saturday varying; a
 * shift whose Monday or Sunday differs is NOT one of those three and must not be labelled as one, or the
 * name on screen would assert a working week the shift does not have. Anything else is reported UNNAMED,
 * which is a question for the reporter rather than a default this script may pick.
 */
export function proposedGroupName(sh: PatternTriple): string {
  const k = kindsOf(sh);
  const monToFriAllFull = k.slice(0, 5).every((v) => v === 'full');
  if (!monToFriAllFull || k[6] !== 'rest') return '(UNNAMED — this week is not one of the reporter’s three; they must name it)';
  if (k[SATURDAY] === 'rest') return 'Standard 5 Day';
  if (k[SATURDAY] === 'half') return 'Standard 5.5 Day';
  if (k[SATURDAY] === 'off') return 'Standard 5 Day + Saturday Off';
  return '(UNNAMED — Saturday is a full working day; they must name it)';
}

export type ReportInput = {
  /** Today in Kuala Lumpur — the line between "history, preserved" and "dates that still change". */
  today: string;
  generatedAt: string;
  rules: ReportRule[];
  shifts: ReportShift[];
  /** shiftId → everybody the engine would resolve onto that shift today. */
  attached: Map<string, ReportAttachment[]>;
  collisions: { past: number; future: number; rows: string[] };
};

export type ReportOutput = {
  lines: string[];
  console: string[];
  groupsNeedingSplit: number;
  affected: number;
  stranded: number;
  unnamed: number;
};

/** PURE. Everything this report says, given everything it read. No database, no clock, no filesystem. */
export function buildReport(input: ReportInput): ReportOutput {
  const { today, generatedAt, rules, shifts, attached, collisions } = input;
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));

  const lines: string[] = [
    '07ebd04d — splitting the Schedule Groups: what changes, and who is on each shift',
    `generated ${generatedAt}   ·   as of ${today} (Kuala Lumpur)`,
    'READ-ONLY — nothing was modified, no migration was written and none was run.',
    '',
    'THE WEEK IS SHOWN TWICE: the raw columns as stored, and the week as the ENGINE reads them.',
    '  full = a full working day · half = a half working day · off = a non-working OFF day',
    '  rest = a non-working REST day (a weekday in none of the three lists)',
    '',
    '⚠️ off AND rest ARE NOT THE SAME, AND THE DIFFERENCE IS PAID:',
    '  a REST day pays overtime at 2.0x; an OFF day is treated as a workday with no scheduled hours and',
    '  pays overtime at 1.5x. Two shifts whose Saturdays differ that way must NOT share one Schedule',
    '  Group, or somebody’s Saturday overtime rate changes without anyone deciding it.',
    '',
    'EACH EMPLOYEE IS LISTED WITH:',
    '  via   — how they are attached: an open dated shift arrangement, or the profile default shift the',
    '          engine falls back to when there is no arrangement row at all. Both count.',
    '  group — the Schedule Group the EMPLOYEE is in today (employment.attendance_rule_id), which is a',
    '          different column from the group the SHIFT is in. When the shift moves to a new group and',
    '          the employee stays in the old one, core/roster.ts assertShiftsAllowedForEmploymentsTx will',
    '          REFUSE the next assignment for that person. Those rows are marked STRANDED.',
    '',
  ];

  let affected = 0;
  let stranded = 0;
  let groupsNeedingSplit = 0;
  let unnamed = 0;

  for (const r of rules) {
    const mine = shifts.filter((s) => s.ruleId === r.id);
    const label = `GROUP "${r.name}"${r.isDefault ? ' (the tenant default)' : ''}${r.status === 'active' ? '' : ` [${r.status}]`}`;
    if (mine.length === 0) {
      lines.push(`${label} — no shifts. ⚠️ An EMPTY group refuses every shift assignment (8cd601d0).`, '');
      continue;
    }
    const bySig = new Map<string, ReportShift[]>();
    for (const s of mine) bySig.set(signatureOf(s), [...(bySig.get(signatureOf(s)) ?? []), s]);
    if (bySig.size > 1) groupsNeedingSplit += 1;

    lines.push(
      `${label} — ${mine.length} shift(s), ${bySig.size} distinct working week(s)` +
        (bySig.size > 1 ? `  ⇒ SPLIT INTO ${bySig.size}` : '  ⇒ no split needed'),
    );
    let n = 0;
    for (const [sig, group] of bySig) {
      n += 1;
      const satKind = kindsOf(group[0])[SATURDAY];
      const rate = satKind === 'off' ? '  (overtime 1.5x)' : satKind === 'rest' ? '  (overtime 2.0x)' : '';
      if (bySig.size === 1) {
        // A group whose shifts already agree is NOT being renamed, and proposing a name for it would read
        // as a change the reporter has to approve. The plan says A02 is consistent with itself and is left
        // alone; the report must say the same thing.
        lines.push(`  ── one working week — the group is consistent and keeps its name`);
      } else {
        const name = proposedGroupName(group[0]);
        if (name.startsWith('(UNNAMED')) unnamed += 1;
        lines.push(`  ── proposed group ${n} of ${bySig.size}: ${name}`);
      }
      lines.push(`       Saturday resolves to: ${satKind}${rate}`);
      lines.push(`       week as the engine reads it: ${sig}`);
      for (const s of group) {
        const people = attached.get(s.id) ?? [];
        affected += people.length;
        lines.push(`      shift ${s.code ?? '—'} (${s.name})`);
        lines.push(`          columns as stored: ${columnsOf(s)}`);
        lines.push(`          ${people.length} employee(s) attached`);
        for (const p of people) {
          const employeeGroup = p.groupId == null ? 'none' : (ruleName.get(p.groupId) ?? p.groupId);
          // The shift is LEAVING group r for the proposed group above. An employee whose own group is r
          // must be moved WITH it; one already in a different group is stranded today and stays stranded.
          const strandedHere = p.groupId != null && p.groupId !== r.id;
          if (strandedHere) stranded += 1;
          lines.push(
            `          ${p.employeeCode ?? '—'} | ${p.name} | via ${p.via}` +
              `${p.since ? ` since ${p.since}` : ''}` +
              `${p.terminatedOn ? ` | TERMINATED ${p.terminatedOn}` : ''}` +
              ` | group: ${employeeGroup}` +
              (strandedHere
                ? '  ⚠️ STRANDED — this employee is already in a different group from the shift'
                : p.groupId === r.id
                  ? '  → the same migration must move this employee into the proposed group'
                  : '  (in no group — the group guard does not apply to them)'),
          );
        }
        if (people.length === 0) lines.push('          (nobody is attached to this shift today)');
      }
    }
    lines.push('');
  }

  const orphans = shifts.filter((s) => s.ruleId == null);
  if (orphans.length) {
    lines.push('SHIFTS IN NO SCHEDULE GROUP:');
    for (const s of orphans) {
      const people = attached.get(s.id) ?? [];
      affected += people.length;
      lines.push(`    ${s.code ?? '—'} (${s.name}) — ${columnsOf(s)}`);
      lines.push(`        ${weekOf(s)} — ${people.length} employee(s)`);
      for (const p of people) {
        lines.push(
          `          ${p.employeeCode ?? '—'} | ${p.name} | via ${p.via} | group: ${p.groupId == null ? 'none' : (ruleName.get(p.groupId) ?? p.groupId)}`,
        );
      }
    }
    lines.push('');
  }

  lines.push(
    'OFF-DAY ROSTER COLLISION — dates where an OFF day is already being paid as a REST day.',
    '  core/attendance.ts resolves a rostered rest row as rest_day (2.0x) with no off-day branch, and',
    '  core/roster.ts generateRosterFromTemplate writes OFF days into exactly that boolean. So on these',
    '  dates the 1.5x above is NOT what is being paid today. This is a pre-existing defect that the split',
    '  neither causes nor fixes; it is listed so nobody is told a rate that is not in force.',
    `  rows in the PAST (history — preserved, not migrated): ${collisions.past}`,
    `  rows on ${today} OR LATER (these dates still change): ${collisions.future}`,
    ...(collisions.rows.length
      ? ['  first 200 rows:', ...collisions.rows]
      : ['  (no rows — every off-pattern weekday is unrostered, so the 1.5x branch is the one in force)']),
    '',
    `groups needing a split: ${groupsNeedingSplit}   ·   shifts: ${shifts.length}   ·   employees attached: ${affected}`,
    `employees already in a group that differs from their shift's group (STRANDED): ${stranded}`,
    `proposed groups the reporter still has to NAME: ${unnamed}`,
    '',
    'NOTHING HAS BEEN MOVED. This is the list the restructuring needs confirmed before it runs.',
  );

  const console_ = [
    '07ebd04d — schedule group split preview',
    `  as of (Kuala Lumpur)        : ${today}`,
    `  schedule groups             : ${rules.length}`,
    `  active shifts               : ${shifts.length}`,
    `  groups needing a split      : ${groupsNeedingSplit}`,
    `  employees attached          : ${affected}`,
    `  ... STRANDED by the split   : ${stranded}${stranded ? '   <-- the migration must move these people too' : ''}`,
    `  proposed groups to NAME     : ${unnamed}${unnamed ? '   <-- the reporter has to name these' : ''}`,
    `  off-day rows already paid as rest — past ${collisions.past}, ${today} or later ${collisions.future}`,
  ];

  return { lines, console: console_, groupsNeedingSplit, affected, stranded, unnamed };
}

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role).');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const db = owner.db;

  // The filename is a date taken from the CLOCK, so it goes through the tenant timezone. `new
  // Date().toISOString().slice(0, 10)` is a UTC date and names YESTERDAY between 00:00 and 08:00 MYT,
  // which would quietly overwrite the previous day's report when the owner runs this early. `scripts/`
  // is outside test/today-in-myt-drift.test.ts's scanned directories, so nothing but this stops it
  // coming back.
  const today = todayInKualaLumpur();
  const OUT = `/var/tmp/schedule-group-split-${today}.txt`;

  // ORDER BY on every read (CLAUDE.md §8): this output is put in front of the reporter, and an unordered
  // query makes the same unchanged database print a differently-ordered report on two consecutive runs,
  // which reads as a change.
  const rules = await db
    .select({ id: attendanceRule.id, name: attendanceRule.name, status: attendanceRule.status, isDefault: attendanceRule.isDefault })
    .from(attendanceRule)
    .orderBy(asc(attendanceRule.name), asc(attendanceRule.id));
  const shifts = await db
    .select({
      id: shift.id,
      code: shift.code,
      name: shift.name,
      ruleId: shift.ruleId,
      weeklyPattern: shift.weeklyPattern,
      halfPattern: shift.halfPattern,
      offPattern: shift.offPattern,
    })
    .from(shift)
    .where(isNull(shift.archivedAt))
    .orderBy(asc(shift.code), asc(shift.name), asc(shift.id));

  // ── WHO IS ON EACH SHIFT ──────────────────────────────────────────────────────────────────────────
  //
  // THREE ATTACHMENTS, NOT ONE, because core/attendance.ts scheduleFor consults three things in order and
  // an employee missed by the report is an employee whose Saturday moves without anyone seeing it:
  //
  //   1. the OPEN shift arrangement (employment_shift_arrangement, supersededAt NULL / validTo NULL) —
  //      the dated ladder, and the normal answer;
  //   2. employment.default_shift_id — the fallback scheduleFor uses when the employment has NO live
  //      arrangement rows at all. An employee here IS on that shift for attendance and was invisible to
  //      the first version of this report;
  //   3. dated roster_assignment rows. History is PRESERVED rather than migrated (condition 6), so past
  //      rows are counted and left alone; FUTURE rows are counted separately because those are the dates
  //      whose meaning the restructuring could still change. They appear in the collision section below.
  const arrangements = await db
    .select({
      employmentId: employmentShiftArrangement.employmentId,
      shiftId: employmentShiftArrangement.shiftId,
      validFrom: employmentShiftArrangement.validFrom,
      employeeCode: employment.employeeCode,
      name: person.fullName,
      groupId: employment.attendanceRuleId,
      terminatedOn: employment.terminatedOn,
    })
    .from(employmentShiftArrangement)
    .innerJoin(employment, eq(employment.id, employmentShiftArrangement.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .where(and(isNull(employmentShiftArrangement.supersededAt), isNull(employmentShiftArrangement.validTo)))
    .orderBy(asc(employment.employeeCode), asc(person.fullName), asc(employmentShiftArrangement.employmentId));

  const withLiveArrangement = new Set(
    (
      await db
        .select({ employmentId: employmentShiftArrangement.employmentId })
        .from(employmentShiftArrangement)
        .where(isNull(employmentShiftArrangement.supersededAt))
        .orderBy(asc(employmentShiftArrangement.employmentId))
    ).map((r) => r.employmentId),
  );

  const defaults = await db
    .select({
      employmentId: employment.id,
      shiftId: employment.defaultShiftId,
      employeeCode: employment.employeeCode,
      name: person.fullName,
      groupId: employment.attendanceRuleId,
      terminatedOn: employment.terminatedOn,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId))
    .orderBy(asc(employment.employeeCode), asc(person.fullName), asc(employment.id));

  const attached = new Map<string, ReportAttachment[]>();
  const push = (shiftId: string, a: ReportAttachment) => attached.set(shiftId, [...(attached.get(shiftId) ?? []), a]);
  for (const a of arrangements) {
    if (!a.shiftId) continue;
    const { shiftId, validFrom, ...rest } = a;
    push(shiftId, { ...rest, via: 'arrangement', since: validFrom });
  }
  for (const d of defaults) {
    // Only where the engine would actually reach this branch: a live arrangement row wins over the cache.
    if (!d.shiftId || withLiveArrangement.has(d.employmentId)) continue;
    const { shiftId, ...rest } = d;
    push(shiftId, { ...rest, via: 'default_shift_id', since: null });
  }

  // ── THE OFF-DAY ROSTER COLLISION (see the header) ─────────────────────────────────────────────────
  const shiftById = new Map(shifts.map((s) => [s.id, s]));
  const offPatternOf = new Map<string, number[]>();
  for (const [shiftId, people] of attached) {
    const off = shiftById.get(shiftId)?.offPattern ?? [];
    if (off.length === 0) continue;
    for (const p of people) offPatternOf.set(p.employmentId, off);
  }
  const employmentIds = [...offPatternOf.keys()].sort();
  const restRows = employmentIds.length
    ? await db
        .select({ employmentId: rosterAssignment.employmentId, shiftDate: rosterAssignment.shiftDate })
        .from(rosterAssignment)
        .where(and(eq(rosterAssignment.isRestDay, true), inArray(rosterAssignment.employmentId, employmentIds)))
        .orderBy(asc(rosterAssignment.employmentId), asc(rosterAssignment.shiftDate))
    : [];
  const collisions = { past: 0, future: 0, rows: [] as string[] };
  for (const r of restRows) {
    const off = offPatternOf.get(r.employmentId);
    if (!off || !off.includes(isoWeekday(r.shiftDate))) continue;
    if (r.shiftDate >= today) collisions.future += 1;
    else collisions.past += 1;
    if (collisions.rows.length < 200) {
      collisions.rows.push(`    ${r.employmentId} | ${r.shiftDate} | rostered REST on an OFF-pattern weekday`);
    }
  }

  const out = buildReport({ today, generatedAt: new Date().toISOString(), rules, shifts, attached, collisions });
  writeFileSync(OUT, out.lines.join('\n') + '\n', 'utf8');
  // The console gets COUNTS ONLY — the list names individuals and belongs in the file, not a terminal.
  for (const l of out.console) console.log(l);
  console.log(`  full list (names inside)    : ${OUT}`);
  await owner.client.end();
}

// Only when RUN, never when imported: test/schedule-group-split-report.test.ts imports `buildReport` to
// assert what this prints, and a module-scope `main()` would try to open a production connection to do it.
if (process.argv[1]?.endsWith('report-schedule-group-split.ts')) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
