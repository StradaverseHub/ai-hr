/**
 * 508d3acd — REVERSE entitlement grants the leave type's own identity conditions exclude.
 *
 * WHY THIS EXISTS. A Leave Generation run on 2026-09-20 credited Maternity Leave to every employment on
 * the account: 79 rows, 7,742 days, of which 6,566 days across 67 employments went to people the type's
 * gender rule excludes. `openLeaveYear` consulted no identity condition at all — r315 adds that gate, but
 * a gate only stops the NEXT run. The days already written are what this script takes back off.
 *
 * DRY RUN BY DEFAULT. It prints what it would do and writes nothing. `--apply` is required to write, and
 * the list is meant to reach the reporter BEFORE that — the plan promised them "a record of exactly what
 * was removed".
 *
 * ⚠️ IT REVERSES, IT NEVER DELETES. A negative `adjustment` is posted beside the wrong accrual with
 * reason `sys:ineligible_grant_reversal`, so the ledger keeps saying what happened and when. Deleting
 * would leave a balance nobody can explain and destroy the evidence of the run that caused it
 * (6574c6b4: the ledger is the record, not a working figure to be tidied).
 *
 * WHAT IT WILL NOT TOUCH, and each of these is a refusal rather than a filter:
 *   · a DEBIT — leave somebody actually took. Reversing a grant under a taken day would drive the
 *     balance negative and rewrite history the employee acted on.
 *   · a row carrying `source_request_id` — it belongs to a leave request and is that request's business.
 *   · a pair whose identity conditions the employee PASSES — those grants are correct.
 *   · an employment whose reversal would take the type's balance below zero. That means days were spent
 *     against a grant that should not have existed, which is a human decision, not a sweep's.
 *
 * IDEMPOTENT. A pair that already carries a reversal adjustment is skipped, so a re-run after a partial
 * failure cannot double-reverse.
 *
 *   cd /opt/ai-hr && set -a && . ./.env.production && set +a && \
 *     /opt/node20/bin/node --import tsx scripts/reverse-ineligible-leave-grants.ts [--apply]
 */
import { writeFileSync } from 'node:fs';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
// ADR-0080 D9 — through the PACK FACADE, never core/leave directly. The drift ratchet refuses a new
// scripts/ file importing the leave pack's implementation, and its allowlist only ever shrinks.
import { INELIGIBLE_GRANT_REVERSAL_REASON, isProfileEligible, type LeaveEligibility } from '../packs/leave/service';
import { employment, leaveLedger, leaveType, person } from '../db/schema';

const APPLY = process.argv.includes('--apply');
const OUT = `/var/tmp/ineligible-leave-grants-${new Date().toISOString().slice(0, 10)}.txt`;

async function main() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('this script requires MIGRATION_DATABASE_URL (the owner role).');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const db = owner.db;

  // Every type that carries an identity condition at all. A type with none can never produce a wrong pair.
  const types = await db
    .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name, eligibility: leaveType.eligibility })
    .from(leaveType);
  const restricted = types.filter((t) => hasIdentityRule(t.eligibility));
  if (restricted.length === 0) {
    console.log('No leave type carries a gender / marital / organisation condition. Nothing to check.');
    await owner.client.end();
    return;
  }

  const emps = await db
    .select({
      id: employment.id,
      tenantId: employment.tenantId,
      code: employment.employeeCode,
      gender: person.gender,
      marital: person.maritalStatus,
      orgDivision: employment.orgDivision,
      orgBranch: employment.orgBranch,
      orgRegion: employment.orgRegion,
      orgLine: employment.orgLine,
      orgSection: employment.orgSection,
      orgTeam: employment.orgTeam,
      orgBase: employment.orgBase,
      employmentCategory: employment.employmentCategory,
    })
    .from(employment)
    .innerJoin(person, eq(person.id, employment.personId));
  const empById = new Map(emps.map((e) => [e.id, e]));

  const lines: string[] = [
    `508d3acd — entitlement grants the leave type's identity conditions exclude`,
    `${APPLY ? 'APPLY' : 'DRY RUN'}   ·   generated ${new Date().toISOString()}`,
    `types carrying an identity condition: ${restricted.map((t) => t.code ?? t.id).join(', ')}`,
    ``,
    `EMPLOYEE | LEAVE TYPE | ACCRUED DAYS | BALANCE | ACTION`,
    `-`.repeat(88),
  ];
  let reversed = 0;
  let reversedDays = 0;
  let skippedSpent = 0;
  let skippedAlready = 0;
  let correct = 0;

  for (const t of restricted) {
    // Accrual-class rows only, and never one attached to a leave request.
    const held = await db
      .select({
        employmentId: leaveLedger.employmentId,
        accrued: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.entryType} in ('accrual','in_lieu_accrual') and ${leaveLedger.sourceRequestId} is null), 0)`,
        balance: sql<string>`coalesce(sum(${leaveLedger.days}), 0)`,
        already: sql<string>`coalesce(sum(${leaveLedger.days}) filter (where ${leaveLedger.reason} = ${INELIGIBLE_GRANT_REVERSAL_REASON}), 0)`,
        debits: sql<string>`count(*) filter (where ${leaveLedger.entryType} = 'debit')`,
      })
      .from(leaveLedger)
      .where(eq(leaveLedger.leaveTypeId, t.id))
      .groupBy(leaveLedger.employmentId);

    for (const row of held) {
      const emp = empById.get(row.employmentId);
      if (!emp) continue;
      if (isProfileEligible(t.eligibility as LeaveEligibility | null, emp)) {
        correct += 1;
        continue;
      }
      const accrued = Number(row.accrued);
      const balance = Number(row.balance);
      const already = Number(row.already);
      if (accrued <= 0) continue;
      if (already !== 0) {
        skippedAlready += 1;
        continue;
      }
      // A reversal must not drive the balance negative: that would mean days were spent against a grant
      // that should not have existed, which a human decides about, not this script.
      if (balance - accrued < 0 || Number(row.debits) > 0) {
        skippedSpent += 1;
        lines.push(`${emp.code ?? emp.id} | ${t.code ?? t.name} | ${accrued.toFixed(2)} | ${balance.toFixed(2)} | LEFT ALONE — days were spent`);
        continue;
      }
      lines.push(`${emp.code ?? emp.id} | ${t.code ?? t.name} | ${accrued.toFixed(2)} | ${balance.toFixed(2)} | reverse ${(-accrued).toFixed(2)}`);
      reversed += 1;
      reversedDays = Math.round((reversedDays + accrued) * 100) / 100;

      if (APPLY) {
        await db.insert(leaveLedger).values({
          tenantId: emp.tenantId,
          employmentId: emp.id,
          leaveTypeId: t.id,
          entryType: 'adjustment',
          days: (-accrued).toFixed(2),
          effectiveOn: new Date().toISOString().slice(0, 10),
          reason: INELIGIBLE_GRANT_REVERSAL_REASON,
        });
      }
    }
  }

  lines.push(``, `to reverse: ${reversed} (${reversedDays.toFixed(2)} days) · left alone because days were spent: ${skippedSpent} · already reversed: ${skippedAlready} · correctly held: ${correct}`);
  writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  // Counts only on the console — the list names individuals and belongs in the file.
  console.log(`508d3acd ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  pairs to reverse       : ${reversed}  (${reversedDays.toFixed(2)} days)`);
  console.log(`  left alone (days spent): ${skippedSpent}`);
  console.log(`  already reversed       : ${skippedAlready}`);
  console.log(`  correctly held         : ${correct}`);
  console.log(`  per-employee list      : ${OUT}`);
  if (!APPLY) console.log(`  nothing was written. Re-run with --apply once the list has been reviewed.`);
  await owner.client.end();
}

/** Does this type carry any identity condition at all? */
function hasIdentityRule(elig: unknown): boolean {
  const e = (elig ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v !== '');
  return list(e.gender) || list(e.maritalStatus) || ['orgDivision', 'orgBranch', 'orgRegion', 'orgLine', 'orgSection', 'orgTeam', 'orgBase', 'employmentCategory'].some((k) => list(e[k]));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
