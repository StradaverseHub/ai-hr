import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { isOperator } from '@/lib/authz';
import { isDemoDeployment } from '@/lib/demo-mode';
import { listProvisionRequests, PROVISION_STEPS } from '@/core/operator';
import { Card, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { AutoRefresh } from './auto-refresh';
import { ActivationLink } from './activation-link';
import { createCustomerAction, requestReissueAction } from './actions';

/**
 * Operator console — create a new customer (tenant).
 *
 * DELIBERATELY AT /operator, NOT UNDER /admin. Everything under /admin is CUSTOMER-facing: it is the
 * screen set a customer's own HR administrators use. This is the installation tier and belongs to a
 * different audience entirely, so it gets its own route and NO nav entry — an operator types the URL.
 *
 * GATED IN-PAGE (the app/admin/scheduled-actions precedent) on two conditions:
 *   1. isOperator — the tier itself. Note that a customer's group admin fails this: operator is not an
 *      admin role and is not implied by any admin grant.
 *   2. not the demo deployment — that build runs the identity switcher live behind SHARE_PASSWORD, so
 *      without this a consultant could switch into an operator identity and create real customers.
 *
 * Both are belt-and-braces. The authoritative gates are the RLS policies on tenant_provision_request,
 * the column grant that withholds activation_url, and core/operator.ts's own assertions — remove this
 * whole page and a non-operator still reads nothing and writes nothing.
 */
export default async function OperatorPage() {
  const s = await getSession();
  if (!isOperator(s) || isDemoDeployment()) redirect('/');

  const t = await getTranslations('operator');
  const locale = await getLocale();
  const requests = await listProvisionRequests(s);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  const inFlight = requests.some((r) => r.status === 'pending' || r.status === 'running');
  const statusVariant = (st: string) =>
    st === 'done' ? 'success' : st === 'failed' ? 'danger' : st === 'running' ? 'warning' : 'default';
  const statusLabel = (st: string) => (t.has(`status.${st}`) ? t(`status.${st}`) : st);
  const stepLabel = (key: string) => (t.has(`steps.${key}`) ? t(`steps.${key}`) : key);

  const activationLabels = {
    reveal: t('reveal'),
    revealWarning: t('revealWarning'),
    copy: t('copy'),
    copied: t('copied'),
    shownOnce: t('shownOnce'),
    alreadyRevealed: t('alreadyRevealed'),
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Mounted only while something is actually in flight — a settled console polls nothing. */}
      {inFlight && <AutoRefresh />}

      <PageHeader title={t('title')} description={t('description')} />

      <Card className="p-4">
        <SectionHeader title={t('newCustomer')} />
        <form action={createCustomerAction} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('customerName')}</span>
            <input name="customerName" required className={inputCls} placeholder={t('customerNamePlaceholder')} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('adminEmail')}</span>
            <input name="adminEmail" type="email" required className={inputCls} placeholder={t('adminEmailPlaceholder')} />
          </label>
          <div className="flex items-end">
            <button type="submit" className={btnPrimary}>
              {t('create')}
            </button>
          </div>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">{t('formNote')}</p>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-4">
          <SectionHeader title={t('requestsTitle')} count={requests.length} />
        </div>

        {requests.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {requests.map((r) => (
              <li key={r.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">{r.customerName}</div>
                    <p className="text-sm text-muted-foreground">{r.adminEmail}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{dateTime.format(r.createdAt)}</p>
                  </div>
                  <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>
                </div>

                {/* ── In flight: the STATIC step list. Nothing per-step is stored or claimed — the whole
                    thing commits in one transaction in seconds, so a per-step progress bar would be
                    inventing detail the database does not have. ── */}
                {(r.status === 'pending' || r.status === 'running') && (
                  <div className="rounded-md bg-muted/40 p-3">
                    <p className="text-sm text-muted-foreground">{t('runningNote')}</p>
                    <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {PROVISION_STEPS.map((step) => (
                        <li key={step.key}>· {stepLabel(step.i18nKey)}</li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* ── Failed: which step, why, and a one-click resubmit of the same details. Retry is a
                    NEW request row, not a mutation of this one — provisioning is all-or-nothing, so a
                    failed row is inert history and re-inserting is the only honest "try again". ── */}
                {r.status === 'failed' && (
                  <div className="space-y-2 rounded-md bg-red-50 p-3 dark:bg-red-500/10">
                    {r.currentStep && (
                      <p className="text-sm font-medium text-red-700 dark:text-red-400">
                        {t('failedAt')}: {stepLabel(r.currentStep)}
                      </p>
                    )}
                    <p className="text-sm text-red-700 dark:text-red-400">{r.error}</p>
                    <form action={createCustomerAction}>
                      <input type="hidden" name="customerName" value={r.customerName} />
                      <input type="hidden" name="adminEmail" value={r.adminEmail} />
                      <button type="submit" className={btnGhost}>
                        {t('retry')}
                      </button>
                    </form>
                  </div>
                )}

                {/* ── Done: the reveal-once link, plus a way back if it is lost. ── */}
                {r.status === 'done' && (
                  <div className="space-y-3 rounded-md bg-muted/40 p-3">
                    <ActivationLink requestId={r.id} labels={activationLabels} />
                    <div className="border-t border-border pt-3">
                      {r.reissueRequestedAt ? (
                        <p className="text-xs text-muted-foreground">{t('reissuePending')}</p>
                      ) : (
                        <form action={requestReissueAction.bind(null, r.id)}>
                          <button type="submit" className={btnGhost}>
                            {t('reissue')}
                          </button>
                          <p className="mt-1 text-xs text-muted-foreground">{t('reissueNote')}</p>
                        </form>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
