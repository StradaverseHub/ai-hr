import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { DEFAULT_PAYROLL_CYCLES } from '@/packs/payroll/service';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnGhost, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { CurrencySelect } from '@/components/currency-select';
import { COUNTRY_CODE_OPTIONS } from '@/lib/countries';
import { createCompanyAction } from '../../actions';
import Link from 'next/link';
// 7d2df42a — the duplicate-code WARNING. The read it is fed from is `listCompanies(..., adminOnly: true)`
// below; the rules (archived companies do not collide, case/whitespace do not distinguish two codes) are
// stated once in lib/company-code.ts and applied by `companyCodeHolders`.
import { listCompanies } from '@/core/read';
import { companyCodeHolders } from '@/lib/company-code';
import { CompanyCodeField } from '@/components/company-code-field';

/**
 * Admin → Organization → Add new company (item defd4644).
 *
 * The create form used to be a collapsible panel bolted onto the top of the companies card, so the
 * one screen was simultaneously the browse surface and a data-entry surface. It is its own route now;
 * the listing links here and `createCompanyAction` redirects back to the listing on success (and back
 * to the listing with `?error=` on failure — that redirect target lives in app/admin/actions.ts, which
 * is outside this module).
 *
 * FIELDS ARE EXACTLY WHAT `createCompanyAction` READS — legalName, companyLabel, country, currency,
 * registrationNo and defaultPayrollCycle. Nothing else is posted, because a field the action ignores is
 * a field that silently discards what the operator typed. Everything else about a company (its statutory
 * identity, bank accounts, group parent, logo, contact details) is set up afterwards on the company's own
 * maintenance page, which is what `createDescription` tells the reader.
 *
 * ── THE COMPANY CODE (item 3783fd87) ──────────────────────────────────────────────────────────────
 * `companyLabel` is the SIXTH field, and it is not a new one. `company.company_label` has existed since
 * bc5d4891; the listing has headed it "Code" since defd4644 and the General tab has edited it all along.
 * The only screen it was missing from was this one — so a company was created without a code and the
 * operator had to go and find it again on another screen to give it one. On production that is 7 of 13
 * companies with no code at all, and of the six that have something, one holds the entire legal name and
 * one reads "PRIVATE CO.": a field reachable only after the fact gets filled in badly or not at all.
 *
 * ⚠️ IT IS NOT REQUIRED AND IT IS NOT UNIQUE-CHECKED, and both of those are decisions, not omissions.
 * The column is nullable free text and the General tab lets you clear it; a create form that REFUSED a
 * blank would contradict the edit form and would block every company whose code is not decided yet.
 * Uniqueness is a DATA decision about what a code IS — see the note on `createCompany` in core/admin.ts.
 * The input therefore carries no `required` attribute: test/organization-list-detail.test.ts pins that
 * `legalName` is the only required field on this form.
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
  const { s } = await scopedAdmin();
  const { error } = await searchParams;
  const t = await getTranslations('admin.organization');

  /**
   * 7d2df42a — the codes already in use, for the warning under the Company Code field.
   *
   * `adminOnly: true` is the database's own `app.is_admin_for` — the SAME set the Organization listing
   * already shows this person by name, so the warning cannot name a company they could not otherwise
   * reach. For a group-wide hr_admin that is every company in the tenant. Archived companies are
   * excluded twice over: this read leaves `includeArchived` off, and `companyCodeHolders` drops them
   * anyway, because a code recycled from a company retired years ago is not a collision worth a warning.
   * ⚠️ DO NOT widen either of those to make the warning fire more often — see lib/company-code.ts.
   */
  const codesInUse = companyCodeHolders(await listCompanies(s, { adminOnly: true }));

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
          {/* 3783fd87 — the Company Code, directly under the legal name, which is where the approved plan
              told the reporter it would go. `name="companyLabel"` is the SAME field name the General tab
              posts, so the create path and the edit path write one column through one normaliser.

              7d2df42a — and it now warns, as you type, when another company already uses the code, naming
              that company. It is a WARNING: no `required`, no refusal, and a duplicate save still lands on
              the listing rather than on `?error=`. The field itself is components/company-code-field.tsx,
              shared with the General tab so the two screens cannot disagree about what a duplicate is. */}
          <Field label={t('companyCode')}>
            <CompanyCodeField codesInUse={codesInUse} />
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
