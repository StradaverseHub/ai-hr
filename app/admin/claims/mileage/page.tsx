import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { getMileageClaimType, listMileageRateTables, MILEAGE_VEHICLE_CLASSES } from '@/core/claims';
import { listJobGrades } from '@/core/read';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls, pageWideCls } from '@/components/ui';
import { ClaimsTabs } from '@/components/claims-tabs';
import { setMileageRateTableAction } from './actions';

import { todayInKualaLumpur } from '@/lib/hr-date';

/** How many blank band rows to offer below the existing ones. A fixed set of rows keeps this whole screen a
 *  plain server-rendered form — no client island, so nothing crosses the RSC boundary. */
const BLANK_ROWS = 3;

/**
 * Mileage Rates — a REAL rate table, grade-scoped (e7eb5d83, the reporter's second question).
 *
 * What this replaces: one flat number per kilometre (`rate_config = {kind:'mileage_flat', ratePerKm}`)
 * buried inside a claim-limit row. It could not express "0.60 for the first 500km and 0.45 after that", had
 * no vehicle types, and had no effective date — so changing it changed what an already-filed claim would
 * recompute to.
 *
 * GRADE SCOPING IS THE SAME IDEA AS THE LIMITS, ON PURPOSE. Pick a grade, set that grade's bands; a grade
 * you do not set falls back to the company-wide table. One rule to learn rather than two, and in the engine
 * it is literally claim_policy's rule reused (resolveMileageRateBands), not a second copy of it.
 *
 * e7eb5d83 rev 4 point 5 — THE CLAIM-TYPE PILL ROW IS GONE. This screen no longer asks which claim type
 * it is configuring: it reads the one claim type marked as the mileage claim (claim_type.is_mileage),
 * which is the reporter's own "one special Claim Type can be designated as Mileage Claim". The old row
 * offered a wrong answer on every visit — bands saved against Medical would have priced nothing. When no
 * type is marked the screen says so and points at the tick, rather than silently falling back to types[0]
 * and writing a rate table onto whichever claim type happened to sort first.
 *
 * The grade PILLS became the same left rail Claim Limits uses, including its ?gradeId= selection and its
 * scope guard — 55 grades as a wrapped row of buttons was the complaint.
 *
 * e7eb5d83 rev 6 — FULL WIDTH, with the rest of the claim configuration module. This screen was not one
 * of the two the reporter named, but it carries the SAME grade rail beside the same kind of table, and a
 * module whose four screens disagree about their width is the drift pageWideCls exists to stop. Its band
 * tables keep their own `overflow-x-auto` wrappers for the same reason the limits grid does.
 *
 * Everything selectable lives in the URL (?gradeId= / ?vehicleClass=): this is a server component, so
 * client-held selection would mean either a function prop across the RSC boundary or a second fetch. Each
 * parameter is validated against what THIS admin's session can actually see and coerced to a safe default
 * otherwise — a forged, archived or other-tenant id resolves to company-wide rather than being queried.
 */
export default async function ClaimMileagePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; gradeId?: string; vehicleClass?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error, gradeId: rawGradeId, vehicleClass: rawClass } = await searchParams;
  const [selectedType, grades] = await Promise.all([getMileageClaimType(s), listJobGrades(s)]);
  const activeGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));

  // THE SCOPE GUARD, byte-for-byte the limits screen's: anything that is not one of THIS tenant's live
  // grades resolves to null = company-wide. listJobGrades is already tenant-scoped by RLS, so validating
  // against that list is the guard — a forged id can never select a grade the admin cannot see, and it
  // cannot 500 either.
  const selectedGradeId = activeGrades.some((g) => g.id === rawGradeId) ? (rawGradeId as string) : null;
  const selectedGrade = activeGrades.find((g) => g.id === selectedGradeId) ?? null;
  const vehicleClass = (MILEAGE_VEHICLE_CLASSES as readonly string[]).includes(rawClass ?? '')
    ? (rawClass as string)
    : 'any';

  const today = todayInKualaLumpur();
  const { tables } = selectedType
    ? await listMileageRateTables(s, { claimTypeId: selectedType.id, gradeId: selectedGradeId })
    : { tables: [] };
  const editing = tables.find((tb) => tb.vehicleClass === vehicleClass) ?? null;
  // An INHERITED table is shown for reference but is NOT loaded into the editor: pre-filling the form with
  // the company-wide numbers makes "save" look like a no-op when it actually creates a grade override.
  const editorBands = editing && !editing.inherited ? editing.bands : [];

  const href = (p: { gradeId?: string | null; vehicleClass?: string }): string => {
    const q = new URLSearchParams();
    const g = p.gradeId === undefined ? selectedGradeId : p.gradeId;
    if (g) q.set('gradeId', g);
    q.set('vehicleClass', p.vehicleClass ?? vehicleClass);
    return `/admin/claims/mileage?${q.toString()}`;
  };
  const pillCls = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:text-foreground'
    }`;
  // The Claim Limits left rail, reused verbatim so the two grade-scoped screens read the same way.
  const tabCls = (on: boolean) =>
    `block truncate rounded px-3 py-1.5 text-left text-sm transition-colors ${
      on ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
    }`;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('mileageTitle')} description={t('mileageSubtitle')} />
      <ClaimsTabs active="mileage" />
      <ErrorBanner message={error} />

      {selectedType == null ? (
        // No claim type is marked as the mileage claim. Deliberately an EMPTY STATE rather than a
        // fallback to the first claim type: bands saved against the wrong type price nothing, silently.
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t('noMileageType')}</p>
          <Link href="/admin/claims" className="mt-2 inline-block text-sm text-primary underline-offset-2 hover:underline">
            {t('noMileageTypeLink')}
          </Link>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_1fr]">
          <Card className="overflow-hidden">
            <SectionHeader title={t('gradesTitle')} count={activeGrades.length} />
            <nav className="max-h-[28rem] space-y-0.5 overflow-y-auto p-2">
              <Link href={href({ gradeId: null })} className={tabCls(selectedGradeId == null)}>
                {t('companyWide')}
              </Link>
              {activeGrades.map((g) => (
                <Link key={g.id} href={href({ gradeId: g.id })} className={tabCls(selectedGradeId === g.id)}>
                  {g.name}
                </Link>
              ))}
            </nav>
          </Card>

          <div className="space-y-4">
          <Card className="space-y-3 p-4">
            {/* Which claim type this screen configures is no longer a question — it is the one ticked as
                the mileage claim. Stated, not asked, so the admin can still see which type they are on. */}
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-xs font-medium text-muted-foreground">{t('claimTypeLabel')}</span>
              <span className="font-medium">{selectedType.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{selectedType.code}</span>
              <Link href="/admin/claims" className="ml-auto text-xs text-primary underline-offset-2 hover:underline">
                {t('mileageTypeChangeLink')}
              </Link>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('vehicleClassLabel')}</div>
              <div className="flex flex-wrap gap-1.5">
                {MILEAGE_VEHICLE_CLASSES.map((vc) => (
                  <Link key={vc} href={href({ vehicleClass: vc })} className={pillCls(vc === vehicleClass)}>
                    {t(`vehicleClass_${vc}` as 'vehicleClass_any')}
                  </Link>
                ))}
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionHeader
              title={`${selectedType.name} · ${selectedGrade ? selectedGrade.name : t('companyWide')}`}
              count={editing ? editing.bands.length : 0}
            />
            {editing == null ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">{t('noMileageTable')}</p>
            ) : (
              <div className="overflow-x-auto">
                {editing.inherited ? (
                  <p className="px-4 pt-3 text-xs text-amber-600 dark:text-amber-500">{t('mileageFallbackBadge')}</p>
                ) : null}
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('bandLabel')}</th>
                      <th className="px-4 py-2 font-medium">{t('ratePerKmLabel')}</th>
                      <th className="px-4 py-2 font-medium">{t('effectiveFromLabel')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {editing.bands.map((b) => (
                      <tr key={`${b.fromKm}-${b.toKm ?? 'up'}`} className="border-t border-border">
                        <td className="px-4 py-2.5 tabular-nums">
                          {b.toKm == null ? t('bandAndAbove', { from: b.fromKm }) : t('bandRange', { from: b.fromKm, to: b.toKm })}
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">RM {b.ratePerKm.toFixed(4)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{editing.validFrom}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-1 text-sm font-semibold">{t('mileageEditorTitle')}</h2>
            <p className="mb-3 text-xs text-muted-foreground">{t('mileageEditorHint')}</p>
            <form action={setMileageRateTableAction} className="space-y-3">
              <input type="hidden" name="claimTypeId" value={selectedType.id} />
              <input type="hidden" name="gradeId" value={selectedGradeId ?? ''} />
              <input type="hidden" name="vehicleClass" value={vehicleClass} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="pb-1 pr-3 font-medium">{t('fromKmLabel')}</th>
                      <th className="pb-1 pr-3 font-medium">{t('toKmLabel')}</th>
                      <th className="pb-1 font-medium">{t('ratePerKmLabel')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: editorBands.length + BLANK_ROWS }).map((_, i) => {
                      const b = editorBands[i];
                      return (
                        <tr key={i}>
                          <td className="py-1 pr-3">
                            <input name="fromKm" type="number" min="0" step="0.01" defaultValue={b ? b.fromKm : ''} className={`${inputCls} w-28`} />
                          </td>
                          <td className="py-1 pr-3">
                            <input
                              name="toKm"
                              type="number"
                              min="0"
                              step="0.01"
                              defaultValue={b && b.toKm != null ? b.toKm : ''}
                              placeholder={t('toKmOpenHint')}
                              className={`${inputCls} w-28`}
                            />
                          </td>
                          <td className="py-1">
                            <input name="ratePerKm" type="number" min="0" step="0.0001" defaultValue={b ? b.ratePerKm : ''} className={`${inputCls} w-32`} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <Field label={t('effectiveFromLabel')}>
                  <input name="effectiveFrom" type="date" required defaultValue={today} className={`${inputCls} w-44`} />
                </Field>
                <Button type="submit">{t('saveMileage')}</Button>
              </div>
              <p className="text-xs text-muted-foreground">{t('mileageBandsHint')}</p>
              <p className="text-xs text-muted-foreground">{t('mileageStampHint')}</p>
            </form>
          </Card>
          </div>
        </div>
      )}
    </div>
  );
}
