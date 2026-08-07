import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { employeeEaCompanies, employeeEaStatement } from '@/core/reporting';
import { isAdmin, canManagePayroll } from '@/lib/authz';
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';
import { ToastFromQuery } from '@/components/ui/toast-trigger';
import { EaAmendPanel, type AmendField } from './ea-amend-panel';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({
  label,
  value,
  muted,
  amended,
  amendedLabel,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
  amended?: boolean;
  amendedLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={`flex items-center gap-2 ${muted ? 'text-muted-foreground' : ''}`}>
        {label}
        {amended && amendedLabel && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            {amendedLabel}
          </span>
        )}
      </span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export default async function EaStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ year?: string; company?: string }>;
}) {
  const { employmentId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employmentId)) notFound();
  const { year, company } = await searchParams;
  const yr = /^\d{4}$/.test(year ?? '') ? (year as string) : String(new Date().getFullYear());
  const s = await getSession(); // RLS-scopes the read to what this user may see

  // b7b22514 — AN EA FORM BELONGS TO ONE EMPLOYER, and after an Entity Transfer a year can span two. The
  // page renders one employer's form at a time (which is how it is printed and filed) and offers a
  // switcher when there is more than one, so nobody leaves with a partial tax record. An unrecognised
  // company id is ignored rather than honoured — showing the WRONG employer's figures is the failure here.
  const employers = await employeeEaCompanies(s, { employmentId, year: yr });
  const selected = employers.find((c) => c.companyId === company)?.companyId;
  const ea = await employeeEaStatement(s, { employmentId, year: yr, ...(selected ? { companyId: selected } : {}) });
  if (!ea) notFound();

  // The amend panel writes to ea_override, which is keyed (employment, year, field) with no company — so
  // it may only be offered on the employer whose form those rows actually overlay (the current one).
  const isCurrentEmployer = !selected || employers.some((c) => c.companyId === selected && c.isCurrent);

  const t = await getTranslations('payroll.ea');
  const canAmend = isAdmin(s) || canManagePayroll(s); // server gate for the "Amend EA figures" panel

  const CATEGORY: Record<number, string> = {
    1: t('category1'),
    2: t('category2'),
    3: t('category3'),
  };

  const period =
    ea.employee.hiredOn || ea.employee.terminatedOn
      ? `${ea.employee.hiredOn ?? '—'} → ${ea.employee.terminatedOn ?? t('present')}`
      : '—';

  // 1.2.6 — which Part B/D/E lines carry an HR amendment (drives the "Amended" badge + original tooltip).
  const ovByField = new Map(ea.overrides.map((o) => [o.field, o]));
  const amendedBadge = t('override.amendedBadge');
  // The amend panel's per-field rows: derived original + active amended value (null if none) + reason.
  const fieldLabels: Record<string, string> = {
    grossSalary: t('override.fieldGrossSalary'),
    bonus: t('override.fieldBonus'),
    allowances: t('override.fieldAllowances'),
    gross: t('override.fieldGross'),
    mtd: t('override.fieldMtd'),
    epf: t('override.fieldEpf'),
    socso: t('override.fieldSocso'),
    eis: t('override.fieldEis'),
  };
  const derivedFor: Record<string, number> = {
    grossSalary: ovByField.get('grossSalary')?.original ?? ea.partB.grossSalary,
    bonus: ovByField.get('bonus')?.original ?? ea.partB.bonus,
    allowances: ovByField.get('allowances')?.original ?? ea.partB.allowances,
    gross: ovByField.get('gross')?.original ?? ea.partB.gross,
    mtd: ovByField.get('mtd')?.original ?? ea.partD.mtd,
    epf: ovByField.get('epf')?.original ?? ea.partE.epf,
    socso: ovByField.get('socso')?.original ?? ea.partE.socso,
    eis: ovByField.get('eis')?.original ?? ea.partE.eis,
  };
  // #18 — the statutory EA fields reconciled against the year's filed CP39/agency total. For these, the
  // payroll-derived value IS the filed total (same payslip.statutory.* source), so filedTotal = derived.
  const STATUTORY_EA_FIELDS = new Set(['mtd', 'epf', 'socso', 'eis']);
  const amendFields: AmendField[] = (
    ['grossSalary', 'bonus', 'allowances', 'gross', 'mtd', 'epf', 'socso', 'eis'] as const
  ).map((field) => ({
    field,
    label: fieldLabels[field],
    original: derivedFor[field],
    amended: ovByField.get(field)?.amended ?? null,
    reason: ovByField.get(field)?.reason ?? null,
    statutory: STATUTORY_EA_FIELDS.has(field),
    filedTotal: STATUTORY_EA_FIELDS.has(field) ? derivedFor[field] : null,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/payroll/reports" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← {t('backToReports')}
        </Link>
        <PrintButton />
      </div>

      {/* b7b22514 — a transfer year has one form PER EMPLOYER. Shown only when there is genuinely more
          than one, so the ordinary single-employer year is visually unchanged. Without it the screen looks
          complete while holding half the employee's tax record. */}
      {employers.length > 1 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10 print:hidden">
          <p className="font-medium text-amber-900 dark:text-amber-200">{t('multiEmployer.title', { count: employers.length })}</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300/90">{t('multiEmployer.body')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {employers.map((c) => {
              const active = c.companyId === ea.employerId;
              return (
                <Link
                  key={c.companyId}
                  href={`/payroll/reports/ea/${employmentId}?year=${yr}&company=${c.companyId}`}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-amber-600 bg-amber-600 text-white'
                      : 'border-amber-400 bg-white text-amber-900 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200'
                  }`}
                >
                  {c.name}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <Card className="space-y-5 p-6">
        <div className="border-b border-border pb-4">
          <h1 className="text-lg font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('yearEnded', { year: ea.year, employer: ea.employer.name })}
            {ea.employer.eNumber ? ` · E ${ea.employer.eNumber}` : ''}
          </p>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionAEmployeeParticulars')}
          </h2>
          <Row label={t('name')} value={ea.employee.name} />
          <Row label={t('incomeTaxNo')} value={ea.employee.taxNo || '—'} />
          <Row label={t('icNo')} value={ea.employee.ic || '—'} />
          <Row label={t('epfNo')} value={ea.employee.epfNo || '—'} />
          <Row label={t('socsoNo')} value={ea.employee.socsoNo || '—'} />
          <Row label={t('mtdCategory')} value={CATEGORY[ea.employee.category] ?? ea.employee.category} />
          <Row label={t('childrenTaxRelief')} value={ea.employee.children} />
          <Row label={t('employmentPeriod')} value={period} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionBEmploymentIncome')}
          </h2>
          <Row label={t('grossSalary')} value={rm(ea.partB.grossSalary)} amended={ovByField.has('grossSalary')} amendedLabel={amendedBadge} />
          <Row label={t('bonus')} value={rm(ea.partB.bonus)} amended={ovByField.has('bonus')} amendedLabel={amendedBadge} />
          <Row label={t('allowancesPerquisites')} value={rm(ea.partB.allowances)} amended={ovByField.has('allowances')} amendedLabel={amendedBadge} />
          {/* Feedback 09b554e9 — the year's tax-exempt allowance portions (informational: already inside
              the allowances line; LHDN's EA reports exempt allowances in their own section). */}
          <Row label={t('exemptAllowances')} value={rm(ea.partB.exemptAllowances ?? 0)} muted />
          <Row label={t('benefitsInKind')} value={t('notTracked')} muted />
          <Row label={t('livingAccommodation')} value={t('notTracked')} muted />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span className="flex items-center gap-2">
              {t('totalGrossRemuneration')}
              {ovByField.has('gross') && (
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  {amendedBadge}
                </span>
              )}
            </span>
            <span className="tabular-nums">{rm(ea.partB.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionDTotalDeductions')}
          </h2>
          <Row label={t('monthlyTaxDeduction')} value={rm(ea.partD.mtd)} amended={ovByField.has('mtd')} amendedLabel={amendedBadge} />
          <Row label={t('cp38Deductions')} value={t('notTracked')} muted />
          {/* 1.2.4 Zakat — the year's accumulated zakat-via-salary (Z), now sourced from the payslips. */}
          <Row label={t('zakatViaSalary')} value={rm(ea.partD.zakat)} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionEContributions')}
          </h2>
          <Row label={t('epfKwsp')} value={rm(ea.partE.epf)} amended={ovByField.has('epf')} amendedLabel={amendedBadge} />
          <Row label={t('socso')} value={rm(ea.partE.socso)} amended={ovByField.has('socso')} amendedLabel={amendedBadge} />
          <Row label={t('eisSip')} value={rm(ea.partE.eis)} amended={ovByField.has('eis')} amendedLabel={amendedBadge} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionFTaxExempt')}
          </h2>
          <Row label={t('taxExemptAllowances')} value={t('notTracked')} muted />
        </section>

        {/* 1.2.6 — "Amended" note shown when ≥1 EA field was overwritten by HR (drives the same marker the
            PDF prints). */}
        {ea.overrides.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            {t('override.amendedNote')}
          </div>
        )}

        {/* CP8D / Form E adjacency note — overrides are EA-only; Form E figures stay payroll-derived. */}
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {t('formEUnaffectedNote')}
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          ℹ️ {t('disclaimer', { year: ea.year, version: ea.statutoryVersion })}
        </div>
      </Card>

      {/* Admin-only "Amend EA figures" panel (server-gated). Original vs amended + required reason + confirm. */}
      {canAmend && isCurrentEmployer && <EaAmendPanel employmentId={employmentId} year={yr} fields={amendFields} />}

      <ToastFromQuery />
    </div>
  );
}
