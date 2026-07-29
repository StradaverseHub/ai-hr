'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { COUNTRY_CODE_OPTIONS, COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { DISBURSEMENT_CAPABLE_BANKS, DISBURSEMENT_UNSUPPORTED_BANKS, MY_BANKS, myBankLabel } from '@/lib/my-banks';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
import { Avatar, Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';
// r79a — company.currency is now the salary-form default currency, so it uses the same ISO 4217 picker.
import { CurrencySelect } from './currency-select';

// 94ae7e1f — the company config panel is reorganised into three tabs: General / Bank Account / Statutory.
// The old "Payroll" tab is renamed Statutory (it only ever held statutory identity), and the Bank
// Disbursement Profiles move out of it into a dedicated Bank Account tab (disbursement is a banking concern,
// not a statutory one). Pure UI/relocation — the underlying statutory + bank-profile data/logic is unchanged.
type TabKey = 'general' | 'bankAccount' | 'statutory';

/** One tab trigger — mirrors the leave-tabs styling (border-b, active = border-primary text-primary). */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
        active
          ? 'border-primary font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** A short explainer + a link out to the real home of a config area we deliberately do NOT duplicate here. */
function CrossLinkTab({ text, href, action }: { text: string; href: string; action: string }) {
  return (
    <div className="space-y-3 rounded-lg bg-background p-4">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        {action}
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

type Action = (fd: FormData) => void | Promise<void>;

export type PanelCompany = {
  id: string;
  name: string;
  country: string;
  currency: string;
  registrationNo: string | null;
  // Enhance Company General Tab (bc5d4891) — Company Information + Contact Information master data.
  companyLabel: string | null;
  industry: string | null;
  website: string | null;
  businessType: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  addressCountry: string | null;
  postcode: string | null;
  phone: string | null;
  fax: string | null;
  archivedAt: Date | null;
  inUse: boolean;
  parentId: string | null;
  hasLogo: boolean;
  // Organization Module (361e3b15) — the company's saved default payroll cycle (name). Pre-selected in the
  // General-tab picker; if it is no longer among the active cycles the picker flags it and lets the admin
  // re-point (no silent invalid selection).
  defaultPayrollCycle: string;
};
/** A tenant-wide profile-option choice (value stored, label shown) for the State / Country pick-lists. */
export type PanelOption = { value: string; label: string };
export type PanelStatutory = {
  epfEmployerNo: string | null;
  socsoEmployerCode: string | null;
  lhdnEmployerNo: string | null;
  myinvoisTin: string | null;
  ssmRegistrationNo: string | null;
  hrdfStatus: 'not_registered' | 'mandatory' | 'optional' | null;
} | null;
// R46 orgbank (84719377) — `bank` is a key from the SHARED Malaysian bank master (lib/my-banks.ts), the
// same list the employee bank picker reads. The old hardcoded 4-entry BANK_LABEL is gone; labels come from
// myBankLabel(), which falls back to the raw key so a legacy value never renders blank.
export type PanelBankProfile = {
  id: string;
  bank: string;
  corporateId: string;
  debitAccountNo: string;
  orgName: string | null;
  txnType: string;
  accountLabel: string | null;
  accountName: string | null;
  accountType: string | null;
  branch: string | null;
  swiftCode: string | null;
  currency: string;
  isPrimary: boolean;
};

// R46 orgbank (84719377) — per-authority statutory payment configuration (company_statutory_authority).
export type PanelStatutoryAuthority = {
  id: string;
  authority: string;
  accountNo: string | null;
  bankProfileId: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  signatoryPersonId: string | null;
};
/** An ACTIVE employee of this company — the authorised-signatory picker is company-scoped. */
export type PanelSignatory = { personId: string; name: string };

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  muted:
    'rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

/** A pick-list backed by a tenant-wide profile-option catalog (bc5d4891). Legacy-tolerant: if the stored
 *  value is not (or no longer) in the active catalog it is still rendered as a selectable option so an edit
 *  of any OTHER field never silently drops it. Empty = the placeholder (clears to null on save). */
function OptionSelect({
  name,
  value,
  options,
  placeholder,
}: {
  name: string;
  value: string | null;
  options: PanelOption[];
  placeholder: string;
}) {
  const known = !value || options.some((o) => o.value === value);
  return (
    <select name={name} defaultValue={value ?? ''} className={inputCls}>
      <option value="">{placeholder}</option>
      {!known && value ? <option value={value}>{value}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * One company bank account (R46 orgbank 84719377). Used twice: prefilled for each saved account (a hidden
 * `id` makes the save an UPDATE of that row) and blank to add another. A company may hold several accounts
 * including more than one at the same bank, so the row id — not (company, bank) — is the identity.
 *
 * The Bank picker is the SHARED Malaysian bank master (lib/my-banks.ts), the same list the employee bank
 * screen offers. Banks ai-hr cannot yet BUILD a bulk salary file for are still selectable but sit in a
 * clearly-labelled group: widening the picker without widening the file builders is how a company ends up
 * saving a profile that only fails at file-build time, so the limitation is stated up front instead.
 *
 * The Payment rail (IBG / RENTAS) select is deliberately NOT rendered — the reporter asked for it off the
 * screen. The column and its 'IBG' default remain (RENTAS is required for large single payments); nothing
 * here posts txnType, so the service leaves the stored value alone.
 */
function BankAccountForm({
  action,
  companyId,
  companyName,
  profile,
}: {
  action: Action;
  companyId: string;
  companyName: string;
  profile: PanelBankProfile | null;
}) {
  const t = useTranslations('admin.organization');
  const p = profile;
  // Legacy-tolerant: a stored bank key no longer in the master is still offered so editing any OTHER field
  // cannot silently drop it (same posture as OptionSelect).
  const known = !p?.bank || MY_BANKS.some((b) => b.key === p.bank);
  return (
    <form action={action} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <input type="hidden" name="companyId" value={companyId} />
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label={t('bankLabel')}>
        <select name="bank" defaultValue={p?.bank ?? ''} required className={inputCls}>
          <option value="" disabled>
            {t('bankSelect')}
          </option>
          {!known && p?.bank ? <option value={p.bank}>{p.bank}</option> : null}
          {DISBURSEMENT_CAPABLE_BANKS.map((b) => (
            <option key={b.key} value={b.key}>
              {b.canonical}
            </option>
          ))}
          <optgroup label={t('bankNoFileFormatGroup')}>
            {DISBURSEMENT_UNSUPPORTED_BANKS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.canonical}
              </option>
            ))}
          </optgroup>
        </select>
      </Field>
      <Field label={t('bankAccountLabel')}>
        <input
          name="accountLabel"
          defaultValue={p?.accountLabel ?? ''}
          className={inputCls}
          placeholder={t('bankAccountLabelHint')}
        />
      </Field>
      <Field label={t('bankCorporateId')}>
        <input
          name="corporateId"
          required
          defaultValue={p?.corporateId ?? ''}
          className={inputCls}
          placeholder={t('bankCorporateIdHint')}
        />
      </Field>
      <Field label={t('bankDebitAccount')}>
        <input name="debitAccountNo" required defaultValue={p?.debitAccountNo ?? ''} className={inputCls} />
      </Field>
      <Field label={t('bankAccountName')}>
        <input name="accountName" defaultValue={p?.accountName ?? ''} className={inputCls} />
      </Field>
      <Field label={t('bankAccountType')}>
        <select name="accountType" defaultValue={p?.accountType ?? ''} className={inputCls}>
          <option value="">{t('optionNone')}</option>
          <option value="current">{t('bankAccountTypeCurrent')}</option>
          <option value="savings">{t('bankAccountTypeSavings')}</option>
        </select>
      </Field>
      <Field label={t('bankBranch')}>
        <input name="branch" defaultValue={p?.branch ?? ''} className={inputCls} />
      </Field>
      <Field label={t('bankSwift')}>
        <input name="swiftCode" defaultValue={p?.swiftCode ?? ''} className={`${inputCls} uppercase`} />
      </Field>
      <Field label={t('bankCurrency')}>
        <input
          name="currency"
          defaultValue={p?.currency ?? 'MYR'}
          pattern="[A-Za-z]{3}"
          maxLength={3}
          className={`${inputCls} uppercase`}
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('bankOrgName')}>
          <input name="orgName" defaultValue={p?.orgName ?? companyName} className={inputCls} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="isPrimary" defaultChecked={p?.isPrimary ?? false} className="size-4 rounded" />
        {t('bankPrimaryLabel')}
      </label>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm">
          {t('bankProfileSave')}
        </Button>
      </div>
    </form>
  );
}

/**
 * One statutory body's payment configuration (R46 orgbank 84719377): which of the company's bank accounts
 * pays it, the employer's payment reference with it, its correspondence address + contact, and the
 * authorised signatory.
 *
 * The signatory picker is scoped to ACTIVE employees of THIS company. It is legacy-tolerant in the same way
 * the profile-option pickers are: a stored signatory who has since left is still shown as selected, so
 * editing the phone number does not silently clear them. The service refuses to newly APPOINT a leaver.
 */
function StatutoryAuthorityCard({
  authority,
  row,
  companyId,
  bankProfiles,
  signatories,
  stateOptions,
  setAction,
  removeAction,
}: {
  authority: string;
  row: PanelStatutoryAuthority | null;
  companyId: string;
  bankProfiles: PanelBankProfile[];
  signatories: PanelSignatory[];
  stateOptions: PanelOption[];
  setAction: Action;
  removeAction: Action;
}) {
  const t = useTranslations('admin.organization');
  const r = row;
  const configured = !!r;
  const signatoryKnown = !r?.signatoryPersonId || signatories.some((sg) => sg.personId === r.signatoryPersonId);
  return (
    <li className="rounded-md border border-border/60">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 text-sm">
            {/* Dynamic message key (`authority_epf`, `authority_socso`, …) — one per entry in
                STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's
                existing convention for a computed key (see txn-grid.tsx). NOTE: the i18n-coverage test
                cannot see dynamic keys, so adding an authority means adding its label to all six
                locales by hand. */}
            <span className="font-medium">{t(`authority_${authority}` as never)}</span>
            {configured ? (
              <span className={`ml-2 ${badge.emerald}`}>{t('authorityConfigured')}</span>
            ) : (
              <span className={`ml-2 ${badge.muted}`}>{t('authorityNotConfigured')}</span>
            )}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <span className="group-open:hidden">{t('bankAccountEdit')}</span>
            <span className="hidden group-open:inline">{t('bankAccountCollapse')}</span>
          </span>
        </summary>
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          <form action={setAction} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="authority" value={authority} />
            <Field label={t('authorityAccountNo')}>
              <input
                name="accountNo"
                defaultValue={r?.accountNo ?? ''}
                className={inputCls}
                placeholder={t('authorityAccountNoHint')}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('authorityBankAccount')}>
                <select name="bankProfileId" defaultValue={r?.bankProfileId ?? ''} className={inputCls}>
                  <option value="">{t('authorityBankAccountNone')}</option>
                  {bankProfiles.map((bp) => (
                    <option key={bp.id} value={bp.id}>
                      {(bp.accountLabel || myBankLabel(bp.bank)) + ' · ••••' + bp.debitAccountNo.slice(-4)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label={t('addressLine1')}>
                <input name="addressLine1" defaultValue={r?.addressLine1 ?? ''} className={inputCls} />
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label={t('addressLine2')}>
                <input name="addressLine2" defaultValue={r?.addressLine2 ?? ''} className={inputCls} />
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label={t('addressLine3')}>
                <input name="addressLine3" defaultValue={r?.addressLine3 ?? ''} className={inputCls} />
              </Field>
            </div>
            <Field label={t('city')}>
              <input name="city" defaultValue={r?.city ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addrState')}>
              <OptionSelect name="state" value={r?.state ?? null} options={stateOptions} placeholder={t('optionNone')} />
            </Field>
            <Field label={t('postcode')}>
              <input name="postcode" defaultValue={r?.postcode ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addrCountry')}>
              <OptionSelect
                name="country"
                value={r?.country ?? null}
                options={COUNTRY_NAME_OPTIONS}
                placeholder={t('optionNone')}
              />
            </Field>
            <Field label={t('phone')}>
              <input name="phone" type="tel" defaultValue={r?.phone ?? ''} className={inputCls} />
            </Field>
            <Field label={t('authorityEmail')}>
              <input name="email" type="email" defaultValue={r?.email ?? ''} className={inputCls} />
            </Field>
            <div className="sm:col-span-3">
              <Field label={t('authoritySignatory')}>
                <select name="signatoryPersonId" defaultValue={r?.signatoryPersonId ?? ''} className={inputCls}>
                  <option value="">{t('optionNone')}</option>
                  {/* A signatory who has since left is still shown so an unrelated edit can't clear them. */}
                  {!signatoryKnown && r?.signatoryPersonId ? (
                    <option value={r.signatoryPersonId}>{t('authoritySignatoryFormer')}</option>
                  ) : null}
                  {signatories.map((sg) => (
                    <option key={sg.personId} value={sg.personId}>
                      {sg.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Button type="submit" size="sm">
                {t('authoritySave')}
              </Button>
            </div>
          </form>
          {r && (
            <form action={removeAction}>
              <input type="hidden" name="id" value={r.id} />
              <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                {t('authorityClear')}
              </button>
            </form>
          )}
        </div>
      </details>
    </li>
  );
}

/** The company's logo (served inline by the RLS-scoped logo route) or the initials Avatar placeholder when
 *  none is set. On an <img> load error (e.g. a corrupt-but-sniffed file) it falls back to the Avatar. */
function CompanyLogo({
  hasLogo,
  companyId,
  name,
  className,
}: {
  hasLogo: boolean;
  companyId: string;
  name: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!hasLogo || broken) return <Avatar name={name} className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- dynamic bytea served by our RLS route; not a static asset
    <img
      src={`/admin/organization/logo/${companyId}`}
      alt=""
      onError={() => setBroken(true)}
      className={cn('size-8 shrink-0 rounded-full object-cover ring-1 ring-border', className)}
    />
  );
}

/** One legal entity as an expandable panel: company details, group parent, statutory identity, and bank
 *  disbursement profiles — everything "about running the company". The org catalogs (departments /
 *  positions / cost centers / business units) moved to the Settings → System Labels admin page; this
 *  panel is now purely company/legal/bank management. */
export function CompanyPanel({
  company,
  companies,
  statutory,
  bankProfiles,
  statutoryAuthorities = [],
  signatories = [],
  stateOptions = [],
  activeCycleNames = [],
  actions,
}: {
  company: PanelCompany;
  companies: { id: string; name: string }[];
  statutory: PanelStatutory;
  bankProfiles: PanelBankProfile[];
  // R46 orgbank (84719377) — per-authority statutory payment configuration + the company-scoped
  // authorised-signatory candidates (active employees of THIS company).
  statutoryAuthorities?: PanelStatutoryAuthority[];
  signatories?: PanelSignatory[];
  // Enhance Company General Tab (bc5d4891) — tenant-wide catalog for the Contact-Info State picker. The
  // Country picker (94ae7e1f) now uses the complete shared ISO list (lib/countries), not a curated catalog.
  stateOptions?: PanelOption[];
  // Organization Module (361e3b15) — THIS company's ACTIVE payroll cycle names, for the Default Payroll
  // Cycle picker on the General tab.
  activeCycleNames?: string[];
  actions: {
    updateCompany: Action;
    archiveCompany: Action;
    deleteCompany: Action;
    setParent: Action;
    setStatutory: Action;
    setBankProfile: Action;
    removeBankProfile: Action;
    setStatutoryAuthority: Action;
    removeStatutoryAuthority: Action;
    setCompanyLogo: Action;
    removeCompanyLogo: Action;
    updateCompanyDefaultCycle: Action;
  };
}) {
  const t = useTranslations('admin.organization');
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabKey>('general');
  const c = company;
  const isMY = c.country === 'MY';
  // Readiness for the monthly filings: the three agency identifiers reports key on.
  const statMissing = isMY
    ? [statutory?.epfEmployerNo, statutory?.socsoEmployerCode, statutory?.lhdnEmployerNo].filter((v) => !v).length
    : 0;

  // NOT the <li>: OrganizationList owns the row element, because it is the only side of the RSC boundary
  // that can still address this row. Everything below arrives on the client as an opaque node — possibly a
  // deferred Flight lazy — so search-hiding is applied to the wrapping <li> there, never to this element.
  return (
    <div className={c.archivedAt ? 'opacity-60' : undefined}>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          aria-expanded={expanded}
        >
          <svg
            viewBox="0 0 20 20"
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            aria-hidden
          >
            <path d="M7.5 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <CompanyLogo hasLogo={c.hasLogo} companyId={c.id} name={c.name} />
          <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
          {c.registrationNo && <span className="text-xs text-muted-foreground">{c.registrationNo}</span>}
          <span className={badge.muted}>{c.country}</span>
          {c.archivedAt && <span className={badge.muted}>{t('archived')}</span>}
        </button>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {isMY &&
            (statMissing === 0 ? (
              <span className={badge.emerald}>{t('statutoryComplete')}</span>
            ) : (
              <span className={badge.amber}>{t('statutoryPartial', { ready: 3 - statMissing, total: 3 })}</span>
            ))}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-4">
          {/* Tab bar — groups the company detail sections so the panel reads as tabs, not one long scroll. */}
          <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
            <TabButton active={tab === 'general'} onClick={() => setTab('general')}>
              {t('tabGeneral')}
            </TabButton>
            <TabButton active={tab === 'bankAccount'} onClick={() => setTab('bankAccount')}>
              {t('tabBankAccount')}
            </TabButton>
            <TabButton active={tab === 'statutory'} onClick={() => setTab('statutory')}>
              {t('tabStatutory')}
            </TabButton>
          </div>

          {/* General: company details, group parent, logo, archive/delete */}
          <div className={cn('space-y-4', tab === 'general' ? '' : 'hidden')}>
          {/* Company master data — Company Information + Contact Information (bc5d4891). One form, one save. */}
          <form action={actions.updateCompany} className="space-y-4 rounded-lg bg-background p-3">
            <input type="hidden" name="id" value={c.id} />

            {/* Company Information */}
            <div className="space-y-2.5">
              <SubHeader>{t('sectionCompanyInfo')}</SubHeader>
              <Field label={t('legalName')}>
                <input name="legalName" required defaultValue={c.name} className={inputCls} />
              </Field>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label={t('companyLabel')}>
                  <input name="companyLabel" defaultValue={c.companyLabel ?? ''} className={inputCls} placeholder={t('companyLabelHint')} />
                </Field>
                <Field label={t('regNo')}>
                  <input name="registrationNo" defaultValue={c.registrationNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('industry')}>
                  <input name="industry" defaultValue={c.industry ?? ''} className={inputCls} />
                </Field>
                <Field label={t('businessType')}>
                  <input name="businessType" defaultValue={c.businessType ?? ''} className={inputCls} placeholder={t('businessTypeHint')} />
                </Field>
              </div>
              <Field label={t('website')}>
                <input
                  name="website"
                  type="url"
                  inputMode="url"
                  defaultValue={c.website ?? ''}
                  className={inputCls}
                  placeholder={t('websiteHint')}
                  title={t('websiteHint')}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                {/* 94ae7e1f — country is now the complete ISO list (shared lib/countries), stored as the
                    same ISO alpha-2 code that drives statutory-pack + holiday matching. Legacy-tolerant: an
                    out-of-list stored code is still shown so editing another field never drops it. */}
                <Field label={t('country')}>
                  <select name="country" defaultValue={c.country} required className={inputCls}>
                    {c.country && !COUNTRY_CODE_OPTIONS.some((o) => o.value === c.country) ? (
                      <option value={c.country}>{c.country}</option>
                    ) : null}
                    {COUNTRY_CODE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {/* r79a (4fb8b75a step 3) — this field is now the company's ONE currency: it absorbed
                    company_payroll_config.default_currency, so the Basic Salary form preselects it for a
                    brand-new salary record. A free-text 3-letter box would have let 'ZZZ' onto a salary
                    form, so it becomes the same searchable ISO 4217 picker the salary form itself uses
                    (core/admin.ts validates the posted code against the same master). */}
                <Field label={t('currency')}>
                  <CurrencySelect name="currency" value={c.currency} />
                </Field>
              </div>
            </div>

            {/* Contact Information — registered office / correspondence details */}
            <div className="space-y-2.5 border-t border-border/60 pt-3">
              <SubHeader>{t('sectionContactInfo')}</SubHeader>
              <Field label={t('addressLine1')}>
                <textarea name="addressLine1" rows={2} defaultValue={c.addressLine1 ?? ''} className={`${inputCls} min-h-[2.25rem] resize-y`} />
              </Field>
              <Field label={t('addressLine2')}>
                <textarea name="addressLine2" rows={2} defaultValue={c.addressLine2 ?? ''} className={`${inputCls} min-h-[2.25rem] resize-y`} />
              </Field>
              <Field label={t('addressLine3')}>
                <textarea name="addressLine3" rows={2} defaultValue={c.addressLine3 ?? ''} className={`${inputCls} min-h-[2.25rem] resize-y`} />
              </Field>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t('city')}>
                  <input name="city" defaultValue={c.city ?? ''} className={inputCls} />
                </Field>
                <Field label={t('addrState')}>
                  <OptionSelect name="state" value={c.state} options={stateOptions} placeholder={t('optionNone')} />
                </Field>
                <Field label={t('postcode')}>
                  <input name="postcode" defaultValue={c.postcode ?? ''} className={inputCls} />
                </Field>
                <Field label={t('addrCountry')}>
                  {/* 94ae7e1f — the complete ISO country list replaces the old 7-entry curated catalog. */}
                  <OptionSelect name="addressCountry" value={c.addressCountry} options={COUNTRY_NAME_OPTIONS} placeholder={t('optionNone')} />
                </Field>
                <Field label={t('phone')}>
                  <input name="phone" type="tel" defaultValue={c.phone ?? ''} className={inputCls} />
                </Field>
                <Field label={t('fax')}>
                  <input name="fax" type="tel" defaultValue={c.fax ?? ''} className={inputCls} />
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <Button type="submit" size="sm">
                {t('saveDetails')}
              </Button>
            </div>
          </form>

          {/* Organization Module (361e3b15) — Default Payroll Cycle. Lists THIS company's ACTIVE cycles with
              the saved default pre-selected. Changing it affects FUTURE runs only (batches snapshot their run
              type at creation) and is audit-trailed. If the saved default is no longer active (archived or
              renamed), an inline note flags it and the admin re-points — no silent invalid selection. */}
          <form action={actions.updateCompanyDefaultCycle} className="space-y-2.5 rounded-lg bg-background p-3">
            <SubHeader>{t('defaultPayrollCycle')}</SubHeader>
            <input type="hidden" name="companyId" value={c.id} />
            {(() => {
              const savedActive = activeCycleNames.includes(c.defaultPayrollCycle);
              return (
                <>
                  <Field label={t('defaultPayrollCycle')}>
                    <select
                      name="defaultPayrollCycle"
                      defaultValue={savedActive ? c.defaultPayrollCycle : ''}
                      className={inputCls}
                      disabled={activeCycleNames.length === 0}
                    >
                      {!savedActive && <option value="">{t('optionNone')}</option>}
                      {activeCycleNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {activeCycleNames.length === 0 ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">{t('defaultPayrollCycleNoActive')}</p>
                  ) : !savedActive ? (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      {t('defaultPayrollCycleInactive', { name: c.defaultPayrollCycle })}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('defaultPayrollCycleHint')}</p>
                  )}
                  <Button type="submit" size="sm" variant="outline" disabled={activeCycleNames.length === 0}>
                    {t('saveDefaultPayrollCycle')}
                  </Button>
                </>
              );
            })()}
          </form>

          {/* Group parent + archive/delete */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="space-y-3">
              <form action={actions.setParent} className="space-y-2.5 rounded-lg bg-background p-3">
                <SubHeader>{t('groupParent')}</SubHeader>
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('parentCompany')}>
                  <select name="parentCompanyId" defaultValue={c.parentId ?? ''} className={inputCls}>
                    <option value="">{t('noneGroupRoot')}</option>
                    {companies
                      .filter((o) => o.id !== c.id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Button type="submit" size="sm" variant="outline">
                  {t('setParent')}
                </Button>
              </form>

              <div className="flex items-center gap-1.5 rounded-lg bg-background p-3">
                {c.archivedAt ? (
                  <form action={actions.archiveCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="archived" value="false" />
                    <Button type="submit" size="sm" variant="ghost">
                      {t('unarchive')}
                    </Button>
                  </form>
                ) : c.inUse ? (
                  <form action={actions.archiveCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="archived" value="true" />
                    <Button type="submit" size="sm" variant="ghost">
                      {t('archiveCompany')}
                    </Button>
                  </form>
                ) : (
                  <form action={actions.deleteCompany}>
                    <input type="hidden" name="id" value={c.id} />
                    <ConfirmSubmit
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title={t('deleteCompanyTitle')}
                      description={t('deleteCompanyDescription')}
                      confirmLabel={t('delete')}
                    >
                      {t('deleteCompany')}
                    </ConfirmSubmit>
                  </form>
                )}
                <span className="text-xs text-muted-foreground">
                  {c.inUse ? t('inUseArchiveInstead') : t('notReferenced')}
                </span>
              </div>
            </div>
          </div>

          {/* Company logo — branding (upload PNG/JPG, replace, remove). Admin-only writes (RLS). */}
          <div className="space-y-2.5 rounded-lg bg-background p-3">
            <SubHeader>{t('logoSection')}</SubHeader>
            <div className="flex flex-wrap items-center gap-3">
              <CompanyLogo hasLogo={c.hasLogo} companyId={c.id} name={c.name} className="size-12" />
              <form action={actions.setCompanyLogo} className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="companyId" value={c.id} />
                <input
                  type="file"
                  name="logo"
                  required
                  accept="image/png,image/jpeg"
                  className="max-w-[16rem] text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/70"
                />
                <Button type="submit" size="sm">
                  {c.hasLogo ? t('logoReplace') : t('logoUpload')}
                </Button>
              </form>
              {c.hasLogo && (
                <form action={actions.removeCompanyLogo}>
                  <input type="hidden" name="companyId" value={c.id} />
                  <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">
                    {t('logoRemove')}
                  </Button>
                </form>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{c.hasLogo ? t('logoHint') : `${t('logoNone')} · ${t('logoHint')}`}</p>
          </div>
          </div>
          {/* end General tab */}

          {/* Bank Account: bank disbursement profiles (94ae7e1f — relocated out of the old Payroll tab, since
              disbursement is a banking concern, not a statutory one). Data/logic (core/bank-profile) unchanged. */}
          <div className={cn('space-y-4', tab === 'bankAccount' ? '' : 'hidden')}>
          {/* Bank disbursement profiles (ADR-0031) — bank-issued corporate ID + employer debit account */}
          {isMY ? (
            <div className="space-y-3 rounded-lg bg-background p-3">
              <SubHeader>{t('bankProfilesTitle')}</SubHeader>
              {/* R46: a company may hold SEVERAL accounts, including more than one at the same bank, so each
                  saved account is its own editable form (identity is the row id) rather than one upsert box. */}
              {bankProfiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noBankProfiles')}</p>
              ) : (
                <ul className="space-y-2">
                  {bankProfiles.map((bp) => (
                    <li key={bp.id} className="rounded-md border border-border/60">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
                          <span className="min-w-0 text-sm">
                            <span className="font-medium">{bp.accountLabel || myBankLabel(bp.bank)}</span>
                            {bp.isPrimary && <span className={`ml-2 ${badge.emerald}`}>{t('bankPrimary')}</span>}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {myBankLabel(bp.bank)} · ••••{bp.debitAccountNo.slice(-4)} · {bp.currency}
                            </span>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            <span className="group-open:hidden">{t('bankAccountEdit')}</span>
                            <span className="hidden group-open:inline">{t('bankAccountCollapse')}</span>
                          </span>
                        </summary>
                        <div className="border-t border-border/60 px-3 py-3">
                          <BankAccountForm action={actions.setBankProfile} companyId={c.id} companyName={c.name} profile={bp} />
                          <form action={actions.removeBankProfile} className="mt-2">
                            <input type="hidden" name="id" value={bp.id} />
                            <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                              {t('bankProfileRemove')}
                            </button>
                          </form>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
              <details className="rounded-md border border-dashed border-border">
                <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
                  {t('bankAccountAdd')}
                </summary>
                <div className="border-t border-border/60 px-3 py-3">
                  <BankAccountForm action={actions.setBankProfile} companyId={c.id} companyName={c.name} profile={null} />
                </div>
              </details>
              <p className="text-xs text-muted-foreground">{t('bankProfilesHint')}</p>
              <p className="text-xs text-muted-foreground">{t('bankMasterHint')}</p>
            </div>
          ) : (
            <p className="rounded-lg bg-background p-3 text-xs text-muted-foreground">
              {t('bankAccountNonMY', { country: c.country })}
            </p>
          )}
          </div>
          {/* end Bank Account tab */}

          {/* Statutory: statutory identity (94ae7e1f — the old "Payroll" tab, renamed; it only ever held
              statutory configuration). Country-pack section (ADR-0008). */}
          <div className={cn('space-y-4', tab === 'statutory' ? '' : 'hidden')}>
          {isMY ? (
            <>
            <form action={actions.setStatutory} className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('statutoryIdentityMY')}</SubHeader>
              <input type="hidden" name="companyId" value={c.id} />
              <input type="hidden" name="country" value="MY" />
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Field label={t('epfEmployerNo')}>
                  <input name="epfEmployerNo" defaultValue={statutory?.epfEmployerNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('socsoEmployerCode')}>
                  <input
                    name="socsoEmployerCode"
                    defaultValue={statutory?.socsoEmployerCode ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('lhdnENumber')}>
                  <input name="lhdnEmployerNo" defaultValue={statutory?.lhdnEmployerNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('myinvoisTin')}>
                  <input name="myinvoisTin" defaultValue={statutory?.myinvoisTin ?? ''} className={inputCls} />
                </Field>
                <Field label={t('ssmRegistrationNo')}>
                  <input
                    name="ssmRegistrationNo"
                    defaultValue={statutory?.ssmRegistrationNo ?? ''}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('hrdfStatusLabel')}>
                  <select
                    name="hrdfStatus"
                    defaultValue={statutory?.hrdfStatus ?? 'not_registered'}
                    className={inputCls}
                  >
                    <option value="not_registered">{t('hrdfNotRegistered')}</option>
                    <option value="mandatory">{t('hrdfMandatory')}</option>
                    <option value="optional">{t('hrdfOptional')}</option>
                  </select>
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('statutoryFilingsHint')}
              </p>
              {/* The HRDF headcount hint ("mandatory at 10+, optional at 5–9") is deliberately gone —
                  HRDF eligibility is a free company choice, not a headcount rule. */}
              <Button type="submit" size="sm">
                {t('saveStatutoryIdentity')}
              </Button>
            </form>

            {/* R46 orgbank (84719377) — per-authority PAYMENT setup. The form above holds the employer
                IDENTITY (one flat row per company); this section holds, per statutory body, which company
                bank account pays it, its address/contact, and the authorised signatory. Every authority in
                the controlled set is listed whether configured or not, so nothing is silently missing. */}
            <div className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('authoritiesTitle')}</SubHeader>
              <p className="text-xs text-muted-foreground">{t('authoritiesHint')}</p>
              {bankProfiles.length === 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{t('authoritiesNoBankAccounts')}</p>
              )}
              <ul className="space-y-2">
                {STATUTORY_AUTHORITIES.map((a) => (
                  <StatutoryAuthorityCard
                    key={a}
                    authority={a}
                    row={statutoryAuthorities.find((r) => r.authority === a) ?? null}
                    companyId={c.id}
                    bankProfiles={bankProfiles}
                    signatories={signatories}
                    stateOptions={stateOptions}
                    setAction={actions.setStatutoryAuthority}
                    removeAction={actions.removeStatutoryAuthority}
                  />
                ))}
              </ul>
            </div>
            </>
          ) : (
            <p className="rounded-lg bg-background p-3 text-xs text-muted-foreground">
              {t('noStatutoryPack', { country: c.country })}
            </p>
          )}
          </div>
          {/* end Statutory tab */}
        </div>
      )}
    </div>
  );
}
