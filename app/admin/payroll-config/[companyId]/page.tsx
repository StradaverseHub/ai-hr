import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedSession } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { getPayrollConfig } from '@/core/payroll-config';
import { listAssignablePolicies } from '@/core/payroll-policy';
import { packFor } from '@/localization/registry';
import type { PayslipRelease } from '@/db/schema';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary } from '@/components/ui';
import { configEditHref, configListHref } from '../nav';

/**
 * Pay Schedule — ONE COMPANY, READ-ONLY (feedback 6df24751, step 2 of the company-first route).
 *
 * Everything this company's payroll timing holds, on one screen, in the order the form saves it:
 * schedule → default policy & payslip release → per-transaction-type cut-offs → statutory registration.
 * Nothing is editable here; Edit opens ./edit.
 *
 * THE STATUTORY BLOCK MOVED HERE UNCHANGED, and its read-only-ness is the point, not a side effect of the
 * move (r79a 4fb8b75a step 4): the company statutory record has ONE owner, Organization → Statutory. It
 * used to be editable from this screen AND from Organization with no coordination between them, so
 * whichever saved last silently won. No input names are rendered on any of the three Pay Schedule routes,
 * so the action cannot receive statutory fields even from a hand-crafted POST — and
 * test/payroll-settings-relocation.test.ts pins that on this file, the one that now owns the block.
 *
 * Guard unchanged (`scopedSession`) — see the listing's docblock.
 */

const HRDF = ['not_registered', 'mandatory', 'optional'] as const;

export default async function PayrollConfigCompanyPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedSession();
  const t = await getTranslations('payrollConfig');
  const { companyId } = await params;
  const { error, q } = await searchParams;

  const all = await listCompanies(s);
  const company = all.find((c) => c.id === companyId && scopeIds.includes(c.id));
  if (!company) notFound();

  const cfg = await getPayrollConfig(s, company.id);
  // Rung 5c — company statutory read via the pack registry (ADR-0080 D1), not a direct import.
  const stat = (await packFor('MY')?.companyStatutory.get(s, company.id)) ?? null;
  const policies = await listAssignablePolicies(s, company.id);
  const release = (cfg?.payslipRelease ?? null) as PayslipRelease | null;
  const releaseMode = release?.mode ?? 'immediate';
  const releaseValue =
    release?.mode === 'fixed_day' ? release.day : release?.mode === 'relative' ? release.offsetDays : null;
  const defaultPolicyName =
    policies.find((p) => p.id === cfg?.defaultPayrollPolicyId)?.name ?? t('defaultPolicyNone');

  // Blank means month-end everywhere on this screen, exactly as the form's placeholder has always said.
  const day = (v: number | null | undefined) => (v == null ? t('monthEnd') : String(v));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={company.name}
        description={t('viewDescription')}
        back={{ href: configListHref(q), label: t('title') }}
        actions={
          <Link href={configEditHref(company.id, q)} className={btnPrimary}>
            {t('edit')}
          </Link>
        }
      />
      {error && <ErrorBanner message={error} />}

      <Card>
        <SectionHeader title={t('scheduleTitle')} />
        <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Row label={t('cutOffDay')} value={day(cfg?.cutOffDay)} />
          <Row label={t('payDay')} value={day(cfg?.payDay)} />
        </dl>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('dayHint')}</p>
      </Card>

      <Card>
        <SectionHeader title={t('policyReleaseTitle')} />
        <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
          <Row label={t('defaultPolicy')} value={defaultPolicyName} />
          <Row label={t('releaseMode')} value={t(`release_${releaseMode}`)} />
          <Row label={t('releaseValue')} value={releaseValue == null ? '—' : String(releaseValue)} />
        </dl>
        <div className="px-4 pb-4">
          <p className="text-xs text-muted-foreground">{t('defaultPolicyHint')}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('releaseHint')}</p>
        </div>
      </Card>

      <Card>
        <SectionHeader title={t('cutOffsTitle')} />
        <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          <Row label={t('overtimeCutOff')} value={day(cfg?.overtimeCutOffDay)} />
          <Row label={t('claimCutOff')} value={day(cfg?.claimCutOffDay)} />
          <Row label={t('unpaidLeaveCutOff')} value={day(cfg?.unpaidLeaveCutOffDay)} />
          <Row label={t('attendanceCutOff')} value={day(cfg?.attendanceCutOffDay)} />
        </dl>
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t('cutOffsHint')}</p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pr-4">
          <SectionHeader title={t('statutoryTitle')} />
          <Link href="/admin/organization" className="text-xs font-medium text-primary hover:underline">
            {t('statutoryEditInOrganization')} →
          </Link>
        </div>
        <dl className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
          {[
            { label: t('hrdfStatus'), value: t(`hrdf_${HRDF.includes(stat?.hrdfStatus as never) ? (stat?.hrdfStatus as string) : 'not_registered'}`) },
            { label: t('epfEmployerNo'), value: stat?.epfEmployerNo },
            { label: t('socsoEmployerCode'), value: stat?.socsoEmployerCode },
            { label: t('lhdnEmployerNo'), value: stat?.lhdnEmployerNo },
            { label: t('myinvoisTin'), value: stat?.myinvoisTin },
            { label: t('ssmRegistrationNo'), value: stat?.ssmRegistrationNo },
          ].map((row) => (
            <Row key={row.label} label={row.label} value={row.value || t('statutoryNotSet')} />
          ))}
        </dl>
        <div className="px-4 pb-4">
          <p className="text-xs text-muted-foreground">{t('statutoryReadOnlyHint')}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{t('hrdfHint')}</p>
        </div>
      </Card>

      {/* Step 3 (4fb8b75a) — signposts for the three settings that LEFT this screen, so an admin who came
          here looking for them is told where they went rather than finding a gap. */}
      <p className="text-xs text-muted-foreground">
        {t('movedSettingsHint')}{' '}
        <Link href="/admin/settings/hiring-defaults" className="font-medium text-primary hover:underline">
          {t('movedHiringLink')}
        </Link>
        {' · '}
        <Link href="/admin/organization" className="font-medium text-primary hover:underline">
          {t('movedCurrencyLink')}
        </Link>
      </p>
    </div>
  );
}

/** One read-only label/value pair. Local to this file — it is the shape of THIS screen, not a UI kit item. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{value}</dd>
    </div>
  );
}
