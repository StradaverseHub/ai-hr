'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Avatar, Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

type Action = (fd: FormData) => void | Promise<void>;

export type PanelCompany = {
  id: string;
  name: string;
  country: string;
  currency: string;
  registrationNo: string | null;
  archivedAt: Date | null;
  inUse: boolean;
  parentId: string | null;
  hasLogo: boolean;
};
export type PanelStatutory = {
  epfEmployerNo: string | null;
  socsoEmployerCode: string | null;
  lhdnEmployerNo: string | null;
  myinvoisTin: string | null;
  ssmRegistrationNo: string | null;
  hrdfStatus: 'not_registered' | 'mandatory' | 'optional' | null;
} | null;
export type PanelBankProfile = {
  id: string;
  bank: 'maybank' | 'cimb' | 'public_bank' | 'rhb';
  corporateId: string;
  debitAccountNo: string;
  orgName: string | null;
  txnType: string;
};
const BANK_LABEL: Record<PanelBankProfile['bank'], string> = {
  maybank: 'Maybank',
  cimb: 'CIMB',
  public_bank: 'Public Bank',
  rhb: 'RHB',
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
  actions,
  className,
}: {
  company: PanelCompany;
  companies: { id: string; name: string }[];
  statutory: PanelStatutory;
  bankProfiles: PanelBankProfile[];
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
        <div className="space-y-4 border-t border-border/60 bg-muted/20 px-4 py-4">
          {/* Company details + group parent */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <form action={actions.updateCompany} className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('details')}</SubHeader>
              <input type="hidden" name="id" value={c.id} />
              <Field label={t('legalName')}>
                <input name="legalName" required defaultValue={c.name} className={inputCls} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label={t('regNo')}>
                  <input name="registrationNo" defaultValue={c.registrationNo ?? ''} className={inputCls} />
                </Field>
                <Field label={t('country')}>
                  <input name="country" defaultValue={c.country} pattern="[A-Za-z]{2}" maxLength={2} title={t('countryHint')} className={`${inputCls} uppercase`} />
                </Field>
                <Field label={t('currency')}>
                  <input name="currency" defaultValue={c.currency} pattern="[A-Za-z]{3}" maxLength={3} title={t('currencyHint')} className={`${inputCls} uppercase`} />
                </Field>
              </div>
              <div className="flex items-center gap-1.5">
                <Button type="submit" size="sm">
                  {t('saveDetails')}
                </Button>
              </div>
            </form>

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

          {/* Statutory identity — country-pack section (ADR-0008) */}
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

          {/* Bank disbursement profiles (ADR-0031) — bank-issued corporate ID + employer debit account */}
          {isMY && (
            <div className="space-y-2.5 rounded-lg bg-background p-3">
              <SubHeader>{t('bankProfilesTitle')}</SubHeader>
              {bankProfiles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('noBankProfiles')}</p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {bankProfiles.map((bp) => (
                    <li key={bp.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0 text-sm">
                        <span className="font-medium">{BANK_LABEL[bp.bank]}</span>
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
                    {(Object.keys(BANK_LABEL) as PanelBankProfile['bank'][]).map((b) => (
                      <option key={b} value={b}>
                        {BANK_LABEL[b]}
                      </option>
                    ))}
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
          )}
        </div>
      )}
    </li>
  );
}
