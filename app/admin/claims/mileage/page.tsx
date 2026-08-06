import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { listClaimTypes, listMileageRateTables, MILEAGE_VEHICLE_CLASSES } from '@/core/claims';
import { listJobGrades } from '@/core/read';
import { Button, Card, ErrorBanner, Field, PageHeader, SectionHeader, inputCls } from '@/components/ui';
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
 * Everything selectable lives in the URL (?claimTypeId= / ?gradeId= / ?vehicleClass=): this is a server
 * component, so client-held selection would mean either a function prop across the RSC boundary or a second
 * fetch. Each parameter is validated against what THIS admin's session can actually see and coerced to a
 * safe default otherwise — a forged id selects nothing rather than 500ing or reaching another tenant.
 */
export default async function ClaimMileagePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; claimTypeId?: string; gradeId?: string; vehicleClass?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('admin.claims');
  const { error, claimTypeId: rawTypeId, gradeId: rawGradeId, vehicleClass: rawClass } = await searchParams;
  const [types, grades] = await Promise.all([listClaimTypes(s), listJobGrades(s)]);
  const activeGrades = grades.filter((g) => !g.archivedAt).map((g) => ({ id: g.id, name: g.name }));

  // THE SCOPE GUARDS. Each parameter is only honoured if it names something this session can already see.
  const selectedType = types.find((ct) => ct.id === rawTypeId) ?? types[0] ?? null;
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

  const href = (p: { claimTypeId?: string; gradeId?: string | null; vehicleClass?: string }): string => {
    const q = new URLSearchParams();
    q.set('claimTypeId', p.claimTypeId ?? selectedType?.id ?? '');
    const g = p.gradeId === undefined ? selectedGradeId : p.gradeId;
    if (g) q.set('gradeId', g);
    q.set('vehicleClass', p.vehicleClass ?? vehicleClass);
    return `/admin/claims/mileage?${q.toString()}`;
  };
  const pillCls = (on: boolean) =>
    `rounded-full border px-3 py-1 text-xs transition-colors ${
      on ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('mileageTitle')} description={t('mileageSubtitle')} />
      <ClaimsTabs active="mileage" />
      <ErrorBanner message={error} />

      {selectedType == null ? (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </Card>
      ) : (
        <>
          <Card className="space-y-3 p-4">
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('claimTypeLabel')}</div>
              <div className="flex flex-wrap gap-1.5">
                {types.map((ct) => (
                  <Link key={ct.id} href={href({ claimTypeId: ct.id })} className={pillCls(ct.id === selectedType.id)}>
                    {ct.name}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              {/* The grade selector the reporter asked for, sitting ABOVE the table exactly as the plan says. */}
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('gradeLabel')}</div>
              <div className="flex flex-wrap gap-1.5">
                <Link href={href({ gradeId: null })} className={pillCls(selectedGradeId == null)}>
                  {t('companyWide')}
                </Link>
                {activeGrades.map((g) => (
                  <Link key={g.id} href={href({ gradeId: g.id })} className={pillCls(selectedGradeId === g.id)}>
                    {g.name}
                  </Link>
                ))}
              </div>
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
        </>
      )}
    </div>
  );
}
