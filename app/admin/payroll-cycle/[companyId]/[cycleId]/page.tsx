import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { listCompanies } from '@/core/read';
import { listPayrollCycles } from '@/core/payroll-cycle';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { CycleForm } from '../../cycle-form';
import { copyCycleAction, deleteCycleAction, setActiveAction } from '../../actions';
import { cycleCompanyHref } from '../../nav';

/**
 * 6df24751 — ONE PAYROLL CYCLE, VIEW AND EDIT (step 3b).
 *
 * The company catalog's View and Edit both open THIS screen, because for a cycle they are the same job:
 * everything the row could show is here, and every field is editable in place. That is the plan's "each
 * one of those then has its own view and edit screen", and it is the shape app/admin/pay-components
 * already uses (its list links twice into ./[code] for the same reason).
 *
 * The three row actions that used to compete for space in the table live here instead, UNCHANGED in
 * behaviour: Copy to companies (still a checkbox list of the OTHER companies the admin manages, still
 * skipping duplicates and regular-conflicts per company), Activate / Deactivate, and the guarded Delete.
 * Moving them did not soften any of them — the same server actions run the same service calls.
 *
 * Back goes ONE step, to this company's catalog, carrying the company listing's search term.
 */
export default async function PayrollCycleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string; cycleId: string }>;
  searchParams: Promise<{ error?: string; q?: string }>;
}) {
  const { s, scopeIds } = await scopedAdmin();
  const t = await getTranslations('payrollCycleConfig');
  const { companyId, cycleId } = await params;
  const { error, q } = await searchParams;

  const all = await listCompanies(s);
  const companies = all.filter((c) => scopeIds.includes(c.id));
  const company = companies.find((c) => c.id === companyId);
  if (!company) notFound();

  // Archived cycles stay reachable — deactivating is not deleting, and the only path back to Activate is
  // this screen.
  const cycle = (await listPayrollCycles(s, company.id)).find((c) => c.id === cycleId) ?? null;
  if (!cycle) notFound();

  const active = cycle.archivedAt == null;
  // The OTHER companies this cycle can be copied into (everything the admin manages except this one).
  const otherCompanies = companies.filter((c) => c.id !== company.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={cycle.name}
        description={company.name}
        back={{ href: cycleCompanyHref(company.id, q), label: company.name }}
        actions={<Badge variant={active ? 'success' : 'default'}>{active ? t('active') : t('inactive')}</Badge>}
      />
      {error && <ErrorBanner message={error} />}

      <CycleForm companyId={company.id} companyName={company.name} cycle={cycle} q={q} />

      <Card>
        <SectionHeader title={t('manageTitle')} />
        <div className="space-y-5 p-4">
          {/* Activate / Deactivate — the archivedAt toggle, with the one-active-regular guard re-run by
              the service on activation exactly as before. */}
          <div className="flex flex-wrap items-center gap-3">
            <form action={setActiveAction}>
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="id" value={cycle.id} />
              <input type="hidden" name="q" value={q ?? ''} />
              <input type="hidden" name="active" value={active ? 'false' : 'true'} />
              <button className="text-sm font-medium text-primary hover:underline">
                {active ? t('deactivate') : t('activate')}
              </button>
            </form>
            <form action={deleteCycleAction}>
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="id" value={cycle.id} />
              <input type="hidden" name="q" value={q ?? ''} />
              <ConfirmSubmit
                title={t('deleteTitle')}
                description={t('deleteDescription', { name: cycle.name })}
                confirmLabel={t('delete')}
                size="sm"
              >
                {t('delete')}
              </ConfirmSubmit>
            </form>
          </div>

          {otherCompanies.length > 0 && (
            <form action={copyCycleAction} className="space-y-3 border-t border-border pt-4">
              <input type="hidden" name="companyId" value={company.id} />
              <input type="hidden" name="id" value={cycle.id} />
              <input type="hidden" name="q" value={q ?? ''} />
              <div>
                <p className="text-sm font-medium">{t('copyTitle', { name: cycle.name })}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('copyDescription')}</p>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {otherCompanies.map((oc) => (
                  <label key={oc.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="companyIds" value={oc.id} defaultChecked className="size-4 rounded" />
                    <span>{oc.name}</span>
                  </label>
                ))}
              </div>
              <button className={btnPrimary}>{t('copyConfirm')}</button>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
