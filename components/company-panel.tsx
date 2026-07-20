'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { COUNTRY_CODE_OPTIONS, COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { DISBURSEMENT_CAPABLE_BANKS, DISBURSEMENT_UNSUPPORTED_BANKS, myBankLabel } from '@/lib/my-banks';
import { Avatar, Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

// 94ae7e1f — the company config panel is reorganised into three tabs: General / Bank Account / Statutory.
// The old "Payroll" tab is renamed Statutory (it only ever held statutory identity), and the Bank
// Disbursement Profiles move out of it into a dedicated Bank Account tab (disbursement is a banking concern,
// not a statutory one). Pure UI/relocation — the underlying statutory + bank-profile data/logic is unchanged.
type TabKey = 'general' | 'bankAccount' | 'statutory';

/** One tab trigger — mirrors the payroll-tabs styling (border-b, active = border-primary text-primary). */
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
  stateOptions = [],
  actions,
  className,
}: {
  company: PanelCompany;
  companies: { id: string; name: string }[];
  statutory: PanelStatutory;
  bankProfiles: PanelBankProfile[];
  // Enhance Company General Tab (bc5d4891) — tenant-wide catalog for the Contact-Info State picker. The
  // Country picker (94ae7e1f) now uses the complete shared ISO list (lib/countries), not a curated catalog.
  stateOptions?: PanelOption[];
  actions: {
    updateCompany: Action;
    archiveCompany: Action;
    deleteCompany: Action;
    setParent: Action;
    setStatutory: Action;
    setBankProfile: Action;
    removeBankProfile: Action;
    setCompanyLogo: Action;
    removeCompanyLogo: Action;
  };
  // Applied by OrganizationList to CSS-hide non-matching rows during search (keeps the panel mounted).
  className?: string;
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

  return (
    <li className={cn(c.archivedAt ? 'opacity-60' : '', className)}>
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
                <Field label={t('currency')}>
                  <input name="currency" defaultValue={c.currency} pattern="[A-Za-z]{3}" maxLength={3} title={t('currencyHint')} className={`${inputCls} uppercase`} />
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
            <div className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('bankProfilesTitle')}</SubHeader>
              {bankProfiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noBankProfiles')}</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {bankProfiles.map((bp) => (
                    <li key={bp.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0 text-sm">
                        <span className="font-medium">{myBankLabel(bp.bank)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {bp.corporateId} · ••••{bp.debitAccountNo.slice(-4)} · {bp.txnType}
                        </span>
                      </div>
                      <form action={actions.removeBankProfile}>
                        <input type="hidden" name="id" value={bp.id} />
                        <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                          {t('bankProfileRemove')}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              <form action={actions.setBankProfile} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input type="hidden" name="companyId" value={c.id} />
                <Field label={t('bankLabel')}>
                  <select name="bank" defaultValue="" required className={inputCls}>
                    <option value="" disabled>
                      {t('bankSelect')}
                    </option>
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
                <Field label={t('bankTxnType')}>
                  <select name="txnType" defaultValue="IBG" className={inputCls}>
                    <option value="IBG">IBG</option>
                    <option value="RENTAS">RENTAS</option>
                  </select>
                </Field>
                <Field label={t('bankCorporateId')}>
                  <input name="corporateId" required className={inputCls} placeholder={t('bankCorporateIdHint')} />
                </Field>
                <Field label={t('bankDebitAccount')}>
                  <input name="debitAccountNo" required className={inputCls} />
                </Field>
                <div className="sm:col-span-2">
                  <Field label={t('bankOrgName')}>
                    <input name="orgName" defaultValue={c.name} className={inputCls} />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Button type="submit" size="sm">
                    {t('bankProfileSave')}
                  </Button>
                </div>
              </form>
              <p className="text-xs text-muted-foreground">{t('bankProfilesHint')}</p>
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
              <p className="text-xs text-muted-foreground">{t('hrdfHint')}</p>
              <Button type="submit" size="sm">
                {t('saveStatutoryIdentity')}
              </Button>
            </form>
          ) : (
            <p className="rounded-lg bg-background p-3 text-xs text-muted-foreground">
              {t('noStatutoryPack', { country: c.country })}
            </p>
          )}
          </div>
          {/* end Statutory tab */}
        </div>
      )}
    </li>
  );
}
