'use client';

/**
 * Leave Entitlement Rules Engine — live, read-only preview. Runs the EXACT SAME pure resolver
 * (`previewEntitlement` → `resolveGradePolicy`) the server engines use, imported from core/leave-compute
 * (RSC-safe: no db import) so this can never disagree with a real grant. The statutory floor is imported
 * directly from localization/my/leave (pure — its only import is a type), NOT the full pack registry
 * (localization/registry → localization/my/index pulls in db/client via statutory-config — NOT client-safe).
 * Only one country pack exists today (MY); if a second pack lands, this must switch to a client-safe
 * registry rather than hardcoding MY here.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { previewEntitlement, type GradePolicyRow } from '@/core/leave-compute';
import { entitlement as myEntitlement } from '@/localization/my/leave';
import { Field, inputCls } from './ui';

export type PreviewLeaveTypeOption = { id: string; name: string; code: string };
export type PreviewCompanyOption = { id: string; name: string; country: string };
export type PreviewGradeOption = { id: string; name: string };
/** One policy row as loaded by the admin page — same shape listLeavePolicies already returns. */
export type PreviewPolicyRow = {
  leaveTypeId: string;
  gradeId: string | null;
  companyId: string | null;
  accrual: unknown;
};

export function LeaveRulePreview({
  leaveTypes,
  companies,
  grades,
  policies,
}: {
  leaveTypes: PreviewLeaveTypeOption[];
  companies: PreviewCompanyOption[];
  grades: PreviewGradeOption[];
  policies: PreviewPolicyRow[];
}) {
  const t = useTranslations('admin.leave');
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? '');
  const [companyId, setCompanyId] = useState(companies[0]?.id ?? '');
  const [gradeId, setGradeId] = useState('');
  const [serviceYears, setServiceYears] = useState(0);

  const type = leaveTypes.find((lt) => lt.id === leaveTypeId);
  const company = companies.find((c) => c.id === companyId);

  const result = useMemo(() => {
    if (!type || !company) return null;
    const rows: GradePolicyRow[] = policies
      .filter((p) => p.leaveTypeId === leaveTypeId)
      .map((p) => ({ gradeId: p.gradeId, companyId: p.companyId, accrual: p.accrual }));
    // Floor source: MY pack only (see header comment) — any other country has no client-safe floor.
    const floorDays = company.country === 'MY' ? myEntitlement(type.code, Math.max(0, serviceYears)) : null;
    return previewEntitlement(rows, gradeId || null, companyId || null, Math.max(0, serviceYears), floorDays);
  }, [type, company, policies, leaveTypeId, gradeId, companyId, serviceYears]);

  return (
    <div className="space-y-3 rounded-lg bg-background p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('previewLeaveTypeLabel')}>
          <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} className={`${inputCls} w-44`}>
            {leaveTypes.map((lt) => (
              <option key={lt.id} value={lt.id}>
                {lt.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('previewCompanyLabel')}>
          <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={`${inputCls} w-44`}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('previewGradeLabel')}>
          <select value={gradeId} onChange={(e) => setGradeId(e.target.value)} className={`${inputCls} w-40`}>
            <option value="">{t('gradeAll')}</option>
            {grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('previewServiceYearsLabel')}>
          <input
            type="number"
            min="0"
            step="1"
            value={serviceYears}
            onChange={(e) => setServiceYears(Number(e.target.value) || 0)}
            className={`${inputCls} w-24`}
          />
        </Field>
      </div>

      {!company ? (
        <p className="text-xs text-muted-foreground">{t('previewNoCompany')}</p>
      ) : result ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs">
          <span className="font-semibold tabular-nums text-foreground">
            {t('previewResultDays', { days: result.days })}
          </span>
          <span className="text-muted-foreground">
            {t('previewFloorDays', { days: result.floorDays ?? '—' })}
          </span>
          <span className="text-muted-foreground">
            {t('previewPolicyDays', { days: result.policyDays ?? '—' })}
          </span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {result.floorApplied ? t('previewWinnerFloor') : t('previewWinnerPolicy')}
          </span>
          {company.country !== 'MY' && <span className="text-muted-foreground">{t('previewNoPack')}</span>}
        </div>
      ) : null}
    </div>
  );
}
