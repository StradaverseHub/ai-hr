'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  BookOpen,
  GraduationCap,
  HandCoins,
  Landmark,
  type LucideIcon,
  Moon,
  PiggyBank,
  ShieldPlus,
  Umbrella,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { COUNTRY_CODE_OPTIONS, COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { type CompanyPanelTab } from '@/lib/company-panel-tabs';
import { type TabSaveResult } from '@/lib/tab-save-sections';
import { firstDirtyGuard } from '@/lib/unsaved-changes';
import { TabSaveScope } from './tab-save-scope';
import { DISBURSEMENT_CAPABLE_BANKS, DISBURSEMENT_UNSUPPORTED_BANKS, MY_BANKS, myBankLabel } from '@/lib/my-banks';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
// 15e5bd93 — the Statutory tab's own consolidated-Save vocabulary. The eight body sections ARE their
// authority keys; `identity` is the SSM / MyInvois registrations card.
import { STATUTORY_IDENTITY_SECTION } from '@/lib/company-statutory-tab-sections';
import { Button, Field, inputCls } from './ui';
// 7d2df42a — the Company Code input and its duplicate warning, shared with the create form so the two
// screens that edit this column cannot disagree about what a duplicate is.
import { CompanyCodeField } from './company-code-field';
import type { CompanyCodeHolder } from '@/lib/company-code';
import { ConfirmSubmit } from './ui/confirm-submit';
import { CompanyLogo, CompanyLogoEdit } from './company-logo';
import { EmployeeSearchField, type EmployeeSearchOption } from './employee-search-field';
// r79a — company.currency is now the salary-form default currency, so it uses the same ISO 4217 picker.
import { CurrencySelect } from './currency-select';

// r226 — the company config panel is THREE tabs: General / Bank Account / Statutory.
//
// ⚠️ THIS IS A REVERT, AND IT IS DELIBERATE. 94ae7e1f shipped exactly this tab set. 3c2f55d7 rev 2 deleted
// the Bank Account tab on the reporter's own instruction and folded the bank details into an "Other" tab
// alongside the default payroll cycle, the group parent and archive/delete. The reporter has since asked,
// in writing, for Bank Account back in slot two — so it comes back, and "Other" GOES rather than being
// renamed around it: "Other" was never a bank tab, it was four unrelated things, and calling it "Bank
// Account" would have filed "Delete this company" under a friendly heading. The three non-bank sections
// move to General, where company administration belongs.
//
// Pure relocation: the bank-profile and statutory data/logic are unchanged, and every tab's content stays
// MOUNTED (hidden by CSS), so an in-progress edit still survives a tab switch.
//
// The guard that pinned the REMOVAL (test/company-panel-bank-statutory-layout.test.ts) was updated with
// this change, not deleted — the half of it that is still true (Bank Account content stays whole, wherever
// it lives) is still asserted.
// 65b22c00 — the three keys are declared once, in lib/company-panel-tabs.ts, because the page and the
// server actions need the same closed list and neither can read a value out of a 'use client' module.
type TabKey = CompanyPanelTab;

/**
 * 65b22c00 — THE FIELD THAT TELLS A SERVER ACTION WHICH TAB IT WAS SUBMITTED FROM.
 *
 * Injected into whichever form is submitting by the capture-phase listener in CompanyPanel, exactly as
 * components/personnel-tabs.tsx does it (feedback bd2f0bb2): the alternative is a hidden input hand-added
 * to thirteen forms across two files, one of which would be forgotten.
 */
const TAB_TRACKER_ATTR = 'data-company-tab-tracker';

/**
 * The visual mark on each statutory body's ROW.
 *
 * ⚠️ THIS REVERSES 3c2f55d7 rev 2, AND THE REASON IT GAVE IS THE REASON IT CAN BE REVERSED. That round
 * refused the official logos in these words: "this repo bundles no remote assets, and reproducing a
 * government agency's mark inside a product needs permission we do not have on file… swapping in a
 * licensed mark later is a one-line change here."
 *
 * efe424b0 (r327) — the reporter ATTACHED all seven marks to the request themselves (KWSP, PERKESO,
 * LHDN, Zakat, PTPTN, Tabung Haji, HRDF). That is the condition the old comment named, and they are the
 * owner of the deployment these identify. The files are committed under public/statutory/ rather than
 * fetched, so the "bundles no remote assets" half still holds exactly as before.
 *
 * ⚠️ THE ICON FALLBACK STAYS, and it is not vestigial: a body with no logo file falls back to its Lucide
 * mark, so adding an authority can never render a blank tile. That property is why AUTHORITY_ICON had a
 * default in the first place and it survives the change.
 */
/**
 * ⚠️ efe424b0 — WHY "SOCSO & EIS" CANNOT BE ONE CONFIGURATION, ONLY ONE ROW.
 *
 * The request says: consolidate SOCSO and EIS. The EIS card has said for some time that EIS has no
 * filing number of its own because it files under SOCSO's PERKESO employer code, which makes the merge
 * sound free. It is not, and the data says so.
 *
 * MEASURED ON PRODUCTION 2026-09-22, `company_statutory_authority` holds a SEPARATE row per body with
 * its own payment account, bank profile and signatory — and they DIFFER:
 *
 *     eis   | bank=d7347908… | acct=SMSB_EIS        socso | bank=d7347908… | acct=SMSB_SOCSO
 *     eis   | bank=(none)    | acct=E1400003148V    socso | (no counterpart)
 *     socso | sig=af6dfdc1…                          eis   | (no counterpart)
 *
 * So a company can pay EIS on a different account from SOCSO, and one already does. Drawing ONE card
 * backed by SOCSO's row would leave `SMSB_EIS` on file with no screen that can edit it — a setting that
 * still governs a payment, quietly unreachable. That is the failure this note exists to prevent.
 *
 * WHAT CONSOLIDATION THEREFORE MEANS HERE: one ROW in the list, named for both bodies and carrying the
 * PERKESO mark once — and, when opened, BOTH configurations. The filing code stays stated once, because
 * that genuinely is shared; the payment details stay two, because they genuinely are not.
 */
const AUTHORITY_LOGO: Record<string, string> = {
  epf: '/statutory/kwsp.png',
  socso: '/statutory/perkeso.png',
  // EIS files under PERKESO and is drawn with SOCSO in one row — see the consolidation note below.
  eis: '/statutory/perkeso.png',
  lhdn: '/statutory/lhdn.png',
  hrdf: '/statutory/hrdf.png',
  zakat: '/statutory/zakat.png',
  ptptn: '/statutory/ptptn.png',
  tabung_haji: '/statutory/tabunghaji.png',
};

/**
 * The fallback mark, keyed by the same strings as lib/statutory-authorities.ts.
 */
const AUTHORITY_ICON: Record<string, LucideIcon> = {
  epf: PiggyBank, // retirement savings
  socso: ShieldPlus, // injury / invalidity cover
  eis: Umbrella, // retrenchment cover
  lhdn: Landmark, // the revenue board
  hrdf: GraduationCap, // training levy
  zakat: HandCoins, // religious contribution
  ptptn: BookOpen, // study loan
  tabung_haji: Moon, // pilgrimage savings
};

/** One tab trigger — mirrors the claims-tabs styling (border-b, active = border-primary text-primary). */
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
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
        {action}
        <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

type Action = (fd: FormData) => void | Promise<void>;
/**
 * 65b22c00 — the consolidated General-tab Save. It RETURNS rather than redirecting, which is what lets
 * it report which of the three cards failed; see lib/company-tab-sections.ts.
 */
type TabSaveAction = (fd: FormData) => Promise<TabSaveResult>;

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
/**
 * An ACTIVE employee of this company — the authorised-signatory picker is company-scoped.
 *
 * 3c2f55d7 rev 2 — `employeeCode` is carried so the picker can be SEARCHED by Employee ID as well as by
 * name (the reporter asked for both). The scope rule is unchanged: the service still refuses to newly
 * appoint anyone who is not an active employee of THIS company, so widening this list would only produce
 * saves that fail.
 */
export type PanelSignatory = { personId: string; name: string; employeeCode: string | null };

const badge = {
  amber:
    'rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  // 3783fd87 — a LINED chip, not a filled grey one. Same reason as the section blocks: on a white card
  // a grey fill is the thing the reporter asked us to take out, and a border carries the same boundary.
  muted:
    'rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
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
 * WHICH FILING NUMBER BELONGS TO WHICH BODY (r226).
 *
 * There are TWO numbers per statutory body, and until this round nothing on screen said so:
 *
 *   • the EMPLOYER ACCOUNT / REFERENCE number — the one on the payment slip. It has always lived on the
 *     body's own card (company_statutory_authority.accountNo, `name="accountNo"` below).
 *   • the FILING number — the one that goes on the body's filed form. It lived in a single flat list
 *     above the cards (company_statutory_my), which is what made the two look like duplicates.
 *
 * They are not duplicates. This map moves the second one onto the same card as the first, and both are
 * now labelled so a reader can tell them apart.
 *
 * ⚠️ WHAT IS DELIBERATELY ABSENT, because "add the missing ones" is the obvious next edit and it is wrong:
 *
 *   • SSM and MyInvois get NO entry and no card. Neither is a body an employer pays a contribution to,
 *     neither is in STATUTORY_AUTHORITIES, and the SSM number is read by two statutory files we produce
 *     (localization/my/borang-8a.ts:145, localization/my/socso-eis-file.ts:140) — filing it under a
 *     payment card would be actively misleading. They stay in the identity list on the Statutory tab.
 *   • EIS gets no entry either: it files under the SAME PERKESO employer code as SOCSO. A second input
 *     writing socsoEmployerCode would be two controls fighting over one column, and whichever card was
 *     saved second would win. The EIS card says so in words instead (`authorityEisSharesSocso`).
 *   • HRD Corp's filing identity is not a number but a registration STATUS (the levy rate), so it is
 *     handled separately in the card as the same three-value select it has always been.
 *
 * Each card posts ONLY its own field, and the writer is a partial patch, so one card's save cannot blank
 * another's number — see localization/my/company-statutory.ts and setCompanyStatutoryAuthorityAction.
 */
type MyFilingKey = 'epfEmployerNo' | 'socsoEmployerCode' | 'lhdnEmployerNo';
const MY_FILING_FIELD: Record<string, { name: MyFilingKey; labelKey: string }> = {
  epf: { name: 'epfEmployerNo', labelKey: 'epfEmployerNo' },
  socso: { name: 'socsoEmployerCode', labelKey: 'socsoEmployerCode' },
  lhdn: { name: 'lhdnEmployerNo', labelKey: 'lhdnENumber' },
};

/**
 * ── 15e5bd93 (r352) — WHY THERE ARE NOW TWO COMPONENTS WHERE THERE WAS ONE CARD ──────────────────
 *
 * Until this round each statutory body was ONE `StatutoryAuthorityCard`: a readable face plus its own
 * fourteen-field editor folded behind an "Open settings" toggle. The reporter's complaint about that
 * shape, in their words: "the current behaviour opens the settings in a tab/expand-style interface,
 * which makes the information less clear and less convenient to view or edit."
 *
 * The approved drawing (docs/mockups/15e5bd93-statutory-workspace.html) splits the card in two along the
 * line the fold used to run down:
 *
 *   · `StatutoryBodyRow`    — the body's face, as one row of a PERMANENT left-hand rail. It never
 *                             collapses and it is never the only place a value lives.
 *   · `StatutoryBodyEditor` — the body's fields, ALL of them already open, filling the workspace to the
 *                             right of the rail. Nothing inside it expands.
 *
 * ⚠️ NOTHING IS UNMOUNTED, and that property is older than this round and survives it. All eight editors
 * render; the seven that are not selected are hidden with CSS. So a half-typed address survives a switch
 * between bodies, the consolidated Save can read every body's fields whether or not you are looking at
 * them, and the render guard can still count all eight forms
 * (test/company-panel-no-disclosure-render.test.ts).
 *
 * ⚠️ THE ROW KEEPS THE SUMMARY 3783fd87 PUT ON THE FACE, and that is a deliberate refusal to let this
 * item quietly undo the last one. That round's promise to the same reporter was a body "showing what is
 * set without opening anything — the employer number and the bank account it is paid from — and saying
 * plainly where nothing is set yet", because comparing two bodies meant opening both and remembering the
 * first. A rail listing only names and a Configured chip would put that back: you would have to select
 * each body in turn to read its number. The drawing is a sketch of the LAYOUT (it says so), and the
 * summary is a sub-line of a row it already draws — so it stays, under its own captions.
 *
 * ⚠️ TWO DIFFERENT NUMBERS, TWO CAPTIONS — r226's rule, unchanged. The FILING number goes on the body's
 * filed form (company_statutory_my); the employer account is the reference on its PAYMENT slip
 * (company_statutory_authority). They are not duplicates, and summarising them into one anonymous
 * "employer number" is the exact fault r226 was raised for.
 *
 * ⚠️ NO PER-BODY ROUTE. Selection is client state and there is no `/admin/organization/<id>/<body>`:
 * a route would need its own entry in the function-access matrix (lib/permissions.ts) and would put a
 * page load between "which body do I mean" and "here are its fields" — the opposite of what the redesign
 * is for. The argument is the same one that kept the editor in place in 3c2f55d7 rev 2.
 */

/**
 * ONE STATUTORY BODY, AS A ROW OF THE PERMANENT RAIL.
 *
 * The face: the body's own mark, its name, a one-line description, Configured / Not set up, and the
 * summary of what is on file. Read-only throughout — it renders text, never a control, because the
 * editor beside it is the only writer and `company_statutory_authority` is also what the EA officer
 * block and the CP39 preparer block read (localization/my/reports.ts).
 *
 * The `<dl>` sits OUTSIDE the selection `<button>` on purpose: a button may only contain phrasing
 * content, and a definition list inside one is markup a screen reader has to guess at.
 */
function StatutoryBodyRow({
  authority,
  row,
  statutory,
  subordinate = false,
  filingCountry,
  bankProfiles,
  selected,
  onSelect,
}: {
  authority: string;
  row: PanelStatutoryAuthority | null;
  // r226 — the company's statutory IDENTITY row, so the row can show this body's filing number next to
  // its payment setup. The whole row is passed and the face picks its own field (MY_FILING_FIELD).
  statutory: PanelStatutory;
  /**
   * efe424b0 — draw this body as part of the group ABOVE it rather than as its own entry: indented, and
   * without a second copy of the mark its group head already carries. Only EIS under SOCSO today.
   *
   * It is a presentation flag and nothing else. The body keeps its own editor, its own authority value
   * and its own record — which is the point, because EIS's payment account genuinely differs from
   * SOCSO's on this tenant (see the note on AUTHORITY_LOGO).
   */
  subordinate?: boolean;
  /** ISO code of the company. 'MY' is the only pack with a filing identity today. */
  filingCountry: string;
  bankProfiles: PanelBankProfile[];
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations('admin.organization');
  const r = row;
  const configured = !!r;
  const Icon = AUTHORITY_ICON[authority] ?? Landmark;
  /** efe424b0 — the body's own mark when we have the file; the Lucide fallback when we do not. */
  const logo = AUTHORITY_LOGO[authority];
  // r226 — this body's FILING identity (the number on its filed form), where it has one. Distinct from
  // `accountNo`, which is the employer account on the PAYMENT SLIP. See MY_FILING_FIELD.
  const filing = filingCountry === 'MY' ? MY_FILING_FIELD[authority] : undefined;
  const showHrdf = filingCountry === 'MY' && authority === 'hrdf';

  /**
   * ⚠️ AN ABSENT VALUE SAYS "Not set"; IT NEVER GUESSES. HRD Corp's band is shown only when the identity
   * row actually carries one: payroll resolves a MISSING row to 'not_registered' and charges nothing,
   * but printing "Not registered" for a company that has no row at all would assert a registration
   * decision nobody made. EIS gets no filing line because it has none — it files under SOCSO's PERKESO
   * code, which the editor says in words.
   */
  const hrdfBandKey =
    statutory?.hrdfStatus === 'mandatory'
      ? 'hrdfMandatory'
      : statutory?.hrdfStatus === 'optional'
        ? 'hrdfOptional'
        : statutory?.hrdfStatus === 'not_registered'
          ? 'hrdfNotRegistered'
          : null;
  const paidFrom = bankProfiles.find((bp) => bp.id === r?.bankProfileId);
  const summary: { key: string; label: string; value: string | null }[] = [
    ...(filing
      ? [{ key: 'filing', label: t(filing.labelKey as never), value: statutory?.[filing.name] || null }]
      : []),
    ...(showHrdf
      ? [{ key: 'hrdf', label: t('hrdfStatusLabel'), value: hrdfBandKey ? t(hrdfBandKey as never) : null }]
      : []),
    { key: 'account', label: t('authorityAccountNo'), value: r?.accountNo || null },
    {
      key: 'bank',
      label: t('authorityBankAccount'),
      value: paidFrom ? (paidFrom.accountLabel || myBankLabel(paidFrom.bank)) + ' · ' + paidFrom.debitAccountNo : null,
    },
  ];

  return (
    <li
      data-statutory-body={authority}
      className={cn(
        'flex flex-col bg-card',
        // efe424b0 — rows in a divided list: the border and the rounding belong to the <ul>, not to each
        // entry, which is what turns eight boxes into one list.
        subordinate && 'pl-6',
      )}
    >
      {/* SELECTION. `aria-current` + the accent fill is the rail pattern this product already uses —
          components/sidebar.tsx and components/leave-type-workspace.tsx. It is NOT a disclosure: it does
          not hide or reveal anything, it chooses which body the workspace is showing. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-start gap-3 p-3 text-left transition-colors',
          selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
        )}
      >
        {/* efe424b0 — the body's OWN mark, from public/statutory/, with the Lucide icon as the fallback
            for a body whose file we do not have. `object-contain` on a fixed box because the seven marks
            are different shapes: letting each set its own height would make the rows jump. Decorative,
            so it carries an empty alt and the body's NAME is the text beside it.
            A SUBORDINATE row shows no mark at all: the group head above it already carries the body's
            logo, and a second copy of PERKESO's would read as a second organisation rather than as the
            same one. The indent and the name carry the relationship instead. */}
        {subordinate ? (
          <span className="mt-1 w-10 shrink-0 text-center text-muted-foreground" aria-hidden>
            &#8735;
          </span>
        ) : (
          <span
            className={cn(
              'grid size-10 shrink-0 place-items-center rounded-lg',
              logo ? 'bg-card' : 'bg-primary/10 text-primary',
            )}
            aria-hidden
          >
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a bundled static mark, not content
              <img src={logo} alt="" className="max-h-8 max-w-9 object-contain" />
            ) : (
              <Icon className="size-5" />
            )}
          </span>
        )}
        <span className="min-w-0 flex-1 space-y-1">
          {/* Dynamic message keys (`authority_epf` / `authorityDesc_epf`, …) — one pair per entry in
              STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's
              existing convention for a computed key. NOTE: the i18n-coverage test cannot see dynamic
              keys, so adding an authority means adding BOTH its label and its description to all six
              locales by hand (test/company-panel-bank-statutory-layout.test.ts checks that they exist). */}
          <span className="block truncate text-sm font-medium">{t(`authority_${authority}` as never)}</span>
          <span className="block text-xs leading-snug text-muted-foreground">
            {t(`authorityDesc_${authority}` as never)}
          </span>
          <span className={configured ? badge.emerald : badge.muted}>
            {configured ? t('authorityConfigured') : t('authorityNotConfigured')}
          </span>
        </span>
      </button>

      {/* 3783fd87 — WHAT IS SET, WITHOUT SELECTING ANYTHING. A <dl> because each entry is a caption and
          its value, and the caption is what stops the two numbers being mistaken for each other.
          Rendered as plain text, never as a disabled input: a greyed-out box looks like something you can
          fix here, and this half of the row is read-only. */}
      <dl className="space-y-0.5 px-3 pb-2.5 text-xs">
        {summary.map((f) => (
          <div key={f.key} className="flex min-w-0 items-baseline gap-1">
            <dt className="shrink-0 text-muted-foreground">{f.label}</dt>
            <dd
              className={cn('truncate', f.value ? 'font-medium text-foreground' : 'italic text-muted-foreground')}
            >
              {f.value ?? t('authorityValueNotSet')}
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

/**
 * ONE STATUTORY BODY'S FIELDS, FILLING THE WORKSPACE. Every field is already open; nothing here expands.
 *
 * ── THE THREE GROUPS, AND WHY THE FIRST ONE HAS TWO FACES ────────────────────────────────────────
 * The approved drawing groups the existing fields under three headings: the filing identity, the payment
 * setup, and the correspondence address. No field is added, removed, renamed or re-validated — the
 * groups are the headings r226 already introduced (`authorityFilingSection`, `authorityPaymentSection`)
 * plus a name for the address block, which was the one run of fields with no heading at all.
 *
 * ⚠️ HRD CORP'S FIRST GROUP IS "Registration", NOT "Filing identity", and that is r226's rule rather
 * than a leftover. HRD Corp's control is not a number — it is a registration BAND (not registered /
 * mandatory / optional) that decides whether the levy is charged at all. Rendering it under a caption
 * promising a filed-form number tells the operator something untrue about the box they are filling in.
 *
 * ⚠️ EIS GETS A SENTENCE WHERE ITS FILING NUMBER WOULD BE. It has none of its own: it files under
 * SOCSO's PERKESO employer code. A second input writing `socsoEmployerCode` would be two controls
 * fighting over one column and whichever was saved second would win; an empty box would read as a number
 * somebody forgot. So: `authorityEisSharesSocso`, in the group where the missing box would have been.
 *
 * ── NO SAVE BUTTON, AND THAT IS WHAT "ONE SAVE" MEANS ────────────────────────────────────────────
 * The form keeps its `action` — not as a no-JavaScript fallback, but because a bound form is what the
 * writer is wired to, because it is what TabSaveScope's submit guard intercepts, and because a `<form>`
 * with no action at all would POST to the current URL. Its submit button is gone: the tab's one sticky
 * Save owns it now (`data-save-section={authority}`). "Clear this authority" is NOT part of that Save —
 * it DELETES the body's row, which is a discrete act, so it keeps its own button outside the marker.
 *
 * ── THE SIGNATORY PICKER ─────────────────────────────────────────────────────────────────────────
 * Scoped to ACTIVE employees of THIS company, searchable by Employee ID or name (EmployeeSearchField).
 * It is legacy-tolerant in the same way the profile-option pickers are: a stored signatory who has since
 * left is injected into the option list as "former employee" so the field still POSTS them, and editing
 * the phone number does not silently clear the signatory. (EmployeeSearchField drops a value that is not
 * in its list, which without this would have turned an unrelated save into a wipe.) The service refuses
 * to newly APPOINT a leaver — that rule is untouched.
 */
function StatutoryBodyEditor({
  authority,
  row,
  statutory,
  filingCountry,
  companyId,
  bankProfiles,
  signatories,
  stateOptions,
  selected,
  setAction,
  removeAction,
}: {
  authority: string;
  row: PanelStatutoryAuthority | null;
  statutory: PanelStatutory;
  filingCountry: string;
  companyId: string;
  bankProfiles: PanelBankProfile[];
  signatories: PanelSignatory[];
  stateOptions: PanelOption[];
  /** Which body the rail has chosen. The other seven stay MOUNTED and are hidden with CSS. */
  selected: boolean;
  setAction: Action;
  removeAction: Action;
}) {
  const t = useTranslations('admin.organization');
  const fieldId = useId();
  const r = row;
  const configured = !!r;
  const filing = filingCountry === 'MY' ? MY_FILING_FIELD[authority] : undefined;
  const showHrdf = filingCountry === 'MY' && authority === 'hrdf';
  const sharesSocsoCode = filingCountry === 'MY' && authority === 'eis';

  // The searchable option list: this company's active employees, plus — only when the saved signatory is
  // no longer among them — the stored person, so the hidden input keeps posting the id already on record.
  const signatoryOptions: EmployeeSearchOption[] = signatories.map((sg) => ({
    value: sg.personId,
    name: sg.name,
    employeeCode: sg.employeeCode,
  }));
  if (r?.signatoryPersonId && !signatories.some((sg) => sg.personId === r.signatoryPersonId)) {
    signatoryOptions.unshift({
      value: r.signatoryPersonId,
      name: t('authoritySignatoryFormer'),
      employeeCode: null,
    });
  }

  return (
    <div data-statutory-workspace={authority} className={cn('space-y-3', !selected && 'hidden')}>
      {/* The workspace head — the body you are editing, and whether it has a record yet. No mark here:
          the rail beside it carries the marks, and a second copy would only compete with them. */}
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{t(`authority_${authority}` as never)}</span>
          <span className={configured ? badge.emerald : badge.muted}>
            {configured ? t('authorityConfigured') : t('authorityNotConfigured')}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t(`authorityDesc_${authority}` as never)}</p>
      </div>

      <form action={setAction} data-save-section={authority} className="space-y-3">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="authority" value={authority} />
        {/* `filingCountry` is the hidden flag that tells the writer a filing control was on this form at
            all, and it is deliberately NOT called `country`: that name is already taken further down by
            the body's postal address, and a collision there would post a country NAME into the
            statutory-pack lookup. Emitted once, for whichever of the two controls is present, and a body
            with neither posts nothing at all towards the identity row. */}
        {(filing || showHrdf) && <input type="hidden" name="filingCountry" value={filingCountry} />}

        {/* ── GROUP 1 · THE FILING IDENTITY (r226) ───────────────────────────────────────────────
            The number that goes on THIS body's filed form. It lives in a different table from everything
            else on this form (company_statutory_my, not company_statutory_authority), but it is one body,
            so it saves with the one button — the tab's consolidated action writes both halves. */}
        {(filing || showHrdf || sharesSocsoCode) && (
          <div className="space-y-2 rounded-md border border-border/60 p-2.5">
            <SubHeader>{showHrdf ? t('authorityRegistrationSection') : t('authorityFilingSection')}</SubHeader>
            {filing && <p className="text-xs text-muted-foreground">{t('authorityFilingHint')}</p>}
            {showHrdf && <p className="text-xs text-muted-foreground">{t('authorityRegistrationHint')}</p>}
            {filing && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label={t(filing.labelKey as never)}>
                  <input name={filing.name} defaultValue={statutory?.[filing.name] ?? ''} className={inputCls} />
                </Field>
              </div>
            )}
            {showHrdf && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label={t('hrdfStatusLabel')}>
                  <select name="hrdfStatus" defaultValue={statutory?.hrdfStatus ?? 'not_registered'} className={inputCls}>
                    <option value="not_registered">{t('hrdfNotRegistered')}</option>
                    <option value="mandatory">{t('hrdfMandatory')}</option>
                    <option value="optional">{t('hrdfOptional')}</option>
                  </select>
                </Field>
              </div>
            )}
            {sharesSocsoCode && <p className="text-xs text-muted-foreground">{t('authorityEisSharesSocso')}</p>}
          </div>
        )}

        {/* ── GROUP 2 · THE PAYMENT SETUP ────────────────────────────────────────────────────────── */}
        <div className="space-y-2 rounded-md border border-border/60 p-2.5">
          <SubHeader>{t('authorityPaymentSection')}</SubHeader>
          <p className="text-xs text-muted-foreground">{t('authorityPaymentHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                    // 3c2f55d7 rev 2 — the account number is shown IN FULL. It was masked to its last four
                    // digits, which is an employee-facing habit applied where it does not belong: this
                    // screen is admin-only (RLS), the number is the company's OWN debit account, and an
                    // admin routing EPF to the right account needs to read the whole thing. The masks on
                    // EMPLOYEE bank details elsewhere (app/me, the audit formatter) are a different
                    // decision and stay.
                    <option key={bp.id} value={bp.id}>
                      {(bp.accountLabel || myBankLabel(bp.bank)) + ' · ' + bp.debitAccountNo}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {/* Not a <Field>: that WRAPS its children in a <label>, and this control is a div holding two
                inputs plus a clear button — a wrapping label would attach itself to whichever input came
                first and every click on the row would re-focus the text box. The caption points at the
                field's own id instead, the way the Leave Inquiry pickers do. `fieldLabel` hands the same
                caption to the tab Save's change summary, which has no label to read it off. */}
            <div className="flex flex-col gap-1.5 sm:col-span-3">
              <label htmlFor={`${fieldId}-sig`} className="text-xs font-medium text-muted-foreground">
                {t('authoritySignatory')}
              </label>
              <EmployeeSearchField
                id={`${fieldId}-sig`}
                name="signatoryPersonId"
                fieldLabel={t('authoritySignatory')}
                employees={signatoryOptions}
                value={r?.signatoryPersonId ?? null}
                labels={{
                  placeholder: t('signatorySearchPlaceholder'),
                  ariaLabel: t('signatorySearchLabel'),
                  resultsLabel: t('signatorySearchResults'),
                  noMatches: t('signatoryNoMatches'),
                  clear: t('signatoryClear'),
                }}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* ── GROUP 3 · THE CORRESPONDENCE ADDRESS ───────────────────────────────────────────────── */}
        <div className="space-y-2 rounded-md border border-border/60 p-2.5">
          <SubHeader>{t('authorityAddressSection')}</SubHeader>
          <p className="text-xs text-muted-foreground">{t('authorityAddressHint')}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
          </div>
        </div>
      </form>

      {/* Bucket (b): this DELETES the body's row, so it stands outside the section marker and keeps its
          own control. A tab-wide "Discard Changes" that appeared to undo it would be a control lying
          about what it does. */}
      {r && (
        <form action={removeAction}>
          <input type="hidden" name="id" value={r.id} />
          {/* 65b22c00 — as with the bank profile: `id` is the authority ROW, `companyId` is where the
              save came from and therefore where it returns to. */}
          <input type="hidden" name="companyId" value={companyId} />
          <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
            {t('authorityClear')}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * One legal entity, in full: company details, group parent, statutory identity, and bank disbursement
 * profiles — everything "about running the company". The org catalogs (departments / positions / cost
 * centers / business units) moved to the Settings → System Labels admin page; this panel is now purely
 * company/legal/bank management.
 *
 * ── NOTHING ON ARRIVAL IS HIDDEN BEHIND A CLICK (item 3c2f55d7) ────────────────────────────────────
 * This panel is the whole body of /admin/organization/[companyId]. You have ALREADY chosen the company
 * by the time it renders, so no part of it may make you choose again: the sections are grouped by TAB,
 * and everything on the selected tab is visible on arrival.
 *
 * It used to fold in four places, and all four are gone: the outer chevron row (a leftover from when
 * this was one row of a client-side company LIST), the per-statutory-authority cards, the per-bank-account
 * rows and the "add a bank account" form. Each hid information the reader had already navigated two
 * levels to see.
 *
 * NOTHING ON THIS PANEL FOLDS ANY MORE. 3c2f55d7 rev 2 kept exactly one fold — a statutory body's
 * fourteen-field editor, behind its card's Open/Edit — because the card face already stated the body's
 * name, purpose and configured status without a click. 15e5bd93 (r352) retired even that: the reporter
 * asked for the "tab/expand-style interface" to go, so the eight bodies are a permanent rail and their
 * fields fill a workspace beside it, already open. See StatutoryBodyRow / StatutoryBodyEditor.
 *
 * DO NOT reintroduce a details/summary disclosure here — the source guard in
 * test/company-panel-bank-statutory-layout.test.ts fails the build if one comes back, and it also pins
 * that the bank sections and the panel itself stay flat. The group-structure fold on the LISTING page is
 * a different decision and is deliberately kept (test/organization-group-structure-collapse.test.ts).
 *
 * The tabs are NOT a disclosure and stay: they group a large screen, they do not gate it, and every
 * tab's content is mounted (hidden by CSS) so an in-progress edit survives a tab switch.
 */
export function CompanyPanel({
  company,
  companies,
  codesInUse = [],
  statutory,
  bankProfiles,
  statutoryAuthorities = [],
  signatories = [],
  stateOptions = [],
  activeCycleNames = [],
  initialTab,
  actions,
}: {
  company: PanelCompany;
  companies: { id: string; name: string }[];
  /**
   * 7d2df42a — the companies that already hold a Company Code, so the General tab can warn (and NAME
   * the other company) when the operator types one that is taken. Built on the server by
   * `companyCodeHolders` from the same `adminOnly` read `companies` comes from, so it can never name a
   * company this admin could not already see by name on the listing. Defaulted to `[]` because it is a
   * WARNING: a caller that does not pass it gets no warning, never a broken form.
   */
  codesInUse?: readonly CompanyCodeHolder[];
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
  // r298 (ceb1c560) — `null` means the tenant does not hold Payroll: the page did not read the cycles and
  // the Default Payroll Cycle form is not drawn at all. Distinct from `[]` (Payroll, but no active cycle),
  // which draws the form disabled with its warning.
  activeCycleNames?: string[] | null;
  /**
   * 65b22c00 — the tab to open on, read off `?tab=` by the page.
   *
   * Every save on this screen now returns to THIS screen (app/admin/_redirects.ts okCompany), and a
   * redirect re-initialises this component's `tab` state. Without the round trip through the URL an
   * administrator who saved a statutory body would stop being thrown to the company LIST and start being
   * thrown to the General tab instead — the same fault, smaller. Feedback bd2f0bb2 is the personnel
   * screen learning this; `ClientTabs` has carried the identical pair of moves ever since.
   */
  initialTab?: TabKey;
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
    /**
     * 65b22c00 — ONE Save for the General tab's three FIELD-EDIT cards (bucket (a) of
     * docs/audits/65b22c00-organization-save-classification.md). The three actions above it stay bound to
     * their own forms — not as a no-JavaScript fallback, but because a bound form is what each writer is
     * wired to, because it is what TabSaveScope's submit guard intercepts, and because a `<form>` with no
     * action at all would POST to the current URL.
     */
    saveGeneralTab: TabSaveAction;
    /**
     * 15e5bd93 — ONE Save for the STATUTORY tab: the eight bodies' editors plus the SSM / MyInvois
     * registrations card. Declared in app/admin/organization/statutory-tab-actions.ts and passed by
     * reference, never wrapped in a closure built here (the r123 hazard).
     */
    saveStatutoryTab: TabSaveAction;
  };
}) {
  const t = useTranslations('admin.organization');
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'general');
  /**
   * 15e5bd93 — WHICH statutory body the workspace is showing. Client state and nothing else: there is no
   * `/admin/organization/<id>/<body>` route to add to the function-access matrix, and no server read
   * depends on the choice. It opens on the first body of the controlled set, which is the first row of
   * the rail.
   */
  const [statutoryBody, setStatutoryBody] = useState<string>(STATUTORY_AUTHORITIES[0]);
  const c = company;
  const isMY = c.country === 'MY';
  // Readiness for the monthly filings: the three agency identifiers reports key on.
  const statMissing = isMY
    ? [statutory?.epfEmployerNo, statutory?.socsoEmployerCode, statutory?.lhdnEmployerNo].filter((v) => !v).length
    : 0;

  /**
   * 15e5bd93 — the Statutory tab's Save bar names the CARDS that changed, not just how many fields did.
   *
   * Eight statutory bodies share one field set, so "Unsaved changes: 3" cannot tell an administrator
   * whether they edited EPF or PTPTN — and the approved drawing has the bar reading "2 bodies changed —
   * EPF, LHDN". A section id maps to the same string the rail row shows for that body, so the bar and the
   * rail can never call one body two different things. Built here, in the one place that already holds
   * this namespace's translator.
   */
  const statutorySectionLabels: Record<string, string> = {
    [STATUTORY_IDENTITY_SECTION]: t('statutoryIdentityMY'),
    ...Object.fromEntries(STATUTORY_AUTHORITIES.map((a) => [a, t(`authority_${a}` as never)] as const)),
  };

  /**
   * 65b22c00 — KEEPING THE TAB ACROSS A SAVE, which is two moves and needs both.
   *
   * (a) Reflect the active tab into the URL on every switch, with `replaceState` — no RSC refetch, no
   *     scroll jump, and a native reload already lands on the right tab. It is also what makes the tab
   *     linkable, which the three-tab panel never was.
   * (b) A capture-phase `submit` listener on the panel injects the current tab into whichever form is
   *     submitting, so the action can append `&tab=<key>` to its redirect. The alternative — a hidden
   *     input in all thirteen forms, two of which live in components/company-logo.tsx — is thirteen
   *     chances to forget one, and a forgotten one is a save that silently lands on General.
   *
   * `tabRef` mirrors `tab` so the once-registered listener always reads the latest value rather than the
   * value it closed over. The listener runs in the CAPTURE phase for the same reason personnel-tabs.tsx
   * does: React 19 dispatches a form's `action` in the bubble phase, so the field has to be in the DOM
   * before the event gets there.
   */
  const tabRef = useRef<TabKey>(tab);
  tabRef.current = tab;
  const panelRef = useRef<HTMLDivElement>(null);

  const commitTab = (key: TabKey) => {
    setTab(key);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', key);
    // Every other param survives (?error= is read by the page's ErrorBanner); replaceState keeps the
    // scroll position and costs no server round trip.
    window.history.replaceState(window.history.state, '', url.toString());
  };

  /**
   * 65b22c00 — a tab with unsaved edits asks before it is left, exactly as the personnel tab strip does.
   *
   * The panes stay MOUNTED when hidden, so a switch does not itself lose anything; what it loses is the
   * reader's sight of the edit, and with a consolidated Save the whole point is that an edit is not
   * written until Save is pressed. TabSaveScope and this tab bar are the same component here rather than
   * siblings, but they still meet through lib/unsaved-changes.ts — the scope registers itself there on
   * mount and this has no other way to reach it. With nothing registered, or nothing dirty, this is the
   * identical immediate switch it always was.
   */
  const selectTab = (key: TabKey) => {
    if (key === tab) return;
    const guard = firstDirtyGuard();
    if (guard) {
      guard.prompt(() => commitTab(key));
      return;
    }
    commitTab(key);
  };

  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !root.contains(form)) return;
      let input = form.querySelector<HTMLInputElement>(`input[${TAB_TRACKER_ATTR}]`);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'tab';
        input.setAttribute(TAB_TRACKER_ATTR, '');
        form.appendChild(input);
      }
      input.value = tabRef.current;
    };
    root.addEventListener('submit', onSubmit, true);
    return () => root.removeEventListener('submit', onSubmit, true);
  }, []);

  // defd4644: this panel is no longer one row of a client-side list. It is the whole body of
  // /admin/organization/[companyId], mounted once per page, which is what retired the Flight-lazy
  // hazard the old comment here described — the listing used to serialise EVERY company's panel (the
  // full company array, the state catalog and twelve action references each) into one client payload,
  // overflowing the row budget so rows 2..N arrived as lazies. One panel per page cannot do that.
  return (
    <div ref={panelRef} className={c.archivedAt ? 'opacity-60' : undefined}>
      {/* Identity strip. It is a plain row, not a toggle: the reader arrived here by opening THIS
          company, so the one thing this screen must never do is hide it again behind a click. The logo
          and the statutory-readiness badge live here because the page header above cannot show them. */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <CompanyLogo hasLogo={c.hasLogo} companyId={c.id} name={c.name} />
          <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
          {c.registrationNo && <span className="text-xs text-muted-foreground">{c.registrationNo}</span>}
          <span className={badge.muted}>{c.country}</span>
          {c.archivedAt && <span className={badge.muted}>{t('archived')}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {isMY &&
            (statMissing === 0 ? (
              <span className={badge.emerald}>{t('statutoryComplete')}</span>
            ) : (
              <span className={badge.amber}>{t('statutoryPartial', { ready: 3 - statMissing, total: 3 })}</span>
            ))}
        </div>
      </div>

      {/* 3783fd87 — THE GREY. This wash (`bg-muted/20`) over `bg-background` section blocks was the
          "excessive grey background" the reporter reported: the panel is not inside a white card by
          itself, so the whole maintenance screen read as grey-on-grey. The page now wraps the panel in a
          Card (app/admin/organization/[companyId]/page.tsx) and every block below is a white card with a
          LINE around it instead of a filled grey rectangle. A border-t still separates the tabs from the
          identity strip — separation by line, not by fill. */}
      <div className="border-t border-border px-4 py-4">
        {/* Tab bar — groups the company detail sections so the panel reads as tabs, not one long scroll. */}
        <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
          <TabButton active={tab === 'general'} onClick={() => selectTab('general')}>
            {t('tabGeneral')}
          </TabButton>
          {/* Slot two, restored by r226. `tabBankAccount` had been sitting unused in all six catalogues
              since 3c2f55d7 rev 2 removed the tab; it is the same string, back in the same place. */}
          <TabButton active={tab === 'bank'} onClick={() => selectTab('bank')}>
            {t('tabBankAccount')}
          </TabButton>
          <TabButton active={tab === 'statutory'} onClick={() => selectTab('statutory')}>
            {t('tabStatutory')}
          </TabButton>
        </div>

        {/* General: the company logo, then its master data */}
        <div className={cn('space-y-4', tab === 'general' ? '' : 'hidden')}>
        {/* Company logo — FIRST on the tab, and edited the way the Personnel profile photo is: a pencil
            trigger over the upload/remove forms, with the picked file previewed before it is saved
            (3c2f55d7 rev 2). Storage, the PNG/JPG rule and the 2 MB limit are untouched. */}
        <div className="space-y-2.5 rounded-lg border border-border bg-card p-3">
          <SubHeader>{t('logoSection')}</SubHeader>
          <CompanyLogoEdit
            companyId={c.id}
            name={c.name}
            hasLogo={c.hasLogo}
            labels={{
              edit: t('logoEdit'),
              hint: t('logoHint'),
              upload: t('logoUpload'),
              replace: t('logoReplace'),
              remove: t('logoRemove'),
              none: t('logoNone'),
              // The caption must name the submit button the reader can actually see, and that caption
              // flips with hasLogo — so it is interpolated here rather than hard-coded per locale.
              previewPending: t('logoPreviewPending', {
                action: c.hasLogo ? t('logoReplace') : t('logoUpload'),
              }),
            }}
            setAction={actions.setCompanyLogo}
            removeAction={actions.removeCompanyLogo}
          />
        </div>

        {/* 65b22c00 — ONE "Save Changes" for the General tab's field-edit cards. TabSaveScope wraps
            bucket (a) only: the company master data, the default payroll cycle and the group parent —
            plain columns on the `company` row, which is what a single Save, and therefore a single
            Discard, can honestly cover. The logo card ABOVE and the archive / delete row BELOW are
            bucket (b) and are rendered outside the scope, so the tab's Discard cannot reach them; see
            docs/audits/65b22c00-organization-save-classification.md.

            WHAT THE BAR SAYS IT COVERS is required, not decorative: the scope is not the whole tab, so a
            bar reading only "Save Changes" would appear to cover the logo and the delete button too. The
            Default Payroll Cycle name is dropped for a tenant without Payroll, where that card is not
            drawn at all — a bar must not name a card the reader cannot find (r256 shipped that fault
            twice before it was caught by rendering the screen).

            ⚠️ THE STATUTORY REGISTRATIONS CARD IS BUCKET (a) AND IS DELIBERATELY NOT HERE — and as of
            15e5bd93 (r352) that is no longer an unanswered question. A scope still cannot span two panes,
            and moving the card to General would still reverse r226's placement (which
            test/company-panel-bank-statutory-layout.test.ts pins). What changed is that the STATUTORY tab
            now has a consolidated Save of its own, so the card is consolidated there, on the tab it
            belongs to. Finding 1 of the audit has the original argument; the statutory pane below records
            how it was settled. */}
        <TabSaveScope
          tabKey="general"
          identity={{ companyId: c.id }}
          saveAction={actions.saveGeneralTab}
          covers={[
            t('sectionCompanyInfo'),
            t('sectionContactInfo'),
            ...(activeCycleNames !== null ? [t('defaultPayrollCycle')] : []),
            t('groupParent'),
          ]}
        >
        {/* Company master data — Company Information + Contact Information (bc5d4891). */}
        <form
          action={actions.updateCompany}
          data-save-section="company"
          className="space-y-4 rounded-lg border border-border bg-card p-3"
        >
          <input type="hidden" name="id" value={c.id} />

          {/* Company Information */}
          <div className="space-y-2.5">
            <SubHeader>{t('sectionCompanyInfo')}</SubHeader>
            <Field label={t('legalName')}>
              <input name="legalName" required defaultValue={c.name} className={inputCls} />
            </Field>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {/* 3783fd87 — ONE CAPTION FOR ONE COLUMN. The column, the input name and the service field
                  are untouched (`companyLabel` throughout); only what the screen CALLS it changed. It read
                  "Company Label" here and "Code" on the listing, for the same `company.company_label` —
                  which is why the reporter filed the create-form gap as "Company Code is missing" and why
                  their request asks for "consistent labels". The create form uses this same key. */}
              {/* 7d2df42a — warns, as you type, when another company already uses this code, and names it.
                  `excludeId` is this company: its OWN stored code is not a duplicate of itself, or the tab
                  would warn about every coded company the moment it opened. Still not required, still not
                  refused — the save path is untouched. */}
              <Field label={t('companyCode')}>
                <CompanyCodeField defaultValue={c.companyLabel ?? ''} codesInUse={codesInUse} excludeId={c.id} />
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
        </form>

        {/* ── Relocated here by r226 ──────────────────────────────────────────────────────────
            The default payroll cycle, the group parent and archive/delete used to sit on an "Other"
            tab next to the bank details. That tab is gone: the reporter asked for Bank Account back
            as a tab of its own, and renaming "Other" to "Bank Account" would have filed "Delete this
            company" under a friendly heading. These three are company administration, so they land on
            General. Nothing about them changed — same forms, same actions, same audit trail. */}
        {/* Organization Module (361e3b15) — Default Payroll Cycle. Lists THIS company's ACTIVE cycles with
            the saved default pre-selected. Changing it affects FUTURE runs only (batches snapshot their run
            type at creation) and is audit-trailed. If the saved default is no longer active (archived or
            renamed), an inline note flags it and the admin re-points — no silent invalid selection.
            r298 (ceb1c560) — absent altogether for a tenant without Payroll (`activeCycleNames === null`). */}
        {activeCycleNames !== null && (
        <form
          action={actions.updateCompanyDefaultCycle}
          data-save-section="cycle"
          className="space-y-2.5 rounded-lg border border-border bg-card p-3"
        >
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
              </>
            );
          })()}
        </form>
        )}

        {/* Group parent — the third and last bucket (a) card, so the scope encloses a CONTIGUOUS run.
            r226 drew it in a two-column grid beside archive/delete; it is lifted out of that grid here
            because the archive and delete controls are bucket (b) and have to sit outside the Save.
            Nothing about the card itself changed — same form, same action, same audit trail. */}
        <form action={actions.setParent} data-save-section="parent" className="space-y-2.5 rounded-lg border border-border bg-card p-3">
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
        </form>
        </TabSaveScope>

        {/* Archive / delete — bucket (b), BELOW and OUTSIDE the scope. A single Save implies a single
            Discard, and a Discard that appeared to undo a deleted company would be a control lying about
            what it does. Both keep their own immediate controls, and Delete keeps its confirmation. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-card p-3">
              {c.archivedAt ? (
                <form action={actions.archiveCompany}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="archived" value="false" />
                  {/* 65b22c00 — archiveCompanyAction is bound BOTH here and on every row of the company
                      list, and only this one should leave the reader on the company. The marker is an
                      explicit input rather than a client-injected field precisely because the destination
                      depends on it: injected, an un-hydrated page would quietly go back to bouncing to the
                      list, which is the fault this item exists to fix. A fixed value against a closed
                      list — never a path echoed into a redirect. */}
                  <input type="hidden" name="returnTo" value="company" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('unarchive')}
                  </Button>
                </form>
              ) : c.inUse ? (
                <form action={actions.archiveCompany}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="archived" value="true" />
                  <input type="hidden" name="returnTo" value="company" />
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
        </div>
        {/* end General tab */}

        {/* Bank Account: the company's bank disbursement profiles, and nothing else.

            ⚠️ RESTORED BY r226. 94ae7e1f gave this its own tab in slot two; 3c2f55d7 rev 2 removed the
            tab and folded the bank details into "Other" on the reporter's instruction; the reporter has
            since asked for the tab back, in writing. The bank-profile data and logic (core/bank-profile)
            never moved and are unchanged — this is a tab boundary, not a rewrite. */}
        <div className={cn('space-y-4', tab === 'bank' ? '' : 'hidden')}>
        {/* Bank disbursement profiles (ADR-0031) — bank-issued corporate ID + employer debit account */}
        {isMY ? (
          <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            <SubHeader>{t('bankProfilesTitle')}</SubHeader>
            {/* R46: a company may hold SEVERAL accounts, including more than one at the same bank, so each
                saved account is its own editable form (identity is the row id) rather than one upsert box. */}
            {bankProfiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('noBankProfiles')}</p>
            ) : (
              <ul className="space-y-2">
                {bankProfiles.map((bp) => (
                  // 3c2f55d7 — each saved account was a closed disclosure; the identity line is now a
                  // heading over an editor that is simply open. rev 2 — and the account number on that
                  // heading is no longer masked (see the note on the "Paid from" picker).
                  <li key={bp.id} className="rounded-md border border-border/60">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 text-sm">
                        <span className="font-medium">{bp.accountLabel || myBankLabel(bp.bank)}</span>
                        {bp.isPrimary && <span className={`ml-2 ${badge.emerald}`}>{t('bankPrimary')}</span>}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {myBankLabel(bp.bank)} · {bp.debitAccountNo} · {bp.currency}
                        </span>
                      </span>
                    </div>
                    <div className="border-t border-border/60 px-3 py-3">
                      <BankAccountForm action={actions.setBankProfile} companyId={c.id} companyName={c.name} profile={bp} />
                      <form action={actions.removeBankProfile} className="mt-2">
                        <input type="hidden" name="id" value={bp.id} />
                        {/* 65b22c00 — identity is the ROW, so `id` is the profile's. The company rides
                            alongside it because the action has to name the screen to return to. */}
                        <input type="hidden" name="companyId" value={c.id} />
                        <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                          {t('bankProfileRemove')}
                        </button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {/* 3c2f55d7 — the blank "add an account" form was itself a fold. A company with no bank
                account saw an empty list and a closed row, i.e. the one thing it needed to do was
                hidden. The dashed border still marks it as the ADD form rather than a saved one. */}
            <div className="rounded-md border border-dashed border-border">
              <div className="px-3 py-2 text-sm font-medium text-primary">{t('bankAccountAdd')}</div>
              <div className="border-t border-border/60 px-3 py-3">
                <BankAccountForm action={actions.setBankProfile} companyId={c.id} companyName={c.name} profile={null} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('bankProfilesHint')}</p>
            <p className="text-xs text-muted-foreground">{t('bankMasterHint')}</p>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            {t('bankAccountNonMY', { country: c.country })}
          </p>
        )}
        </div>
        {/* end Bank Account tab */}

        {/* Statutory: the statutory workspace (94ae7e1f — the old "Payroll" tab, renamed; it only ever
            held statutory configuration). Country-pack section (ADR-0008). */}
        <div className={cn('space-y-4', tab === 'statutory' ? '' : 'hidden')}>
        {isMY ? (
          /**
           * ── 15e5bd93 (r352) — ONE SAVE FOR THE WHOLE STATUTORY TAB ───────────────────────────────
           *
           * ⚠️ THIS REPLACES THE COMMENT THAT USED TO STAND ON THE GENERAL SCOPE SAYING "a scope cannot
           * span two panes", and it resolves it rather than working around it. 65b22c00 found FOUR
           * bucket (a) forms on this screen and could consolidate three: the fourth — the SSM / MyInvois
           * registrations card — is drawn HERE, and that round's audit (finding 1) refused both available
           * answers. Moving the card to General would have reversed r226's placement as a side effect of
           * a button change; leaving a one-card scope here would have put a sticky Save/Discard bar above
           * eight statutory-body editors it did not own.
           *
           * The reporter's approved redesign removes the premise: the eight bodies are now a permanent
           * rail and ONE workspace, and their editors have no Save buttons of their own, so this bar owns
           * every card under it. The registrations card joins it and stays exactly where r226 put it.
           *
           * WHAT THE BAR SAYS IT COVERS is required, not decorative (see TabSaveScope's `covers`), and
           * `sectionLabels` is the half this tab needs on top of that: eight bodies with an identical
           * field set make "Unsaved changes: 3" an answer to the wrong question, so the bar also names
           * the bodies that moved — which is what the approved drawing shows it doing.
           *
           * NOT in this scope, deliberately: "Clear this authority", which DELETES a body's row. It is
           * bucket (b), it keeps its own button, and it is outside every section marker.
           */
          <TabSaveScope
            tabKey="statutory"
            identity={{ companyId: c.id }}
            saveAction={actions.saveStatutoryTab}
            covers={[t('authoritiesTitle'), t('statutoryIdentityMY')]}
            sectionLabels={statutorySectionLabels}
          >
          {/* R46 orgbank (84719377) — per-authority PAYMENT setup: for each statutory body, which company
              bank account pays it, its address/contact, and the authorised signatory. Every authority in
              the controlled set is listed whether configured or not, so nothing is silently missing.

              ⚠️ THE RAIL NEVER COLLAPSES, and that is the whole of this item. efe424b0 had already turned
              a grid of tall cards into one divided LIST, at the reporter's request ("displayed as a
              structured list rather than individual large boxes, allowing administrators to quickly
              identify, access, and manage each statutory setting"). What was still wrong is what 15e5bd93
              reports: the list could show you eight collapsed rows, or one body's fourteen boxes pushed
              down the page by the rows above it — never a body's details AND where you are in the list at
              the same time. So the list becomes a permanent left rail and the fields move to a workspace
              beside it, already open.

              ⚠️ SOCSO AND EIS ARE ONE GROUP, NOT ONE SETTING, and the difference is the whole of the
              consolidation note on AUTHORITY_LOGO: their payment configurations genuinely differ on this
              tenant. So SOCSO's row is named for both bodies and carries the PERKESO mark, and EIS
              follows it as a SUBORDINATE row — indented, no second mark, its own editor intact.

              Nothing is filtered out: `eis` remains a real authority that the services, the reports and
              the payroll feed all still know. */}
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="w-full shrink-0 space-y-4 lg:w-72">
              <div className="space-y-2.5 rounded-lg border border-border bg-card p-3">
                <SubHeader>{t('authoritiesTitle')}</SubHeader>
                <p className="text-xs text-muted-foreground">{t('authoritiesHint')}</p>
                {bankProfiles.length === 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{t('authoritiesNoBankAccounts')}</p>
                )}
                <nav aria-label={t('authoritiesTitle')}>
                  <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                    {STATUTORY_AUTHORITIES.map((a) => (
                      <StatutoryBodyRow
                        key={a}
                        authority={a}
                        row={statutoryAuthorities.find((r) => r.authority === a) ?? null}
                        /** efe424b0 — EIS is drawn beneath SOCSO as part of one PERKESO group. */
                        subordinate={c.country === 'MY' && a === 'eis'}
                        statutory={statutory}
                        filingCountry={c.country}
                        bankProfiles={bankProfiles}
                        selected={statutoryBody === a}
                        onSelect={() => setStatutoryBody(a)}
                      />
                    ))}
                  </ul>
                </nav>
              </div>

              {/* ── COMPANY REGISTRATIONS ──────────────────────────────────────────────────────────
                  What is LEFT of the old flat identity list, and what is left is the point.

                  r226 moved EPF's, SOCSO's and LHDN's filing numbers, and HRD Corp's contribution rate,
                  onto their own body's editor, so that everything about one body is in one place. These
                  two did NOT move, deliberately: neither the SSM registration number nor the MyInvois TIN
                  belongs to a body an employer pays a contribution to, neither is in STATUTORY_AUTHORITIES,
                  and the SSM number is read by two statutory files we produce
                  (localization/my/borang-8a.ts, localization/my/socso-eis-file.ts). Giving either one a
                  payment card would have been a tidier screen making a false claim.

                  This form posts only the two boxes it renders. That is safe because the writer is a
                  PARTIAL PATCH (localization/my/company-statutory.ts): before r226 it was a full-row
                  overwrite, and a form this shape would have silently NULLed EPF, SOCSO and LHDN.

                  ⚠️ THE PACK FLAG IS `filingCountry`, NOT `country`, AND THE RENAME IS LOAD-BEARING (r352).
                  It was `name="country"` while this card had its own Save and its own payload. Inside one
                  consolidated scope it cannot be: lib/tab-save-dom.ts `syncCarriedValues` treats a HIDDEN
                  input as a mirror of any VISIBLE control with the same name in a sibling section — which
                  is exactly right for the personnel cards it was written for, and exactly wrong here,
                  because every body's editor carries a visible `country` for its postal address. It would
                  have copied "Malaysia" over this card's "MY" and posted a country NAME into packFor().
                  `filingCountry` is the name r226 already coined for this same collision one file over, so
                  this is that rule applied, not a new one. The consolidated writer reads `filingCountry`;
                  `setCompanyStatutoryAction`, still bound below for the reasons the editor's comment
                  gives, defaults an absent country to 'MY' — which is the only value this MY-only card
                  ever posted. */}
              <form
                action={actions.setStatutory}
                data-save-section={STATUTORY_IDENTITY_SECTION}
                className="space-y-2.5 rounded-lg border border-border bg-card p-3"
              >
                <SubHeader>{t('statutoryIdentityMY')}</SubHeader>
                <input type="hidden" name="companyId" value={c.id} />
                <input type="hidden" name="filingCountry" value="MY" />
                <div className="grid grid-cols-1 gap-2">
                  <Field label={t('ssmRegistrationNo')}>
                    <input
                      name="ssmRegistrationNo"
                      defaultValue={statutory?.ssmRegistrationNo ?? ''}
                      className={inputCls}
                    />
                  </Field>
                  <Field label={t('myinvoisTin')}>
                    <input name="myinvoisTin" defaultValue={statutory?.myinvoisTin ?? ''} className={inputCls} />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">{t('statutoryFilingsHint')}</p>
                {/* The HRDF headcount hint ("mandatory at 10+, optional at 5–9") is deliberately gone —
                    HRDF eligibility is a free company choice, not a headcount rule. It now lives on the
                    HRD Corp body as that body's registration band. */}
              </form>
            </div>

            {/* THE WORKSPACE. All eight editors render; the seven that are not selected are hidden with
                CSS, never unmounted — so a half-typed address survives a switch, the one Save can read
                every body whether or not you are looking at it, and the render guard still counts eight
                forms. */}
            <div className="min-w-0 flex-1 rounded-lg border border-border bg-card p-3">
              {STATUTORY_AUTHORITIES.map((a) => (
                <StatutoryBodyEditor
                  key={a}
                  authority={a}
                  row={statutoryAuthorities.find((r) => r.authority === a) ?? null}
                  statutory={statutory}
                  filingCountry={c.country}
                  companyId={c.id}
                  bankProfiles={bankProfiles}
                  signatories={signatories}
                  stateOptions={stateOptions}
                  selected={statutoryBody === a}
                  setAction={actions.setStatutoryAuthority}
                  removeAction={actions.removeStatutoryAuthority}
                />
              ))}
            </div>
          </div>
          </TabSaveScope>
        ) : (
          <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            {t('noStatutoryPack', { country: c.country })}
          </p>
        )}
        </div>
        {/* end Statutory tab */}
      </div>
    </div>
  );
}
