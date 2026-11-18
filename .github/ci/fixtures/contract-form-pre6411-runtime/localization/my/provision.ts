/**
 * MY pack reference-data seeding (ADR-0080 rung 5c, D5 / ADR-0079). The jurisdiction-shaped rows a
 * new tenant needs — the statutory leave-type catalog and the national + state public-holiday
 * calendar — moved BEHIND the pack interface (`CountryPack.seedReferenceData`). db/provision.ts and
 * db/seed.ts invoke this through the registry (`requirePackFor(country).seedReferenceData(...)`)
 * instead of importing `localization/my` directly.
 *
 * Behaviour is byte-identical to the loops that previously lived inline in db/provision.ts
 * `seedTenantCatalogs`: same insert order (leave types first, then national holidays, then the
 * state-specific subset), same column mapping, same returned `leaveTypeIds` map. Generic seeding
 * (profile-option catalogs) stays in db/provision.ts — only the country-shaped rows live here.
 */
import type { Tx } from '../../db/client';
import { holiday, leaveType } from '../../db/schema';
import { MY_LEAVE_TYPES } from './leave';
import { MY_HOLIDAYS_2026, MY_STATE_HOLIDAYS_2026 } from './holidays';

/**
 * Seed the MY leave-type catalog + public-holiday calendar for one tenant. Tenant-scoped tables
 * (leave_type / holiday carry a tenant_id and NO company_id), so this runs ONCE per customer no
 * matter how many companies it has. Returns the created leave-type ids by code.
 */
export async function seedReferenceDataMY(tx: Tx, tenantId: string): Promise<Record<string, string>> {
  const leaveTypeIds: Record<string, string> = {};
  for (const lt of MY_LEAVE_TYPES) {
    const [row] = await tx
      .insert(leaveType)
      .values({
        tenantId,
        // ADR-0077 slice 5 — stated, never defaulted. A pack seeding through the column default would
        // attribute its rows to whatever the default happens to be, which is the whole failure the
        // country dimension exists to stop.
        country: 'MY',
        code: lt.code,
        name: lt.name,
        paid: lt.paid,
        counting: lt.counting,
        eligibility: lt.eligibility ?? null,
        requiresDocument: lt.requiresDocument ?? false,
        sendToPayroll: lt.sendToPayroll ?? !lt.paid,
        i18n: lt.i18n ?? null,
      })
      .returning({ id: leaveType.id });
    leaveTypeIds[lt.code] = row.id;
  }

  // National (state null = applies everywhere) then the state-specific subset (ADR-0038 2C).
  for (const h of MY_HOLIDAYS_2026) {
    await tx.insert(holiday).values({ tenantId, country: 'MY', state: null, holidayDate: h.date, name: h.name });
  }
  for (const h of MY_STATE_HOLIDAYS_2026) {
    await tx
      .insert(holiday)
      .values({ tenantId, country: 'MY', state: h.state ?? null, holidayDate: h.date, name: h.name });
  }

  return leaveTypeIds;
}
