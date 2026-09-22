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
 * (core/attendance.ts ~980, and the rate fallback in core/attendance-derive.ts: "workday → 1.5,
 * rest_day → 2.0, holiday → 3.0".) So merging a Saturday-rest shift with a Saturday-off shift into one
 * group would change what somebody's Saturday overtime pays. The reporter's instinct to keep them apart
 * is correct, and this script prints the classification per shift so they can see it rather than take
 * our word for it.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-schedule-group-split.ts
 */
import { writeFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { attendanceRule, employment, employmentShiftArrangement, person, shift } from '../db/schema';
// ADR-0080 D9 — through the PACK FACADE, not core/attendance. The drift ratchet
// (test/attendance-pack-drift.test.ts) refuses a NEW file importing the attendance pack's
// implementation directly, and its allowlist only ever shrinks: adding an entry for this script is
// exactly what that file says not to do. Same discipline as scripts/report-a2c-hire-year-deltas.ts,
// which reaches the leave engine through packs/leave/service for the same reason.
import { shiftDayKindFor } from '../packs/attendance/service';

const OUT = `/var/tmp/schedule-group-split-${new Date().toISOString().slice(0, 10)}.txt`;

/** A Monday-anchored week, so every weekday can be classified without inventing a calendar. */
const WEEK = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The shift's week as the engine reads it — full / half / off / rest, per weekday. */
const weekOf = (sh: { weeklyPattern: number[] | null; halfPattern: number[] | null; offPattern: number[] | null }) =>
  WEEK.map((d, i) => {
    const kind = shiftDayKindFor(
      { pattern: sh.weeklyPattern, halfPattern: sh.halfPattern, offPattern: sh.offPattern },
      d,
    );
    return `${DAY_NAMES[i]}=${kind}`;
  }).join(' ');

/** The signature the split is BY: two shifts share a group only if the engine reads their week alike. */
const signatureOf = (sh: { weeklyPattern: number[] | null; halfPattern: number[] | null; offPattern: number[] | null }) =>
  weekOf(sh);

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role).');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const db = owner.db;

  const rules = await db.select({ id: attendanceRule.id, name: attendanceRule.name }).from(attendanceRule);
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
    .where(isNull(shift.archivedAt));

  // WHO IS ON EACH SHIFT — the OPEN arrangement only (not superseded, not ended). A historical row is
  // deliberately not counted: condition 6 is that history is preserved, not migrated.
  const arrangements = await db
    .select({
      shiftId: employmentShiftArrangement.shiftId,
      employeeCode: employment.employeeCode,
      name: person.fullName,
      validFrom: employmentShiftArrangement.validFrom,
    })
    .from(employmentShiftArrangement)
    .innerJoin(employment, eq(employment.id, employmentShiftArrangement.employmentId))
    .innerJoin(person, eq(person.id, employment.personId))
    .where(and(isNull(employmentShiftArrangement.supersededAt), isNull(employmentShiftArrangement.validTo)));

  const byShift = new Map<string, { employeeCode: string | null; name: string; validFrom: string }[]>();
  for (const a of arrangements) {
    if (!a.shiftId) continue;
    const list = byShift.get(a.shiftId) ?? [];
    list.push({ employeeCode: a.employeeCode, name: a.name, validFrom: a.validFrom });
    byShift.set(a.shiftId, list);
  }

  const lines: string[] = [
    '07ebd04d — splitting the Schedule Groups: what changes, and who is on each shift',
    `generated ${new Date().toISOString()}   ·   READ-ONLY (nothing modified, no migration written)`,
    '',
    'THE WEEK IS SHOWN AS THE ENGINE READS IT, not as the columns store it:',
    '  full = a full working day · half = a half working day · off = a non-working OFF day',
    '  rest = a non-working REST day (a weekday in none of the three lists)',
    '',
    '⚠️ off AND rest ARE NOT THE SAME, AND THE DIFFERENCE IS PAID:',
    '  a REST day pays overtime at 2.0x; an OFF day is treated as a workday with no scheduled hours and',
    '  pays overtime at 1.5x. Two shifts whose Saturdays differ that way must NOT share one Schedule',
    '  Group, or somebody’s Saturday overtime rate changes without anyone deciding it.',
    '',
  ];

  let affected = 0;
  let groupsNeedingSplit = 0;

  for (const r of rules) {
    const mine = shifts.filter((s) => s.ruleId === r.id);
    if (mine.length === 0) {
      lines.push(`GROUP "${r.name}" — no shifts.`, '');
      continue;
    }
    const bySig = new Map<string, typeof mine>();
    for (const s of mine) {
      const sig = signatureOf(s);
      bySig.set(sig, [...(bySig.get(sig) ?? []), s]);
    }
    if (bySig.size > 1) groupsNeedingSplit += 1;

    lines.push(
      `GROUP "${r.name}" — ${mine.length} shift(s), ${bySig.size} distinct working week(s)` +
        (bySig.size > 1 ? '  ⇒ SPLIT INTO ' + bySig.size : '  ⇒ no split needed'),
    );
    let n = 0;
    for (const [sig, group] of bySig) {
      n += 1;
      lines.push(`  ── proposed group ${n} of ${bySig.size}: ${sig}`);
      for (const s of group) {
        const people = byShift.get(s.id) ?? [];
        affected += people.length;
        lines.push(`      shift ${s.code ?? '—'} (${s.name}) — ${people.length} employee(s) currently assigned`);
        for (const p of people) {
          lines.push(`          ${p.employeeCode ?? '—'} | ${p.name} | assigned from ${p.validFrom}`);
        }
        if (people.length === 0) lines.push('          (nobody is on this shift today)');
      }
    }
    lines.push('');
  }

  const orphans = shifts.filter((s) => s.ruleId == null);
  if (orphans.length) {
    lines.push('SHIFTS IN NO SCHEDULE GROUP:');
    for (const s of orphans) {
      const people = byShift.get(s.id) ?? [];
      lines.push(`    ${s.code ?? '—'} (${s.name}) — ${weekOf(s)} — ${people.length} employee(s)`);
    }
    lines.push('');
  }

  lines.push(
    `groups needing a split: ${groupsNeedingSplit}   ·   shifts: ${shifts.length}   ·   employees on an open arrangement: ${affected}`,
    '',
    'NOTHING HAS BEEN MOVED. This is the list the restructuring needs confirmed before it runs.',
  );
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  console.log('07ebd04d — schedule group split preview');
  console.log(`  schedule groups           : ${rules.length}`);
  console.log(`  active shifts             : ${shifts.length}`);
  console.log(`  groups needing a split    : ${groupsNeedingSplit}`);
  console.log(`  employees on open shifts  : ${affected}`);
  console.log(`  full list (names inside)  : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
