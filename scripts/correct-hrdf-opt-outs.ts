// One-shot / maintenance CLI (feedback 57840a6e) — repair the employees the OLD Others Statutory
// CHECKBOX pinned to an explicit "Subject to HRDF = No" by accident, so their HRD Corp levy starts
// generating again on the next payroll run.
//
// The checkbox rendered from the company's HRDF band: while the company was `not_registered` it showed
// unchecked, so ANY save of that card wrote an explicit false — and an explicit false beats the company
// default for ever. The forward fix (the tri-state select) only changes future saves; this step corrects
// the rows already written. It is NOT a blanket false → null flip: the DomainEvent log is the
// discriminator (a No written while the company was not_registered = accidental → reset to null; a No
// written while the company WAS registered = HR's real decision → left alone; no traceable write =
// reported for HR to confirm, never auto-changed). See correctAccidentalHrdfOptOutsMY.
//
// Read-only unless --apply is passed, and safe to re-run (a corrected row is null, so it is no longer a
// candidate).
//   node --env-file=.env.production --import tsx scripts/correct-hrdf-opt-outs.ts          # dry run
//   node --env-file=.env.production --import tsx scripts/correct-hrdf-opt-outs.ts --apply  # correct
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { company, tenant } from '../db/schema';
// Jurisdiction resolves through the registry (ADR-0080 D1/D7), never a direct localization/my import.
import { packFor } from '../localization/registry';

async function main() {
  const apply = process.argv.includes('--apply');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('correct-hrdf-opt-outs requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const pack = packFor('MY');
  if (!pack) {
    console.error('correct-hrdf-opt-outs: no MY localization pack registered.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`correct-hrdf-opt-outs — ${tenants.length} tenant(s), mode=${apply ? 'APPLY' : 'dry-run'}`);
  let corrected = 0;
  let kept = 0;
  let unclassified = 0;
  let failures = 0;
  for (const t of tenants) {
    const companies = await owner.db
      .select({ id: company.id, name: company.legalName })
      .from(company)
      .where(eq(company.tenantId, t.id));
    for (const c of companies) {
      try {
        // SYSTEM context (hr_admin authorises the statutory write; no userId → the event actor is `system`).
        const r = await pack.statutory.correctAccidentalHrdfOptOuts({ tenantId: t.id, roles: ['hr_admin'] }, { companyId: c.id, apply });
        corrected += r.corrected.length;
        kept += r.kept.length;
        unclassified += r.unclassified.length;
        if (r.scanned > 0) {
          console.log(
            `  ${t.name} / ${c.name}: scanned ${r.scanned} explicit-No row(s) — ` +
              `${apply ? 'reset' : 'would reset'} ${r.corrected.length}, kept ${r.kept.length}, unclassified ${r.unclassified.length}`,
          );
          for (const u of r.unclassified) console.log(`      ! unclassified (confirm with HR): person ${u.personId}`);
        }
      } catch (e) {
        failures += 1;
        console.error(`  ✗ ${t.name} / ${c.name}: ${(e as Error).message}`);
      }
    }
  }
  console.log(
    `correct-hrdf-opt-outs done — ${apply ? 'reset' : 'would reset'} ${corrected}, kept ${kept}, ` +
      `unclassified ${unclassified}, ${failures} failure(s).${apply ? '' : ' Re-run with --apply to write.'}`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
