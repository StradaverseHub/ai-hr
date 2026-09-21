/**
 * 07ebd04d — DO THE FIVE SHIFTS IN A SCHEDULE GROUP AGREE ABOUT THE WEEK?
 *
 * THE DECISION THIS EXISTS TO INFORM, and the approved plan requires it BEFORE any migration is written.
 * The item moves the working-week patterns (weekly_pattern, half_pattern, off_pattern) off `shift` and on
 * to the Schedule Group (`attendance_rule`) that owns them. Whether that is a lift or a judgement call
 * depends entirely on the data:
 *
 *   · if every shift in a group carries an IDENTICAL pattern, the group simply inherits it and the
 *     migration is mechanical;
 *   · if any shift differs, somebody must decide WHOSE pattern the group inherits — and that is the
 *     reporter's call, not a default this repo may pick. Writing the migration first and resolving the
 *     conflict with a rule like "the newest wins" would silently change which days people are rostered
 *     to work.
 *
 * READ-ONLY BY CONSTRUCTION. No insert, no update, no delete; no migration is written or applied. Its
 * whole output is a comparison, and it exists so the question reaches the reporter before any data moves.
 *
 * ⚠️ IT DOES NOT ANSWER THE SECOND QUESTION, and says so rather than implying otherwise: day_type and
 * category also describe the DAY rather than the shift, but they are read by the derivation engine
 * (core/attendance-derive.ts, core/attendance-calc.ts) and every reader has to be traced before they move.
 * This reports the three pattern columns only.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/report-shift-pattern-divergence.ts
 */
import { writeFileSync } from 'node:fs';
import { isNull } from 'drizzle-orm';
import { createDb } from '../db/client';
import { attendanceRule, shift } from '../db/schema';

const OUT = `/var/tmp/shift-pattern-divergence-${new Date().toISOString().slice(0, 10)}.txt`;

/** A pattern printed so two of them can be compared BY EYE as well as by equality. */
const fmt = (a: number[] | null) => (a == null ? 'NULL' : `[${[...a].sort((x, y) => x - y).join(',')}]`);
/** Order-insensitive: these are day-of-week SETS, and [1,2] and [2,1] are the same working week. */
const key = (s: { weeklyPattern: number[] | null; halfPattern: number[] | null; offPattern: number[] | null }) =>
  `${fmt(s.weeklyPattern)}|${fmt(s.halfPattern)}|${fmt(s.offPattern)}`;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this report requires MIGRATION_DATABASE_URL (the owner role) to read every tenant.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);

  const rules = await owner.db
    .select({ id: attendanceRule.id, name: attendanceRule.name, tenantId: attendanceRule.tenantId })
    .from(attendanceRule);
  const shifts = await owner.db
    .select({
      id: shift.id,
      code: shift.code,
      name: shift.name,
      ruleId: shift.ruleId,
      tenantId: shift.tenantId,
      weeklyPattern: shift.weeklyPattern,
      halfPattern: shift.halfPattern,
      offPattern: shift.offPattern,
    })
    .from(shift)
    .where(isNull(shift.archivedAt));

  const lines: string[] = [
    '07ebd04d — do the shifts in each Schedule Group agree about the working week?',
    `generated ${new Date().toISOString()}   ·   READ-ONLY (no migration written, nothing changed)`,
    '',
    'Columns compared: weekly_pattern, half_pattern, off_pattern. Day numbers are sorted before comparing,',
    'so [1,2] and [2,1] count as the same week. day_type and category are NOT compared — see the header.',
    '',
  ];

  let groupsAgreeing = 0;
  let groupsDiverging = 0;
  let shiftsWithNoGroup = 0;

  for (const r of rules) {
    const mine = shifts.filter((s) => s.ruleId === r.id);
    if (mine.length === 0) {
      lines.push(`GROUP "${r.name}" — no shifts. Nothing to inherit.`, '');
      continue;
    }
    const keys = new Set(mine.map(key));
    const verdict = keys.size === 1 ? 'AGREE — the group can simply inherit it' : `DIVERGE — ${keys.size} different weeks`;
    if (keys.size === 1) groupsAgreeing += 1;
    else groupsDiverging += 1;

    lines.push(`GROUP "${r.name}" — ${mine.length} shift(s): ${verdict}`);
    for (const s of mine) {
      lines.push(
        `    ${s.code ?? '—'} ${s.name}` +
          `\n        weekly ${fmt(s.weeklyPattern)}   half ${fmt(s.halfPattern)}   off ${fmt(s.offPattern)}`,
      );
    }
    if (keys.size > 1) {
      lines.push(
        '    ⚠️ A DECISION IS NEEDED: which of these weeks does the group inherit? Nothing should be',
        '       migrated until the reporter says. Picking a default here would change which days people',
        '       are rostered to work, silently.',
      );
    }
    lines.push('');
  }

  const orphans = shifts.filter((s) => s.ruleId == null);
  shiftsWithNoGroup = orphans.length;
  if (orphans.length) {
    lines.push('SHIFTS IN NO SCHEDULE GROUP — these have no group to inherit from:');
    for (const s of orphans) {
      lines.push(`    ${s.code ?? '—'} ${s.name}   weekly ${fmt(s.weeklyPattern)}   half ${fmt(s.halfPattern)}   off ${fmt(s.offPattern)}`);
    }
    lines.push(
      '    These need an answer too: either they join a group, or the group-owned pattern has to stay',
      '    optional at the shift level. That is a design question, not a migration detail.',
      '',
    );
  }

  lines.push(
    `groups agreeing: ${groupsAgreeing}   ·   groups diverging: ${groupsDiverging}   ·   shifts with no group: ${shiftsWithNoGroup}`,
    '',
    groupsDiverging === 0 && shiftsWithNoGroup === 0
      ? 'VERDICT: every group agrees. The move is a lift, and no figure changes.'
      : 'VERDICT: at least one question is open. Do not write the migration yet.',
  );
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  console.log('07ebd04d — shift pattern divergence');
  console.log(`  schedule groups       : ${rules.length}`);
  console.log(`  active shifts         : ${shifts.length}`);
  console.log(`  groups AGREEING       : ${groupsAgreeing}`);
  console.log(`  groups DIVERGING      : ${groupsDiverging}  ${groupsDiverging ? '  <-- the reporter must choose' : ''}`);
  console.log(`  shifts with no group  : ${shiftsWithNoGroup}`);
  console.log(`  full comparison       : ${OUT}`);
  await owner.client.end();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
