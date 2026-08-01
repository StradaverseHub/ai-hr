// One-shot / maintenance CLI (feedback 241817ef) — CONVERT FIRST, REMOVE SECOND.
//
// Rewrites every leave_approval_policy row that the Assignment Template screen cannot own — the
// per-company base chain, any other "applies to every leave type" rule, and any rule carrying its own
// chain instead of a template — as an ordinary template-driven, leave-type-scoped assignment. This has to
// run, and its output has to be confirmed, BEFORE the Approval Workflows and Company base approval chain
// sections are removed from the Approval tab: deleting those surfaces first would not break routing, it
// would silently re-route requests onto the built-in direct_manager → hr_admin fallback.
//
// The conversion proves itself. Every routing subject × leave type × day-range probe is resolved before
// and after the rewrite IN THE SAME TRANSACTION, and the first difference aborts and rolls back. A dry run
// performs the identical writes and the identical proof and then rolls back on purpose, so a clean dry run
// is a measurement, not a forecast.
//
//   node --env-file=.env.production --import tsx scripts/convert-approval-rules.ts          # dry run
//   node --env-file=.env.production --import tsx scripts/convert-approval-rules.ts --apply  # write
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { company, leaveType, tenant } from '../db/schema';
import {
  ApprovalRoutingChangedError,
  convertLegacyApprovalRules,
  type ConversionReport,
} from '../core/leave-approval-consolidation';

async function main() {
  const apply = process.argv.includes('--apply');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('convert-approval-rules requires MIGRATION_DATABASE_URL (owner role) to enumerate tenants.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(`convert-approval-rules — ${tenants.length} tenant(s), mode=${apply ? 'APPLY' : 'dry-run'}`);

  let converted = 0;
  let skipped = 0;
  let failures = 0;
  for (const t of tenants) {
    // Names for the report — a list of uuids is not something an operator can confirm against.
    const companies = await owner.db
      .select({ id: company.id, name: company.legalName })
      .from(company)
      .where(eq(company.tenantId, t.id));
    const types = await owner.db
      .select({ id: leaveType.id, code: leaveType.code, name: leaveType.name })
      .from(leaveType)
      .where(eq(leaveType.tenantId, t.id));
    const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
    const typeName = (id: string | null) => (id === null ? 'every leave type' : (types.find((x) => x.id === id)?.code ?? id));

    try {
      // SYSTEM context: hr_admin authorises the configuration write, no userId ⇒ the event actor is `system`.
      // Deliberately carries NO `entitlementsExempt` marker. The marker makes every module read as
      // enabled and every setting fall back to the catalog default (ENTITLEMENTS_EXEMPT_REASONS), which
      // is a bypass, not a convenience — and this conversion passes through no gate at all: it resolves
      // approval chains and writes leave_approval_policy rows, neither of which consults an entitlement.
      const r: ConversionReport = await convertLegacyApprovalRules({ tenantId: t.id, roles: ['hr_admin'] }, { apply });
      if (r.legacy.length === 0) {
        console.log(`  ${t.name}: nothing to convert — the Approval tab sections are already redundant.`);
        continue;
      }
      console.log(
        `  ${t.name}: ${r.legacy.length} row(s) to convert; proof compared ${r.routingChecks} routing case(s) ` +
          `across ${r.employmentsCovered} active employment(s) — unchanged.`,
      );
      for (const a of r.actions) {
        switch (a.kind) {
          case 'template-created':
            console.log(`      + template “${a.name}” (${a.levels.join(' → ')})`);
            break;
          case 'template-reused':
            console.log(`      · reuses existing template “${a.name}”`);
            break;
          case 'rule-templated':
            console.log(
              `      · ${companyName(a.companyId)} / ${typeName(a.leaveTypeId)}: own chain → template assignment`,
            );
            converted += 1;
            break;
          case 'expanded':
            console.log(
              `      · ${companyName(a.companyId)} / ${typeName(a.leaveTypeId)}: ` +
                `${a.created ? 'new' : 'reused'} assignment from the any-type rule`,
            );
            converted += 1;
            break;
          case 'source-archived':
            console.log(`      - ${companyName(a.companyId)}: any-type source rule archived`);
            break;
          case 'skipped':
            console.log(`      ! ${companyName(a.companyId)} / ${typeName(a.leaveTypeId)}: skipped — ${a.reason}`);
            skipped += 1;
            break;
        }
      }
      for (const c of r.caveats) console.log(`      NOTE ${companyName(c.companyId)}: ${c.note}`);
    } catch (e) {
      failures += 1;
      if (e instanceof ApprovalRoutingChangedError) {
        console.error(`  ✗ ${t.name}: ${e.message}`);
        for (const d of e.differences.slice(0, 20)) {
          console.error(
            `      employment ${d.employmentId} · ${typeName(d.leaveTypeId)} · ${d.days}d: ${d.before} → ${d.after}`,
          );
        }
        console.error(
          '      Nothing was written. These rules need a human decision before the conversion can run.',
        );
      } else {
        console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      }
    }
  }

  console.log(
    `convert-approval-rules done — ${apply ? 'converted' : 'would convert'} ${converted} assignment(s), ` +
      `${skipped} skipped, ${failures} failure(s).${apply ? '' : ' Re-run with --apply to write.'}`,
  );
  await owner.client.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
