// One-shot / maintenance CLI (item d64d0df4) — find the employees whose "Disabled individual (OKU)"
// claim was SILENTLY CLEARED by an automatic family-record sync, and (with --apply) put it back.
//
// ── WHAT WENT WRONG ───────────────────────────────────────────────────────────────────────────────
// core/dependents.ts syncChildReliefFromFamily re-derives num_children from the Family register on every
// dependent add / edit / archive, and writes it through the FULL-OVERWRITE tax setter. It read six tax
// columns and passed exactly those six. Migration 0341 then added disabled_individual, whose setter
// default is false. From that moment, any family edit on an employee in 'auto' child-relief mode
// silently withdrew their OKU claim. Nothing on screen said so, and their PCB rose the following month.
//
// The FORWARD fix (carrying the claim through the sync) shipped with this item. It does not repair
// anyone already cleared — they stay cleared and keep OVER-paying — which is what this script is for.
//
// ── HOW THE AFFECTED PEOPLE ARE IDENTIFIED ────────────────────────────────────────────────────────
// Exactly, from the audit log rather than by guessing. setTaxProfileMY records before/after of the tax
// columns on every `employee.tax.updated` event, and stamps `provenance: 'auto_child_relief'` on the
// machine-driven path only. So the signature of the bug is precisely:
//
//     eventType = 'employee.tax.updated'
//       AND payload.provenance = 'auto_child_relief'
//       AND payload.before.disabledIndividual = true
//       AND payload.after.disabledIndividual  = false
//
// A person is only reported if they are STILL cleared today — someone who was cleared and later re-set
// by a human is not a victim any more and must not be touched.
//
// ── WHAT --apply DOES, AND WHAT IT COSTS ──────────────────────────────────────────────────────────
// Sets disabled_individual back to true through the ordinary audited setter, so the restoration is
// itself an `employee.tax.updated` event with before/after — never a silent UPDATE.
//
// ⚠️ Restoring a claim mid-year triggers a FULL YEAR-TO-DATE PCB catch-up in the month of restoration,
// because monthly tax is computed cumulatively. Their tax has been too HIGH every month since the
// clearance, so the catch-up is a refund-shaped correction, not a bill. This is disclosed on the
// approved plan; run the dry run first and hand the reporter the list.
//
//   node --env-file=.env.production --import tsx scripts/report-cleared-disabled-individual.ts
//   node --env-file=.env.production --import tsx scripts/report-cleared-disabled-individual.ts --apply
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { domainEvent, employeeStatutoryMy, tenant } from '../db/schema';
// Jurisdiction resolves through the registry (ADR-0080 D1/D7), never a direct localization/my import.
import { packFor } from '../localization/registry';

async function main() {
  const apply = process.argv.includes('--apply');
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error(
      'report-cleared-disabled-individual requires MIGRATION_DATABASE_URL (owner role) to read the event log across tenants.',
    );
    process.exit(1);
  }
  const pack = packFor('MY');
  if (!pack) {
    console.error('report-cleared-disabled-individual: no MY localization pack registered.');
    process.exit(1);
  }
  const owner = createDb(ownerUrl);
  const tenants = await owner.db.select({ id: tenant.id, name: tenant.name }).from(tenant);
  console.log(
    `report-cleared-disabled-individual — ${tenants.length} tenant(s), mode=${apply ? 'APPLY' : 'dry-run'}`,
  );

  let cleared = 0;
  let restored = 0;
  let alreadyBack = 0;

  for (const t of tenants) {
    // The clearance signature, straight out of the audit log.
    const events = await owner.db
      .select({
        personId: sql<string>`${domainEvent.payload} ->> 'personId'`,
        at: domainEvent.occurredAt,
      })
      .from(domainEvent)
      .where(
        and(
          eq(domainEvent.tenantId, t.id),
          eq(domainEvent.eventType, 'employee.tax.updated'),
          sql`${domainEvent.payload} ->> 'provenance' = 'auto_child_relief'`,
          sql`${domainEvent.payload} -> 'before' ->> 'disabledIndividual' = 'true'`,
          sql`${domainEvent.payload} -> 'after' ->> 'disabledIndividual' = 'false'`,
        ),
      );

    const byPerson = new Map<string, Date>();
    for (const e of events) {
      if (!e.personId) continue;
      const prev = byPerson.get(e.personId);
      if (!prev || e.at > prev) byPerson.set(e.personId, e.at);
    }
    if (byPerson.size === 0) continue;

    for (const [personId, at] of byPerson) {
      // Only STILL-cleared people are victims. Someone a human re-flagged afterwards is whole again.
      const [row] = await owner.db
        .select({
          disabledIndividual: employeeStatutoryMy.disabledIndividual,
          taxNumber: employeeStatutoryMy.taxNumber,
          taxCategory: employeeStatutoryMy.taxCategory,
          taxResidency: employeeStatutoryMy.taxResidency,
          numChildren: employeeStatutoryMy.numChildren,
          childReliefMode: employeeStatutoryMy.childReliefMode,
          employerBearsTax: employeeStatutoryMy.employerBearsTax,
          disabledSpouse: employeeStatutoryMy.disabledSpouse,
          childReliefTable: employeeStatutoryMy.childReliefTable,
        })
        .from(employeeStatutoryMy)
        .where(and(eq(employeeStatutoryMy.tenantId, t.id), eq(employeeStatutoryMy.personId, personId)))
        .limit(1);
      if (!row) continue;
      if (row.disabledIndividual) {
        alreadyBack += 1;
        continue;
      }
      cleared += 1;
      console.log(
        `  ${t.name}: person ${personId} — OKU claim cleared by an automatic family sync on ${at.toISOString().slice(0, 10)}; PCB too HIGH since.`,
      );
      if (!apply) continue;
      // Restore through the ordinary audited setter, carrying every other tax column forward so the
      // restoration cannot itself become a second silent overwrite. SYSTEM context (hr_admin authorises
      // the statutory write; no userId → the event actor is `system`).
      await pack.statutory.setTax(
        { tenantId: t.id, roles: ['hr_admin'], entitlementsExempt: 'sweeps' },
        {
          personId,
          taxNumber: row.taxNumber,
          taxCategory: row.taxCategory ?? undefined,
          taxResidency: row.taxResidency,
          numChildren: row.numChildren,
          childReliefMode: row.childReliefMode,
          employerBearsTax: row.employerBearsTax ?? false,
          disabledIndividual: true,
          disabledSpouse: row.disabledSpouse ?? false,
          childReliefTable: row.childReliefTable ?? null,
        },
      );
      restored += 1;
    }
  }

  console.log(
    `report-cleared-disabled-individual — ${cleared} still-cleared employee(s); ` +
      `${alreadyBack} were re-flagged by a human already; ${apply ? `${restored} restored` : 'no changes made (dry run)'}.`,
  );
  if (cleared > 0 && apply) {
    console.log(
      'NOTE: each restored employee absorbs a full year-to-date PCB catch-up in the month of restoration. ' +
        'Their tax has been too HIGH, so this is a correction in their favour. Tell payroll before the next run.',
    );
  }
  await owner.client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
