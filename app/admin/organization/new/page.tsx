import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { DEFAULT_PAYROLL_CYCLES } from '@/core/payroll-cycle';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { CurrencySelect } from '@/components/currency-select';
import { COUNTRY_CODE_OPTIONS } from '@/lib/countries';
import { createCompanyAction } from '../../actions';
import Link from 'next/link';

/**
 * Admin → Organization → Add new company (item defd4644).
 *
 * The create form used to be a collapsible panel bolted onto the top of the companies card, so the
 * one screen was simultaneously the browse surface and a data-entry surface. It is its own route now;
 * the listing links here and `createCompanyAction` redirects back to the listing on success (and back
 * to the listing with `?error=` on failure — that redirect target lives in app/admin/actions.ts, which
 * is outside this module).
 *
 * FIELDS ARE EXACTLY WHAT `createCompanyAction` READS — legalName, country, currency, registrationNo
 * and defaultPayrollCycle. Nothing else is posted, because a field the action ignores is a field that
 * silently discards what the operator typed. Everything else about a company (its statutory identity,
 * bank accounts, group parent, logo, contact details) is set up afterwards on the company's own
 * maintenance page, which is what `createDescription` tells the reader.
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`) — see the note on the listing page. `common.cancel`
 * would be a second one, so the Cancel affordance is a link labelled with this namespace's own key.
 */
export default async function NewCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Same admin gate as the rest of the module. The create itself is re-authorised by the service.
  await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={t('addNewCompany')}
        description={t('createDescription')}
        back={{ href: '/admin/organization', label: t('backToCompanies') }}
      />
      <ErrorBanner message={error} />

      <Card className="max-w-3xl">
        <SectionHeader title={t('sectionCompanyInfo')} />
        <form action={createCompanyAction} className="space-y-4 px-4 py-4">
          <Field label={t('legalName')}>
            <input name="legalName" required autoFocus className={inputCls} />
          </Field>
          <Field label={t('regNo')}>
            <input name="registrationNo" className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('country')}>
              {/* The complete shared ISO list (lib/countries), the same catalog the maintenance page's
                  Country picker uses — the old free-text 2-letter box could post anything. */}
              <select name="country" defaultValue="MY" required className={inputCls}>
                {COUNTRY_CODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('currency')}>
              {/* r79a (4fb8b75a step 3) — company.currency is the Basic Salary form's default currency
                  and createCompany rejects anything outside the ISO 4217 master, so this is a picker. */}
              <CurrencySelect name="currency" value="MYR" />
            </Field>
          </div>
          {/* Organization Module (361e3b15): Default Payroll Cycle, pre-set to Monthly so most admins
              just accept it. The company comes payroll-ready with the standard cycles seeded on create. */}
          <Field label={t('defaultPayrollCycle')}>
            <select
              name="defaultPayrollCycle"
              defaultValue="Monthly"
              title={t('defaultPayrollCycleHint')}
              className={inputCls}
            >
              {DEFAULT_PAYROLL_CYCLES.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-center gap-2 pt-1">
            <button type="submit" className={btnPrimary}>
              {t('addCompany')}
            </button>
            <Link href="/admin/organization" className={btnGhost}>
              {t('backToCompanies')}
            </Link>
          </div>
        </form>
      </Card>
    </div>
  );
}
