'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ServiceBand } from '@/core/leave-compute';
import { Badge, Button, Field, btnPrimary, inputCls } from '@/components/ui';

/**
 * Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b) — the client subsection rendered
 * AFTER the Grade catalog on the Entitlements tab. Three managers, all posting to server actions:
 *   1. Grade Groups — name + which grades belong (a grade lives in one group). Groups let a scheme cover
 *      several grades at once (e.g. "Grade 12–15").
 *   2. Benefit Schemes — Company × Employment Type × Grade Group × Name × Status. Employees auto-match to
 *      an active scheme by those axes (with a manual override on the employee record).
 *   3. Leave Entitlements — per scheme, one row per leave type with the days for three service tiers
 *      (< N1 years, N1–N2 years, ≥ N2 years). Serialised into contiguous ServiceBands (the SAME shape the
 *      engine resolves via bandDaysFor), so the day-counting engine is reused unchanged.
 * The existing Grade config above is untouched.
 */

type Company = { id: string; name: string };
type Grade = { id: string; name: string; code: string };
type LeaveType = { id: string; name: string; code: string };
type GradeGroup = { id: string; name: string; gradeIds: string[]; archived: boolean };
type Scheme = {
  id: string;
  companyId: string;
  employmentType: string;
  gradeGroupId: string | null;
  gradeGroupName: string | null;
  name: string;
  status: string;
};
type Entitlement = {
  id: string;
  benefitSchemeId: string;
  leaveTypeId: string;
  leaveTypeName: string | null;
  serviceBands: ServiceBand[];
};

type Actions = {
  createGradeGroup: (fd: FormData) => void | Promise<void>;
  updateGradeGroup: (fd: FormData) => void | Promise<void>;
  deleteGradeGroup: (fd: FormData) => void | Promise<void>;
  createScheme: (fd: FormData) => void | Promise<void>;
  updateScheme: (fd: FormData) => void | Promise<void>;
  deleteScheme: (fd: FormData) => void | Promise<void>;
  upsertEntitlement: (fd: FormData) => void | Promise<void>;
  deleteEntitlement: (fd: FormData) => void | Promise<void>;
};

const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;

/** Read the three-tier day figures + thresholds out of a stored ServiceBand[]. Falls back to a blank
 *  0/2/5 template so a fresh entitlement renders sensible defaults. Defensive: any odd shape → template. */
function tiersFromBands(bands: ServiceBand[]): { n1: number; n2: number; d0: string; d1: string; d2: string } {
  if (Array.isArray(bands) && bands.length === 3 && bands[0].toYears != null && bands[1].toYears != null) {
    return {
      n1: Number(bands[0].toYears),
      n2: Number(bands[1].toYears),
      d0: String(bands[0].days ?? ''),
      d1: String(bands[1].days ?? ''),
      d2: String(bands[2].days ?? ''),
    };
  }
  return { n1: 2, n2: 5, d0: '', d1: '', d2: '' };
}

export function BenefitSchemeConfig({
  companies,
  grades,
  leaveTypes,
  gradeGroups,
  schemes,
  entitlements,
  actions,
}: {
  companies: Company[];
  grades: Grade[];
  leaveTypes: LeaveType[];
  gradeGroups: GradeGroup[];
  schemes: Scheme[];
  entitlements: Entitlement[];
  actions: Actions;
}) {
  const t = useTranslations('admin.benefitScheme');
  const companyName = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);
  const groupName = useMemo(() => new Map(gradeGroups.map((g) => [g.id, g.name])), [gradeGroups]);
  const activeGroups = gradeGroups.filter((g) => !g.archived);
  const empTypeLabel = (v: string) => t(`empType_${v}` as `empType_${(typeof EMPLOYMENT_TYPES)[number]}`);

  const [selectedSchemeId, setSelectedSchemeId] = useState<string>(schemes[0]?.id ?? '');
  const selectedEnts = entitlements.filter((e) => e.benefitSchemeId === selectedSchemeId);

  // R44 8d422204: client-side A–Z / Z–A sort of the entitlements table by leave-type name. Display-order
  // only — re-sorts automatically on add/update/delete via re-render. Default ascending.
  const [entSort, setEntSort] = useState<'asc' | 'desc'>('asc');
  const sortedEnts = useMemo(() => {
    const copy = [...selectedEnts];
    copy.sort((a, b) => (a.leaveTypeName ?? '').localeCompare(b.leaveTypeName ?? ''));
    if (entSort === 'desc') copy.reverse();
    return copy;
  }, [selectedEnts, entSort]);

  // The three service-band column headers interpolate the scheme's ACTUAL configured thresholds
  // (feedback 0aa304a1) rather than the old literal "N1"/"N2" placeholders. Thresholds live per
  // entitlement in serviceBands (n1 = bands[0].toYears, n2 = bands[1].toYears; the top band's
  // toYears is null → open-ended "{n2} years and over"). Since the headers are shared across all
  // rows of the selected scheme but each row's stored bands MAY differ, we derive the header pair
  // from the first entitlement of the selected scheme (tiersFromBands is defensive: any odd/empty
  // shape falls back to the 2/5 default). Presentation only — no entitlement value changes.
  const headerTiers = selectedEnts.length > 0 ? tiersFromBands(selectedEnts[0].serviceBands) : { n1: 2, n2: 5 };

  return (
    <div className="space-y-8" data-tour="benefit-scheme">
      {/* ── Grade Groups ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('groupsTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('groupsHelp')}</p>
        </div>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {gradeGroups.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t('noGroups')}</li>
          )}
          {gradeGroups.map((g) => (
            <li key={g.id} className="px-3 py-2.5">
              <details>
                <summary className="flex cursor-pointer items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    {g.name}
                    {g.archived && <Badge variant="warning">{t('archived')}</Badge>}
                    <span className="text-xs font-normal text-muted-foreground">
                      {t('memberCount', { count: g.gradeIds.length })}
                    </span>
                  </span>
                </summary>
                <div className="mt-3 space-y-3">
                  <form action={actions.updateGradeGroup} className="space-y-3">
                    <input type="hidden" name="id" value={g.id} />
                    <Field label={t('groupNameLabel')}>
                      <input name="name" defaultValue={g.name} required className={inputCls} />
                    </Field>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {grades.map((gr) => (
                          <label key={gr.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
                            <input
                              type="checkbox"
                              name="gradeIds"
                              value={gr.id}
                              defaultChecked={g.gradeIds.includes(gr.id)}
                              className="size-3.5 rounded"
                            />
                            {gr.name}
                          </label>
                        ))}
                        {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="submit" size="sm">{t('save')}</Button>
                    </div>
                  </form>
                  <form action={actions.deleteGradeGroup}>
                    <input type="hidden" name="id" value={g.id} />
                    <Button type="submit" variant="ghost" size="sm">{t('delete')}</Button>
                  </form>
                </div>
              </details>
            </li>
          ))}
        </ul>
        <form action={actions.createGradeGroup} className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3">
          <Field label={t('groupNameLabel')}>
            <input name="name" required placeholder={t('groupNamePlaceholder')} className={`${inputCls} w-56`} />
          </Field>
          <div className="min-w-0">
            <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {grades.map((gr) => (
                <label key={gr.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
                  <input type="checkbox" name="gradeIds" value={gr.id} className="size-3.5 rounded" />
                  {gr.name}
                </label>
              ))}
              {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
            </div>
          </div>
          <button className={btnPrimary}>{t('addGroup')}</button>
        </form>
      </section>

      {/* ── Benefit Schemes ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('schemesTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('schemesHelp')}</p>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('colCompany')}</th>
                <th className="px-3 py-2 font-medium">{t('colEmpType')}</th>
                <th className="px-3 py-2 font-medium">{t('colGradeGroup')}</th>
                <th className="px-3 py-2 font-medium">{t('colName')}</th>
                <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {schemes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">{t('noSchemes')}</td>
                </tr>
              )}
              {schemes.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-3 py-2">{companyName.get(s.companyId) ?? '—'}</td>
                  <td className="px-3 py-2">{empTypeLabel(s.employmentType)}</td>
                  <td className="px-3 py-2">{s.gradeGroupId ? (groupName.get(s.gradeGroupId) ?? '—') : t('anyGroup')}</td>
                  <td className="px-3 py-2 font-medium">{s.name}</td>
                  <td className="px-3 py-2">
                    <Badge variant={s.status === 'active' ? 'success' : 'default'}>
                      {t(s.status === 'active' ? 'statusActive' : 'statusInactive')}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    <details>
                      <summary className="cursor-pointer text-xs text-primary">{t('edit')}</summary>
                      <div className="mt-2 space-y-2">
                        <SchemeForm
                          action={actions.updateScheme}
                          companies={companies}
                          groups={activeGroups}
                          empTypeLabel={empTypeLabel}
                          t={t}
                          scheme={s}
                        />
                        <form action={actions.deleteScheme}>
                          <input type="hidden" name="id" value={s.id} />
                          <Button type="submit" variant="ghost" size="sm">{t('delete')}</Button>
                        </form>
                      </div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t('addScheme')}</p>
          <SchemeForm
            action={actions.createScheme}
            companies={companies}
            groups={activeGroups}
            empTypeLabel={empTypeLabel}
            t={t}
            scheme={null}
          />
        </div>
      </section>

      {/* ── Leave Entitlements per scheme ────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('entTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('entHelp')}</p>
        </div>
        {schemes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('entNeedsScheme')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label={t('selectScheme')}>
                <select
                  value={selectedSchemeId}
                  onChange={(e) => setSelectedSchemeId(e.target.value)}
                  className={`${inputCls} w-72`}
                >
                  {schemes.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={t('entSortLabel')}>
                <select
                  value={entSort}
                  onChange={(e) => setEntSort(e.target.value as 'asc' | 'desc')}
                  className={`${inputCls} w-48`}
                >
                  <option value="asc">{t('entSortAsc')}</option>
                  <option value="desc">{t('entSortDesc')}</option>
                </select>
              </Field>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t('colLeaveType')}</th>
                    <th className="px-3 py-2 font-medium">{t('tierUnder', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                    <th className="px-3 py-2 font-medium">{t('tierMid', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                    <th className="px-3 py-2 font-medium">{t('tierOver', { n1: headerTiers.n1, n2: headerTiers.n2 })}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {selectedEnts.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">{t('noEntitlements')}</td>
                    </tr>
                  )}
                  {sortedEnts.map((e) => {
                    const ti = tiersFromBands(e.serviceBands);
                    return (
                      <tr key={e.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 font-medium">{e.leaveTypeName ?? '—'}</td>
                        <td className="px-3 py-2">{ti.d0 || '0'}</td>
                        <td className="px-3 py-2">{ti.d1 || '0'}</td>
                        <td className="px-3 py-2">{ti.d2 || '0'}</td>
                        <td className="px-3 py-2 text-right">
                          <form action={actions.deleteEntitlement} className="inline">
                            <input type="hidden" name="id" value={e.id} />
                            <Button type="submit" variant="ghost" size="sm">{t('delete')}</Button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <EntitlementForm
              action={actions.upsertEntitlement}
              schemeId={selectedSchemeId}
              leaveTypes={leaveTypes}
              t={t}
            />
          </>
        )}
      </section>
    </div>
  );
}

function SchemeForm({
  action,
  companies,
  groups,
  empTypeLabel,
  t,
  scheme,
}: {
  action: (fd: FormData) => void | Promise<void>;
  companies: Company[];
  groups: GradeGroup[];
  empTypeLabel: (v: string) => string;
  t: ReturnType<typeof useTranslations>;
  scheme: Scheme | null;
}) {
  return (
    <form action={action} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6 lg:items-end">
      {scheme && <input type="hidden" name="id" value={scheme.id} />}
      <Field label={t('colCompany')}>
        <select name="companyId" defaultValue={scheme?.companyId ?? ''} required className={inputCls}>
          <option value="" disabled>{t('selectPlaceholder')}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('colEmpType')}>
        <select name="employmentType" defaultValue={scheme?.employmentType ?? 'full_time'} className={inputCls}>
          {EMPLOYMENT_TYPES.map((v) => (
            <option key={v} value={v}>{empTypeLabel(v)}</option>
          ))}
        </select>
      </Field>
      <Field label={t('colGradeGroup')}>
        <select name="gradeGroupId" defaultValue={scheme?.gradeGroupId ?? ''} className={inputCls}>
          <option value="">{t('anyGroup')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </Field>
      <Field label={t('colName')}>
        <input name="name" defaultValue={scheme?.name ?? ''} required placeholder={t('schemeNamePlaceholder')} className={inputCls} />
      </Field>
      <Field label={t('colStatus')}>
        <select name="status" defaultValue={scheme?.status ?? 'active'} className={inputCls}>
          <option value="active">{t('statusActive')}</option>
          <option value="inactive">{t('statusInactive')}</option>
        </select>
      </Field>
      <Button type="submit" size="sm">{scheme ? t('save') : t('addScheme')}</Button>
    </form>
  );
}

function EntitlementForm({
  action,
  schemeId,
  leaveTypes,
  t,
}: {
  action: (fd: FormData) => void | Promise<void>;
  schemeId: string;
  leaveTypes: LeaveType[];
  t: ReturnType<typeof useTranslations>;
}) {
  // Fixed three-band day entry (R44 6421c888): service bands are hardcoded at 0–2 / 2–5 / 5+ years — HR
  // types the days directly into each predefined range, no tier-cutoff inputs. The 0/2/5 shape satisfies
  // validateBands and is the SAME contiguous ServiceBand[] the resolver reads. Legacy rows stored with other
  // cutoffs keep their own values + calculate correctly (read-side table derives each row's own labels).
  const [d0, setD0] = useState('');
  const [d1, setD1] = useState('');
  const [d2, setD2] = useState('');

  // R44 3d2ac99f: always present the Leave Type options alphabetically (A–Z by name) for predictable
  // scanning. Active-only filtering already happens upstream (activeTypeOptions); this is display-order only.
  const sortedLeaveTypes = useMemo(
    () => [...leaveTypes].sort((a, b) => a.name.localeCompare(b.name)),
    [leaveTypes],
  );

  const bands: ServiceBand[] = [
    { fromYears: 0, toYears: 2, days: Number(d0) || 0 },
    { fromYears: 2, toYears: 5, days: Number(d1) || 0 },
    { fromYears: 5, toYears: null, days: Number(d2) || 0 },
  ];

  return (
    <form action={action} className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <input type="hidden" name="benefitSchemeId" value={schemeId} />
      <input type="hidden" name="serviceBands" value={JSON.stringify(bands)} />
      <p className="text-xs font-medium text-muted-foreground">{t('addEntitlement')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <Field label={t('colLeaveType')}>
          <select name="leaveTypeId" required defaultValue="" className={inputCls}>
            <option value="" disabled>{t('selectPlaceholder')}</option>
            {sortedLeaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>{lt.name}</option>
            ))}
          </select>
        </Field>
        <Field label={t('tierUnderFixed')}>
          <input type="number" min={0} step="0.5" value={d0} onChange={(e) => setD0(e.target.value)} className={`${inputCls} w-20`} />
        </Field>
        <Field label={t('tierMidFixed')}>
          <input type="number" min={0} step="0.5" value={d1} onChange={(e) => setD1(e.target.value)} className={`${inputCls} w-20`} />
        </Field>
        <Field label={t('tierOverFixed')}>
          <input type="number" min={0} step="0.5" value={d2} onChange={(e) => setD2(e.target.value)} className={`${inputCls} w-20`} />
        </Field>
      </div>
      <Button type="submit" size="sm">{t('saveEntitlement')}</Button>
    </form>
  );
}
