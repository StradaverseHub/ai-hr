import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import {
  listClaimLimits,
  listClaimLimitsForGrade,
  listClaimTypes,
  listMileageRateTables,
  type ClaimLimitValues,
} from '@/packs/claims/service';
import { listJobGrades } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import { ClaimLimitsGrid, type ClaimLimitGridRow, type ClaimLimitGridValues } from '@/components/claim-limits-grid';

import { todayInKualaLumpur } from '@/lib/hr-date';

/**
 * Claim Limits — GRADE-FIRST AND EDITABLE IN PLACE (e7eb5d83, rev 5 step 3).
 *
 * The previous version of this page rendered ONE flat table, claim type first and grade second, nine
 * columns wide. With production's 55 job grades × 4 claim types that is 220 possible rows in a single
 * scroll, and the measured consequence was that not one per-grade limit had ever been set. The grade rail
 * fixed the READING half. This round fixes the other half: the table itself is now the form, every claim
 * type AND every sub-claim has its own boxes, and one Save writes the lot for that grade.
 *
 * THE "Set a claim limit" CARD IS GONE, not hidden. It could only reach one claim type per save and could
 * not reach a sub-claim at all; leaving it beside the grid would be two ways to write the same row, which
 * is how a screen starts disagreeing with itself. Its component (components/claim-limit-editor.tsx) and
 * its action (setClaimPolicyAction) are deleted in the same change.
 *
 * SELECTION LIVES IN THE URL (?gradeId=), not in client state. Two reasons, both load-bearing:
 *   • This is a server component. Holding the selection in a client island would mean passing the grade
 *     list and a setter across the RSC boundary — the r123 500 — or duplicating the data fetch.
 *   • An unknown, archived or other-tenant gradeId must be COERCED TO "no selection" (the company-wide
 *     view) rather than queried. listJobGrades is already tenant-scoped by RLS, so validating the
 *     parameter against that list is the scope guard: a forged id can never select a grade the admin
 *     cannot see, and it cannot 500 either. test/claims-configurable.test.ts asserts that REFUSAL.
 */

/** Money/count → the string an <input type="number"> should be rendered with. Empty = no limit. */
const box = (n: number | null | undefined): string => (n == null ? '' : String(n));

function valuesOf(v: ClaimLimitValues | null): ClaimLimitGridValues {
  return {
    perClaimCap: box(v?.perClaimCap),
    monthlyLimit: box(v?.monthlyLimit),
    annualBudget: box(v?.annualBudget),
    // Per block is all-four-or-none, so the tick IS whether a rule exists. Length/unit keep sensible
    // defaults while unticked so enabling the tick does not present an empty, unanswerable rule.
    blockEnabled: v?.block != null,
    blockLimit: box(v?.block?.limit),
    blockLength: v?.block == null ? '1' : String(v.block.length),
    blockUnit: v?.block?.unit ?? 'year',
    maxClaimsPerYear: box(v?.maxClaimsPerYear),
  };
}

export default async function ClaimLimitsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; gradeId?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error, gradeId: rawGradeId } = await searchParams;
  const [types, grades, allLimits] = await Promise.all([listClaimTypes(s), listJobGrades(s), listClaimLimits(s)]);
  const activeGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));

  // THE SCOPE GUARD. Anything that is not one of THIS tenant's live grades resolves to null = company-wide.
  const selectedGradeId = activeGrades.some((g) => g.id === rawGradeId) ? (rawGradeId as string) : null;
  const selectedGrade = activeGrades.find((g) => g.id === selectedGradeId) ?? null;

  const rows = await listClaimLimitsForGrade(s, { gradeId: selectedGradeId });
  const today = todayInKualaLumpur();

  // Which grades already carry a limit of their own — the rail says so, so an admin can see at a glance
  // which of 55 grades have been configured instead of clicking through them.
  const gradesWithOwnRows = new Set(allLimits.map((l) => l.gradeId).filter((g): g is string => g != null));

  // ── STEP 4: THE MILEAGE TYPE CARRIES A RATE LINE INSTEAD OF SUB-CLAIMS ──
  // The reporter's second complaint was "RM1.00/km is sitting under Claim Limits". It is not a leftover
  // rate FIELD — r186 removed those — it is a claim_item they created in June named "RM1.00/km", listed
  // under Mileage beside their real sub-claims. Their actual per-km bands live on Mileage Rates. So the
  // mileage type shows a line pointing there and NO sub-claim rows at all. The item itself is NOT archived
  // or deleted: it is the reporter's data, and the plan says so explicitly.
  const mileageType = types.find((ct) => ct.isMileage) ?? null;
  const mileageBands = mileageType
    ? await listMileageRateTables(s, { claimTypeId: mileageType.id, gradeId: selectedGradeId })
    : { tables: [] };
  const bandText = (mileageBands.tables.find((tb) => tb.vehicleClass === 'any') ?? mileageBands.tables[0])?.bands
    .map((b) =>
      b.toKm == null
        ? `RM ${b.ratePerKm.toFixed(2)} (${t('bandAndAbove', { from: b.fromKm })})`
        : `RM ${b.ratePerKm.toFixed(2)} (${t('bandRange', { from: b.fromKm, to: b.toKm })})`,
    )
    .join(', ') ?? '';

  const gridRows: ClaimLimitGridRow[] = [];
  for (const r of rows) {
    const isMileage = mileageType != null && r.claimTypeId === mileageType.id;
    // Sub-claims are suppressed on the mileage type — a per-km rate has no money limit of its own, and
    // rendering the item as an editable limit row is exactly what the reporter objected to.
    const subs = isMileage ? [] : r.items;
    gridRows.push({
      key: `${r.claimTypeId}:`,
      claimTypeId: r.claimTypeId,
      claimItemId: null,
      name: r.typeName,
      code: r.typeCode,
      depth: 0,
      inherited: r.source === 'company' && selectedGradeId != null,
      values: valuesOf(r.effective),
      hint: isMileage ? { kind: 'mileage', bands: bandText } : null,
    });
    subs.forEach((it, i) => {
      gridRows.push({
        key: `${r.claimTypeId}:${it.id}`,
        claimTypeId: r.claimTypeId,
        claimItemId: it.id,
        name: it.name,
        code: it.code,
        depth: 1,
        inherited: it.source === 'company' && selectedGradeId != null,
        values: valuesOf(it.effective),
        // The sentence hangs off the LAST sub-claim of the type, so it reads as a footnote to the group
        // rather than interrupting it: a sub-limit is an EXTRA pot, not a replacement for its parent's.
        hint: i === subs.length - 1 ? { kind: 'sub', typeName: r.typeName } : null,
      });
    });
  }

  const tabCls = (on: boolean) =>
    `flex items-center justify-between gap-2 truncate rounded px-3 py-1.5 text-left text-sm transition-colors ${
      on ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    }`;
  const setMark = (
    <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {t('gridGradeSet')}
    </span>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title={t('limitsTitle')} description={t('limitsSubtitle')} />
      <ClaimsTabs active="limits" />
      <ErrorBanner message={error} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
        <Card className="overflow-hidden">
          <SectionHeader title={t('gradesTitle')} count={activeGrades.length} />
          <nav className="max-h-[28rem] space-y-0.5 overflow-y-auto p-2">
            <Link href="/admin/claims/limits" className={tabCls(selectedGradeId == null)}>
              <span className="truncate">{t('companyWide')}</span>
              {allLimits.some((l) => l.gradeId == null) ? setMark : null}
            </Link>
            {activeGrades.map((g) => (
              <Link
                key={g.id}
                href={`/admin/claims/limits?gradeId=${encodeURIComponent(g.id)}`}
                className={tabCls(selectedGradeId === g.id)}
              >
                <span className="truncate">{g.name}</span>
                {gradesWithOwnRows.has(g.id) ? setMark : null}
              </Link>
            ))}
          </nav>
        </Card>

        <Card className="overflow-hidden">
          <SectionHeader title={selectedGrade ? selectedGrade.name : t('companyWide')} />
          {gridRows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ClaimLimitsGrid
              rows={gridRows}
              gradeId={selectedGradeId}
              gradeLabel={selectedGrade ? selectedGrade.name : t('companyWide')}
              today={today}
              mileageHref={
                selectedGradeId
                  ? `/admin/claims/mileage?gradeId=${encodeURIComponent(selectedGradeId)}`
                  : '/admin/claims/mileage'
              }
            />
          )}
        </Card>
      </div>
    </div>
  );
}
