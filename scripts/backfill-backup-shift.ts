// One-shot / maintenance CLI (item b8aa3466) — give every ACTIVE employment a BACKUP SHIFT: the shift the
// attendance engine uses on any day the employee is not rostered.
//
// WHY THIS IS A SCRIPT AND NOT A MIGRATION. Pointing 30 people at AM03 is a DATA decision, not a schema
// one, and it changes how every future day calculates for each of them. Inside a migration that lands
// invisibly and there is nothing to read back afterwards. Here it is refused by default, prints the exact
// list BEFORE and the exact list AFTER, and writes through core/roster.ts assignEmployeeShift so each row
// gets its own audited employment.shift-arrangement.assigned event carrying before → after — which is both
// the proof of what happened and the instruction for undoing any single row.
//
// ATTENDANCE ALREADY RECORDED IS NOT TOUCHED. The engine stamps each attendance row's figures at write
// time and never re-derives history (core/attendance.ts) — this changes how days are calculated from the
// moment it is applied, forward, and nothing else.
//
// It also stamps the Shift arrangement as FIXED (see backfillBackupShift): everyone in this population
// was left on 'roster' by migration 0162 purely because they had no shift, and "Roster shift" is the wrong
// label for someone nobody rosters. Nothing in the engine branches on it; it is one click to change back.
//
// The shift is chosen BY CODE and must match exactly one non-archived shift. Shift codes are not unique in
// this product (production carries two shifts both coded AM1, plus AM1-copy / Test / Test-2), so an
// ambiguous code is an error rather than a coin-flip.
//
//   node --env-file=.env.production --import tsx scripts/backfill-backup-shift.ts                  # dry run
//   node --env-file=.env.production --import tsx scripts/backfill-backup-shift.ts --apply          # write
//   node --env-file=.env.production --import tsx scripts/backfill-backup-shift.ts --shift=AM03 --apply
import { createDb, type SessionContext } from '../db/client';
import { resolveEntitlementsTx } from '../core/entitlements';
import { tenant } from '../db/schema';
import { backfillBackupShift, type UncoveredEmployment } from '../core/roster';

const DEFAULT_SHIFT_CODE = 'AM03'; // 09:00–18:00, 60-minute break — the shift the reporter named.

function printList(label: string, rows: UncoveredEmployment[]): void {
  console.log(`    ${label} (${rows.length}):`);
  if (rows.length === 0) {
    console.log('      —');
    return;
  }
  for (const r of rows) console.log(`      ${r.employeeCode ?? '(no code)'}  ${r.name}`);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const shiftArg = process.argv.find((a) => a.startsWith('--shift='));
  const shiftCode = shiftArg ? shiftArg.slice('--shift='.length) : DEFAULT_SHIFT_CODE;
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('backfill-backup-shift requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(
    `backfill-backup-shift — ${tenants.length} tenant(s), shift="${shiftCode}", mode=${apply ? 'APPLY' : 'dry-run'}`,
  );
  let assigned = 0;
  let failures = 0;
  for (const t of tenants) {
    // SYSTEM context (hr_admin authorises the profile write; no userId → the event actor is `system`).
    // A REAL entitlement snapshot, not an `entitlementsExempt` marker: a marked context reads every
    // billable module as ENABLED, which is the silent-grant trap ENTITLEMENTS_EXEMPT_REASONS documents.
    // Safe on the owner connection — RLS does not bind the owner role. Same shape as scripts/review-sweep.ts.
    const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, t.id));
    const ctx: SessionContext = { tenantId: t.id, roles: ['hr_admin'], entitlements };
    try {
      const r = await backfillBackupShift(ctx, { shiftCode, apply });
      if (r.before.length === 0) {
        console.log(`  ${t.name}: every active employment already has a backup shift — nothing to do.`);
        continue;
      }
      console.log(`  ${t.name}:`);
      printList('BEFORE — no backup shift', r.before);
      printList(apply ? 'AFTER — still no backup shift' : 'AFTER (unchanged — dry run)', r.after);
      if (apply) {
        assigned += r.before.length - r.after.length;
        // A non-empty AFTER on an apply run means a row was rejected mid-loop; the run is NOT complete.
        if (r.after.length > 0) console.error(`    ! ${r.after.length} employment(s) still uncovered — re-run.`);
      }
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
    }
  }
  console.log(
    `backfill-backup-shift done — ${apply ? `assigned ${assigned}` : 'nothing written'}, ${failures} failure(s).` +
      `${apply ? '' : ' Re-run with --apply to write.'}`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
