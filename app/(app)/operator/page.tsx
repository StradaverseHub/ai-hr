import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { internalSelected } from '@/lib/internal-auth/config';
import Link from 'next/link';
import { listOperatorCustomers } from '@/core/operator-customers';
import { CustomerCreateForm } from './customer-forms';
import { GuideTourButton } from '@/components/guide-tour-button';
import { guideTourId } from '@/lib/onboarding-tour';
import { Markdown } from '@/components/markdown';
import { loadOperatorGuides } from '@/lib/guide-catalog';
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
import { countryPacks } from '@/localization/registry';
import { DEFAULT_PROVISION_MODULE_CODES, MODULE_CATALOG } from '@/packs/catalog';

/**
 * Operator console — create a new customer (tenant).
 *
 * DELIBERATELY AT /operator, NOT UNDER /admin. Everything under /admin is CUSTOMER-facing: it is the
 * screen set a customer's own HR administrators use. This is the installation tier and belongs to a
 * different audience entirely, with its own installation navigation.
 *
 * GATED IN-PAGE (the app/(app)/admin/scheduled-actions precedent) on two conditions:
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

  const guides = loadOperatorGuides();
  const t = await getTranslations('operator');
  const locale = await getLocale();
  const requests = await listProvisionRequests(s);
  const customers = await listOperatorCustomers(s);
  const w = await getTranslations('operatorWorkspace');
  const internalAuth = internalSelected();
  // Registered packs only — see the form comment. countryPacks() works in a server component because
  // importing localization/registry IS the registration (its registerPack call runs at module load).
  const countries = countryPacks().map((p) => p.country.toUpperCase()).sort();
  const sellableModules = MODULE_CATALOG.filter((m) => !m.isCore).sort((a, b) => a.sortOrder - b.sortOrder);
  const coreModules = MODULE_CATALOG.filter((m) => m.isCore).sort((a, b) => a.sortOrder - b.sortOrder);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: HR_LOCAL_TZ });

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

      {/* deec1691 (r79): the record-relationship explorer moved OFF this console to
          /admin/system-explorer, behind the `system_explorer` entitlement, at the reporter's
          instruction — it is wanted during setup, which happens under Admin. The link is gone rather
          than pointing at the new route: an operator is not a tenant admin, so following it would only
          bounce them. */}
      <PageHeader title={w('customers')} description={w('workspaceDescription')} />
      <a href="#operator-knowledge-base" className="text-sm font-medium text-primary underline underline-offset-2">{t('knowledgeBase')}</a>

      <section id="customers" className="scroll-mt-4">
        <Card className="p-4"><SectionHeader title={w('customers')} count={customers.length}/>
          {customers.length===0?<p className="mt-3 text-sm text-muted-foreground">{w('emptyCustomers')}</p>:<ul className="mt-3 divide-y divide-border">{customers.map(c=><li key={c.tenant_id}>
            <Link href={`/operator/customers/${c.tenant_id}`} className="flex min-h-16 flex-wrap items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
              <span className="min-w-0"><span className="block font-medium">{c.customer_name}</span><span className="mt-1 block text-xs text-muted-foreground">{c.organizationCode??w('codeUnavailable')}</span></span>
              <span className="flex items-center gap-3"><Badge variant={c.customer_status==='suspended'?'warning':'default'}>{w.has(c.customer_status)?w(c.customer_status):c.customer_status}</Badge><span className="text-sm text-primary">{w('manageCustomer')}</span></span>
            </Link></li>)}</ul>}
        </Card>
      </section>
      <Card id="new-customer" data-tour="operator-customer-form" className="p-4">
        <SectionHeader title={t('newCustomer')} />
        <CustomerCreateForm internalAuth={internalAuth} countries={countries} modules={sellableModules} defaults={DEFAULT_PROVISION_MODULE_CODES} coreNames={coreModules.map(m=>m.name).join(', ')}/>

        <p className="mt-2 text-xs text-muted-foreground">{t('formNote')}</p>
      </Card>

      <Card data-tour="operator-requests" className="overflow-hidden">
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
                    {r.organizationCode&&<p className="text-xs text-muted-foreground">{w('organizationCode')}: {r.organizationCode}</p>}
                    <p className="text-sm text-muted-foreground">{r.adminEmail}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground"><time dateTime={r.createdAt.toISOString()}>{dateTime.format(r.createdAt)} MYT</time></p>
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
                      {internalAuth&&<label className="block text-sm">{w('organizationCode')}<input name="organizationCode" defaultValue={r.organizationCode??''} required minLength={2} maxLength={64} pattern="[a-z0-9][a-z0-9-]{1,63}" className={inputCls}/></label>}
                      {/* THE WHOLE SALE IS REPLAYED — country, plan and every ticked module. Retry
                          re-posts this form to the same action that created the request, so anything
                          missing here is silently dropped: a retry carrying no modules would
                          re-provision the customer with nothing but the core set, which is a
                          downgrade nobody asked for and nothing to notice it by (the failed request's
                          own rows survive in tenant_provision_request_module, but the NEW request is
                          built from this form, not from them). listProvisionRequests reads them back
                          onto the row precisely so this loop can exist. */}
                      <input type="hidden" name="country" value={r.country} />
                      {r.plan ? <input type="hidden" name="plan" value={r.plan} /> : null}
                      {r.modules.map((code) => (
                        <input key={code} type="hidden" name="modules" value={code} />
                      ))}
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
      <Card className="p-4" >
        <section id="operator-knowledge-base" aria-labelledby="operator-guides-heading" className="scroll-mt-6">
          <h2 id="operator-guides-heading" className="text-lg font-semibold">{t('knowledgeBase')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('guidesDescription')}</p>
          <div className="mt-4 divide-y divide-border" lang="en">
            {guides.map(guide => {
              const tourId = guideTourId(guide.slug);
              return (
              <details key={guide.slug} id={guide.slug} className="py-3">
                <summary data-tour={`operator-guide-${guide.slug}`} className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">{guide.title}</summary>
                {tourId && <div className="mt-3" lang={locale}><GuideTourButton tourId={tourId} /></div>}
                <Markdown className="mt-3">{guide.body}</Markdown>
              </details>
              );
            })}
          </div>
        </section>
      </Card>
    </div>
  );
}
