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

  const guides = loadOperatorGuides();
  const t = await getTranslations('operator');
  const locale = await getLocale();
  const requests = await listProvisionRequests(s);
  // Registered packs only — see the form comment. countryPacks() works in a server component because
  // importing localization/registry IS the registration (its registerPack call runs at module load).
  const countries = countryPacks().map((p) => p.country.toUpperCase()).sort();
  const sellableModules = MODULE_CATALOG.filter((m) => !m.isCore).sort((a, b) => a.sortOrder - b.sortOrder);
  const coreModules = MODULE_CATALOG.filter((m) => m.isCore).sort((a, b) => a.sortOrder - b.sortOrder);
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

      {/* deec1691 (r79): the record-relationship explorer moved OFF this console to
          /admin/system-explorer, behind the `system_explorer` entitlement, at the reporter's
          instruction — it is wanted during setup, which happens under Admin. The link is gone rather
          than pointing at the new route: an operator is not a tenant admin, so following it would only
          bounce them. */}
      <PageHeader title={t('title')} description={t('description')} />
      <a href="#operator-knowledge-base" className="text-sm font-medium text-primary underline underline-offset-2">{t('knowledgeBase')}</a>

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
          {/* ADR-0077 slice 1 — the sale, captured at intake. Both fields span the whole grid so the
              existing two-column name/email row keeps its shape.
              The country list comes from the REGISTERED country packs, so it shows exactly what this
              installation can actually provision (one entry today) rather than a hopeful list of ISO
              codes that would fail in the runner an hour later. core/operator re-validates both. */}
          <label className="block sm:col-span-3">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">Country</span>
            <select name="country" defaultValue="MY" className={inputCls}>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="block sm:col-span-3">
            <legend className="mb-1 block text-xs font-medium text-muted-foreground">Modules</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {sellableModules.map((m) => (
                <label key={m.code} className="flex items-center gap-2 text-sm">
                  {/* PRE-TICKED for everything a customer provisioned TODAY would actually run —
                      DEFAULT_PROVISION_MODULE_CODES, the tracked parity set narrowed to sellable
                      codes. An untouched form used to queue a customer with ZERO entitlement rows,
                      which reads as "everything the customer has today" until slice 3 and as
                      "nothing" after it. The default states what the product currently includes;
                      unticking is still the operator's decision and is honoured verbatim by
                      provisionTenant.

                      A CONSTANT, NOT `process.env` (review r3). This read `defaultProvisionModuleCodesIn(
                      process.env)`, which resolved NOTIFICATIONS_ENABLED / MULTI_CYCLE_PAYROLL_ENABLED /
                      TYPED_PAY_COMPONENTS_ENABLED at request time — three gates slice 3 migrated, read
                      from env in application source, and invisible to every gate check in
                      test/module-catalog-drift.test.ts because the names appeared in neither file as a
                      literal. It also meant that retiring those vars would silently drop three modules
                      from every new customer's ticks. See DEFAULT_PROVISION_MODULE_CODES for why the
                      env filter bought nothing after the flip. */}
                  <input
                    type="checkbox"
                    name="modules"
                    value={m.code}
                    defaultChecked={DEFAULT_PROVISION_MODULE_CODES.includes(m.code)}
                    className="size-4 rounded"
                  />
                  {m.name}
                </label>
              ))}
            </div>
            {/* Core modules are deliberately absent: they are always on, take no entitlement row at
                all, and the 0313 trigger refuses one — so offering them as a choice would be a lie. */}
            <p className="mt-1 text-xs text-muted-foreground">
              Core modules ({coreModules.map((m) => m.name).join(', ')}) are always included. Ticked by
              default are the modules every customer runs on this deployment today; untick to sell less.
            </p>
          </fieldset>
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
            {guides.map(guide => (
              <details key={guide.slug} id={guide.slug} className="py-3">
                <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">{guide.title}</summary>
                <Markdown className="mt-3">{guide.body}</Markdown>
              </details>
            ))}
          </div>
        </section>
      </Card>
    </div>
  );
}
