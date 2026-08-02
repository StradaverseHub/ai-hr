/**
 * `usage:capture` (ADR-0077 slice 10) — write one `usage_snapshot` row per (tenant, company) per day.
 *
 * The table has existed since slice 1 with NOTHING writing to it. This is that writer. Usage cannot be
 * reconstructed after the fact, so every day it stayed unwired is a day that can never be billed
 * retrospectively — which is why this ships before the pricing unit is decided rather than after.
 *
 * SCHEDULE IT DAILY, and unlike the other sweeps a MISSED DAY IS A PERMANENT HOLE: leave accrual catches
 * up on its next run because it computes from service dates, but nothing can tell you how many people
 * were employed last Tuesday once Tuesday has passed. `--on YYYY-MM-DD` exists for a catch-up run made
 * within the window where the answer is still recoverable (headcount is derived from hire/termination
 * dates, so a recent day usually is); payslip counts and the active module set are NOT recoverable that
 * way and will be re-derived as they are TODAY, not as they were. A back-fill is therefore an
 * approximation and says so on the console.
 *
 *   node --env-file=.env.production --import tsx scripts/capture-usage.ts
 *   node --env-file=.env.production --import tsx scripts/capture-usage.ts --on 2026-08-01
 *
 * ENV CONTRACT: MIGRATION_DATABASE_URL only — cross-tenant platform metering, like the other out-of-band
 * runners. The app role must never gain the cross-tenant read this performs.
 *
 * SKIPS TENANTS OUT OF GOOD STANDING, through r108's shared `loadSweepScope`, for the same reason every
 * other sweep does: the scope decision belongs to one predicate, and a suspended tenant's writes would be
 * refused by `withTenant` anyway. It also happens to be the right BILLING answer — you do not meter usage
 * for a period a customer was locked out of. The skips are reported and recorded, so the gap in the row
 * set is explained rather than mysterious.
 */
import { createDb } from '../db/client';
import { usageSnapshot } from '../db/schema';
import { describeSkips, loadSweepScope } from '../core/sweep-scope';
import { usageForTenant } from '../core/usage-metering';
import { recordJobRun } from '../core/job-run';
import { todayInKualaLumpur } from '../lib/hr-date';

function loadEnv() {
  try {
    process.loadEnvFile('.env.production');
  } catch {
    try {
      process.loadEnvFile('.env.local');
    } catch {
      // env supplied directly
    }
  }
}

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export async function captureUsage(
  url: string,
  opts: { capturedOn?: string } = {},
): Promise<{ rows: number; tenants: number; skipped: number; failures: number }> {
  const owner = createDb(url);
  // MYT, not UTC — the sweep runs in the small hours local time, and a UTC date would file the day's
  // usage under the previous day. Same trap as the four leave sweeps (test/sweep-script-timezone.test.ts).
  const capturedOn = opts.capturedOn ?? todayInKualaLumpur();

  const scope = await loadSweepScope(owner.db);
  console.log(`usage:capture — ${scope.run.length} tenant(s) in scope, captured_on ${capturedOn}` +
    (scope.skipped.length > 0 ? `, ${scope.skipped.length} skipped` : ''));
  for (const line of describeSkips(scope)) console.log(line);

  let rows = 0;
  let failures = 0;
  for (const t of scope.run) {
    try {
      const counts = await usageForTenant(owner.db, t.id, capturedOn);
      for (const c of counts) {
        // Upsert on (tenant, company, day) — migration 0347. A re-run REPLACES the day rather than
        // doubling it, and the later run wins because it is the more considered answer.
        await owner.db
          .insert(usageSnapshot)
          .values({
            tenantId: c.tenantId,
            companyId: c.companyId,
            capturedOn: c.capturedOn,
            country: c.country,
            activeEmployments: c.activeEmployments,
            activeUsers: c.activeUsers,
            payslipsGenerated: c.payslipsGenerated,
            modulesActive: c.modulesActive,
          })
          .onConflictDoUpdate({
            target: [usageSnapshot.tenantId, usageSnapshot.companyId, usageSnapshot.capturedOn],
            set: {
              country: c.country,
              activeEmployments: c.activeEmployments,
              activeUsers: c.activeUsers,
              payslipsGenerated: c.payslipsGenerated,
              modulesActive: c.modulesActive,
            },
          });
        rows += 1;
        console.log(
          `  ✓ ${t.name} / ${c.companyName}: ${c.activeEmployments} employment(s), ${c.activeUsers} user(s), ` +
            `${c.payslipsGenerated} payslip(s), ${c.modulesActive.length} module(s)`,
        );
      }
    } catch (e) {
      failures += 1;
      console.error(`  ✗ ${t.name} (${t.id}): ${(e as Error).message}`);
    }
  }
  console.log(
    `usage:capture done — ${rows} snapshot row(s) across ${scope.run.length} tenant(s), ${failures} failure(s).` +
      (scope.skipped.length > 0 ? ` ${scope.skipped.length} tenant(s) skipped for standing.` : ''),
  );
  return { rows, tenants: scope.run.length, skipped: scope.skipped.length, failures };
}

if (process.argv[1]?.endsWith('capture-usage.ts')) {
  loadEnv();
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('usage:capture requires MIGRATION_DATABASE_URL (owner role).');
    process.exit(1);
  }
  const onIdx = process.argv.indexOf('--on');
  const on = onIdx >= 0 ? process.argv[onIdx + 1] : undefined;
  if (on !== undefined && !ISO_DATE.test(on)) {
    console.error(`--on expects YYYY-MM-DD, got '${on}'.`);
    process.exit(1);
  }
  if (on) {
    console.log(
      `  ⚠️  Back-filling ${on}. Headcount re-derives from hire/termination dates and is accurate; ` +
        `payslip counts and the module set reflect TODAY, not ${on}.`,
    );
  }
  const startedAt = Date.now();
  captureUsage(url, { capturedOn: on })
    .then(async (r) => {
      try {
        await recordJobRun(createDb(url).db, {
          jobKey: 'usage.capture',
          startedAt,
          tenantsProcessed: r.tenants,
          tenantsFailed: r.failures,
          tenantsSkipped: r.skipped,
          result: { rows: r.rows },
        });
      } catch (e) {
        // Its own try/catch — a logging failure must never change a sweep's exit code.
        console.error(`usage:capture — could not write the run log: ${(e as Error).message}`);
      }
      process.exit(r.failures > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
