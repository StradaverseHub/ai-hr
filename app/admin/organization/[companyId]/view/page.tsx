import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { scopedAdmin } from '@/lib/scope';
import { cn } from '@/lib/utils';
import { companyTree, listCompanies } from '@/core/read';
import { listProfileOptions } from '@/core/profile-options';
import { packFor } from '@/localization/registry';
import { listCompanyBankProfiles } from '@/core/bank-profile';
import { listCompanyStatutoryAuthorities, listPayrollCycles } from '@/packs/payroll/service';
import { isModuleEnabledOrFalse } from '@/core/entitlements';
import { ErrorBanner, PageHeader, pageWideCls } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Kv, Section, Status, type KvItem } from '@/components/monolith';
import { MONO_LABEL } from '@/components/monolith/classes';
import { CompanyLogo } from '@/components/company-logo';
import { COMPANY_PANEL_TABS, isCompanyPanelTab, type CompanyPanelTab } from '@/lib/company-panel-tabs';
import { COUNTRY_CODE_OPTIONS, COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { myBankLabel } from '@/lib/my-banks';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
import { MY_FILING_FIELD } from '@/lib/statutory-authority-display';
import { resolveGroupTree } from '../../group-tree';

/**
 * Admin → Organization → ONE COMPANY, READ-ONLY (board item 7a595a02).
 *
 * The listing's View and the company's name used to open the editor, so checking a company's details
 * meant standing in a form where one stray change and a Save altered the record. This screen shows the
 * SAME fields the editor (components/company-panel.tsx) reads, as text, under the same three tabs; Edit
 * at the top right opens /admin/organization/<id>, the editor, unchanged. The precedent is
 * app/admin/payroll-config/[companyId]/page.tsx (read-only + Edit).
 *
 * ── IT CANNOT WRITE, BY CONSTRUCTION ─────────────────────────────────────────────────────────────
 * This file imports NO CompanyPanel and NO server action, and renders no form control of any kind.
 * test/r403-company-view.test.ts pins that on this source and on the rendered markup. Tabs are LINKS
 * (`?tab=`), validated against lib/company-panel-tabs.ts, so switching tab is a navigation, not state.
 *
 * ── SAME GUARD, SAME REFUSAL AS THE EDITOR ───────────────────────────────────────────────────────
 * `scopedAdmin()` first, then `listCompanies(..., { adminOnly: true })` — the database's own
 * `app.is_admin_for` — and an id outside that set 404s before any per-company read runs. A second door
 * onto a company's bank accounts must not be an easier door; whoever cannot open the editor cannot open
 * this. Registered under the existing `organization` column of lib/permissions.ts: viewing a company is
 * not a separate capability from maintaining it (the plan says so to the reporter).
 *
 * ⚠️ ONE i18n NAMESPACE (`admin.organization`), the editor's own captions wherever one exists, so the
 * two screens cannot call one field two things.
 */
export default async function CompanyViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ error?: string; tab?: string }>;
}) {
  const { s } = await scopedAdmin();
  const { companyId } = await params;
  const { error, tab: rawTab } = await searchParams;
  const t = await getTranslations('admin.organization');

  const [companies, tree] = await Promise.all([
    listCompanies(s, { includeArchived: true, adminOnly: true }),
    companyTree(s),
  ]);
  // THE REFUSAL — identical to [companyId]/page.tsx, and before any per-company read.
  const c = companies.find((x) => x.id === companyId);
  if (!c) notFound();

  const tab: CompanyPanelTab = isCompanyPanelTab(rawTab) ? rawTab : 'general';
  // r298 — the default payroll cycle is a Payroll section; a tenant without Payroll neither reads nor
  // sees it, exactly as on the editor.
  const payrollOn = isModuleEnabledOrFalse(s, 'payroll');

  const [statutory, bankProfiles, authorities, stateOpts, cycles] = await Promise.all([
    packFor('MY')?.companyStatutory.get(s, companyId) ?? null,
    listCompanyBankProfiles(s, companyId),
    listCompanyStatutoryAuthorities(s, companyId),
    listProfileOptions(s, 'state', { activeOnly: false }),
    payrollOn ? listPayrollCycles(s, companyId, { activeOnly: true }) : null,
  ]);

  const { parentBy } = resolveGroupTree(companies, tree);
  const parentId = parentBy.get(c.id) ?? null;
  // resolveGroupTree re-roots a parent outside the administrable set to null, so this never names one.
  const parentName = parentId ? (companies.find((x) => x.id === parentId)?.name ?? null) : null;
  const isMY = c.country === 'MY';

  const notSet = <span className="font-normal italic text-muted-foreground monolith:text-mid">{t('authorityValueNotSet')}</span>;
  const val = (v: string | null | undefined) => (v && v.trim() ? v : notSet);
  const countryLabel = (code: string) => COUNTRY_CODE_OPTIONS.find((o) => o.value === code)?.label ?? code;
  const stateLabel = (v: string | null) => (v ? (stateOpts.find((o) => o.value === v)?.label ?? v) : null);
  const addrCountryLabel = (v: string | null) =>
    v ? (COUNTRY_NAME_OPTIONS.find((o) => o.value === v)?.label ?? v) : null;

  const base = `/admin/organization/${c.id}`;
  const tabHref = (k: CompanyPanelTab) => (k === 'general' ? `${base}/view` : `${base}/view?tab=${k}`);
  const editHref = tab === 'general' ? base : `${base}?tab=${tab}`;
  const tabLabel: Record<CompanyPanelTab, string> = {
    general: t('tabGeneral'),
    bank: t('tabBankAccount'),
    statutory: t('tabStatutory'),
  };

  const addressLines = [c.addressLine1, c.addressLine2, c.addressLine3].filter((l): l is string => !!l?.trim());

  return (
    <div className={pageWideCls}>
      <PageHeader
        title={c.name}
        description={[c.registrationNo, c.country, c.archivedAt ? t('statusArchived') : null].filter(Boolean).join(' · ')}
        back={{ href: '/admin/organization', label: t('backToCompanies') }}
        actions={
          // asChild: Button's classes (Classic primary, Monolith ink pill) on a LINK — a navigation, not a submit.
          <Button asChild>
            <Link href={editHref} data-company-edit-link>
              {t('actionEdit')}
            </Link>
          </Button>
        }
      />
      <ErrorBanner message={error} />

      {/* The three tabs, as links. Classic: the editor's underline tabs; Monolith: Section's mono tabs. */}
      <nav
        aria-label={c.name}
        className="flex gap-1 overflow-x-auto border-b border-border monolith:gap-5 monolith:border-hairline"
      >
        {COMPANY_PANEL_TABS.map((k) => (
          <Link
            key={k}
            href={tabHref(k)}
            aria-current={k === tab ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              k === tab
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
              MONO_LABEL,
              'monolith:border-b monolith:px-0 monolith:py-1.5',
              k === tab ? 'monolith:border-ink monolith:text-ink' : 'monolith:text-mid monolith:hover:text-ink',
            )}
          >
            {tabLabel[k]}
          </Link>
        ))}
      </nav>

      {tab === 'general' && (
        <>
          <Section index={1} label={t('logoSection')}>
            <div className="flex items-center gap-3">
              <CompanyLogo hasLogo={c.hasLogo} companyId={c.id} name={c.name} className="size-16" />
              {!c.hasLogo && <span className="text-sm text-muted-foreground monolith:text-mid">{t('logoNone')}</span>}
            </div>
          </Section>

          <Section index={2} label={t('sectionCompanyInfo')}>
            <Kv
              items={[
                { label: t('legalName'), value: c.name },
                { label: t('companyCode'), value: val(c.companyLabel) },
                { label: t('regNo'), value: val(c.registrationNo) },
                { label: t('industry'), value: val(c.industry) },
                { label: t('businessType'), value: val(c.businessType) },
                { label: t('website'), value: val(c.website) },
                { label: t('country'), value: countryLabel(c.country) },
                { label: t('currency'), value: val(c.currency) },
              ]}
            />
          </Section>

          <Section index={3} label={t('sectionContactInfo')}>
            <Kv
              items={[
                {
                  label: t('viewAddress'),
                  value: addressLines.length
                    ? addressLines.map((l, i) => (
                        <span key={i} className="block whitespace-pre-line">
                          {l}
                        </span>
                      ))
                    : notSet,
                },
                { label: t('city'), value: val(c.city) },
                { label: t('addrState'), value: val(stateLabel(c.state)) },
                { label: t('postcode'), value: val(c.postcode) },
                { label: t('addrCountry'), value: val(addrCountryLabel(c.addressCountry)) },
                { label: t('phone'), value: val(c.phone) },
                { label: t('fax'), value: val(c.fax) },
              ]}
            />
          </Section>

          <Section index={4} label={cycles !== null ? t('viewSectionPayrollGroup') : t('groupParent')}>
            <Kv
              items={[
                ...(cycles !== null
                  ? [
                      {
                        label: t('defaultPayrollCycle'),
                        value: val(c.defaultPayrollCycle),
                        // A saved default that is no longer an active cycle is said, not hidden.
                        sub:
                          c.defaultPayrollCycle && !cycles.some((r) => r.name === c.defaultPayrollCycle)
                            ? t('viewCycleInactive', { name: c.defaultPayrollCycle })
                            : undefined,
                      } satisfies KvItem,
                    ]
                  : []),
                { label: t('parentCompany'), value: parentName ?? t('viewNoParent') },
              ]}
            />
          </Section>
        </>
      )}

      {tab === 'bank' &&
        (isMY ? (
          <Section index={1} label={t('bankProfilesTitle')}>
            {bankProfiles.length === 0 ? (
              <p className="text-sm text-muted-foreground monolith:text-mid">{t('viewNoBankProfiles')}</p>
            ) : (
              <div className="space-y-6">
                {bankProfiles.map((bp) => (
                  <div key={bp.id} data-bank-profile={bp.id} className="space-y-2">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {bp.accountLabel || myBankLabel(bp.bank)}
                      {bp.isPrimary && <Status word={t('bankPrimary')} tone="ink" />}
                    </h3>
                    <Kv
                      items={[
                        { label: t('bankLabel'), value: myBankLabel(bp.bank) },
                        { label: t('bankAccountLabel'), value: val(bp.accountLabel) },
                        { label: t('bankCorporateId'), value: val(bp.corporateId) },
                        { label: t('bankDebitAccount'), value: val(bp.debitAccountNo) },
                        { label: t('bankAccountName'), value: val(bp.accountName) },
                        {
                          label: t('bankAccountType'),
                          value:
                            bp.accountType === 'current'
                              ? t('bankAccountTypeCurrent')
                              : bp.accountType === 'savings'
                                ? t('bankAccountTypeSavings')
                                : val(bp.accountType),
                        },
                        { label: t('bankBranch'), value: val(bp.branch) },
                        { label: t('bankSwift'), value: val(bp.swiftCode) },
                        { label: t('bankCurrency'), value: val(bp.currency) },
                        { label: t('bankOrgName'), value: val(bp.orgName) },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </Section>
        ) : (
          <Section>
            <p className="text-sm text-muted-foreground monolith:text-mid">{t('bankAccountNonMY', { country: c.country })}</p>
          </Section>
        ))}

      {tab === 'statutory' &&
        (isMY ? (
          <>
            <Section index={1} label={t('statutoryIdentityMY')}>
              <Kv
                items={[
                  { label: t('ssmRegistrationNo'), value: val(statutory?.ssmRegistrationNo) },
                  { label: t('myinvoisTin'), value: val(statutory?.myinvoisTin) },
                ]}
              />
            </Section>
            <Section index={2} label={t('authoritiesTitle')}>
              <ul className="space-y-5">
                {STATUTORY_AUTHORITIES.map((a) => {
                  const r = authorities.find((x) => x.authority === a) ?? null;
                  const filing = MY_FILING_FIELD[a];
                  // An absent band says "Not set"; it never guesses 'not_registered' (company-panel.tsx).
                  const hrdfKey =
                    statutory?.hrdfStatus === 'mandatory'
                      ? 'hrdfMandatory'
                      : statutory?.hrdfStatus === 'optional'
                        ? 'hrdfOptional'
                        : statutory?.hrdfStatus === 'not_registered'
                          ? 'hrdfNotRegistered'
                          : null;
                  const paidFrom = bankProfiles.find((bp) => bp.id === r?.bankProfileId);
                  const items: KvItem[] = [
                    ...(filing
                      ? [{ label: t(filing.labelKey as never), value: val(statutory?.[filing.name]) }]
                      : []),
                    ...(a === 'hrdf'
                      ? [{ label: t('hrdfStatusLabel'), value: hrdfKey ? t(hrdfKey as never) : notSet }]
                      : []),
                    { label: t('authorityAccountNo'), value: val(r?.accountNo) },
                    {
                      label: t('authorityBankAccount'),
                      value: paidFrom
                        ? (paidFrom.accountLabel || myBankLabel(paidFrom.bank)) + ' · ' + paidFrom.debitAccountNo
                        : notSet,
                    },
                  ];
                  return (
                    <li key={a} data-statutory-body={a} className={cn('space-y-2', a === 'eis' && 'pl-6')}>
                      <h3 className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {t(`authority_${a}` as never)}
                        <Status
                          word={r ? t('authorityConfigured') : t('authorityNotConfigured')}
                          tone={r ? 'ink' : 'mid'}
                        />
                      </h3>
                      <Kv items={items} cols={4} />
                    </li>
                  );
                })}
              </ul>
            </Section>
          </>
        ) : (
          <Section>
            <p className="text-sm text-muted-foreground monolith:text-mid">{t('viewNoStatutoryPack', { country: c.country })}</p>
          </Section>
        ))}

      <p className="text-xs text-muted-foreground monolith:text-mid">{t('viewReadOnlyNote')}</p>
    </div>
  );
}
