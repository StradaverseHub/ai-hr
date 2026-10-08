'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COUNTRY_CODE_OPTIONS, COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { type CompanyPanelTab } from '@/lib/company-panel-tabs';
import { type TabSaveResult } from '@/lib/tab-save-sections';
import { firstDirtyGuard } from '@/lib/unsaved-changes';
import { TabSaveScope } from './tab-save-scope';
import { DISBURSEMENT_CAPABLE_BANKS, DISBURSEMENT_UNSUPPORTED_BANKS, MY_BANKS, myBankLabel } from '@/lib/my-banks';
import { accountLast4 } from '@/lib/bank-account-last4';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
// 15e5bd93 rev 2 (r353) — the marks and the r226 filing-field map moved to lib/, because the reporter's
// approved rev-2 redesign gives the statutory bodies a DEDICATED screen and both that screen and this
// panel's read-only list must agree about a body's logo and about which of the three filing numbers is
// its own. `STATUTORY_IDENTITY_SECTION` is GONE with the consolidated statutory Save it named — see the
// Statutory pane below.
import { AUTHORITY_ICON, AUTHORITY_LOGO, MY_FILING_FIELD } from '@/lib/statutory-authority-display';
import { OptionSelect } from './option-select';
import { Button, Field, inputCls } from './ui';
// 7d2df42a — the Company Code input and its duplicate warning, shared with the create form so the two
// screens that edit this column cannot disagree about what a duplicate is.
import { CompanyCodeField } from './company-code-field';
import type { CompanyCodeHolder } from '@/lib/company-code';
import { ConfirmSubmit } from './ui/confirm-submit';
import { COMPANY_DELETE_REFUSAL_KEY, type CompanyDeleteBlock } from '@/lib/company-delete';
import { CompanyLogo, CompanyLogoEdit } from './company-logo';
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
  /**
   * f00bd1eb — what Delete will do, decided by the server's own delete guard (core/read.ts
   * companyDeleteStatus): null opens the confirmation, a reason opens the refusal with Archive instead.
   * Replaces `inUse`, which counted three of the forty-five tables that reference a company.
   */
  deleteBlockedBy: CompanyDeleteBlock | null;
  /** f00bd1eb — the reader administers this company's parent (or the company, at a group root): Delete is
   *  theirs to press. Anyone else is not shown it; the action and the database refuse them regardless. */
  canDelete: boolean;
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

/**
 * One company bank account (R46 orgbank 84719377). Used twice: prefilled for each saved account (a hidden
 * `id` makes the save an UPDATE of that row) and blank to add another. 48652e18 (r419) — the blank one
 * lives inside the "Add a bank account" disclosure and is the only caller that passes `onCancel`, which
 * draws a Cancel beside Save that closes the disclosure (and so discards what was typed). A company may hold several accounts
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
  onCancel,
}: {
  action: Action;
  companyId: string;
  companyName: string;
  profile: PanelBankProfile | null;
  onCancel?: () => void;
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
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button type="submit" size="sm">
          {t('bankProfileSave')}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('bankAccountAddCancel')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * ── 15e5bd93 REVISION 2 (r353) — THE STATUTORY TAB LISTS THE BODIES AND LINKS OUT ─────────────
 *
 * ⚠️ THIS REPLACES THE r352 NOTE THAT STOOD HERE, AND THE REPORTER CONTESTED r352 IN WRITING. That round
 * split the old folding `StatutoryAuthorityCard` into a permanent left-hand rail plus a workspace, both
 * INSIDE this tab, under one Save. The contest names both halves: "Do not expand the statutory settings
 * directly within the existing Statutory tab" and "The preferred approach is a dedicated full-width
 * screen" — plus a view/edit distinction that round did not attempt at all.
 *
 * So the FIELDS are gone from this tab. They live under `/admin/organization/<companyId>/statutory`.
 * ⚠️ THEY HAVE MOVED TWICE MORE INSIDE THAT ROUTE AND ARE BACK WHERE r353 PUT THEM. r353 drew every body
 * as its own card on that one screen, read-only until that card's Edit was pressed; contested. r355 drew
 * a TABLE of one row per body with `…/statutory/<body>` holding one body at a time; the reporter called
 * that drill-in "an unnecessary intermediate page". REVISION 4 (r372) deletes it: every body is a card on
 * `…/statutory` itself, every field open, one Save for the screen
 * (components/statutory-setup-screen.tsx). Through all three moves `StatutoryBodyEditor` was relocated
 * rather than rewritten — group headings, field order, the `filingCountry` flag and the signatory
 * tolerance all intact.
 *
 * WHAT IS LEFT HERE IS THE LIST, AND IT IS THE REPORTER'S FIRST APPROVED POINT: "Open Settings" becomes a
 * link to a real page. Each body is one row of a read-only list — mark, name, description, Configured /
 * Not set up, and what is on file — with an "Open settings" LINK to that screen.
 *
 * ⚠️ THE ROW KEEPS THE SUMMARY 3783fd87 PUT ON THE FACE, and that is a deliberate refusal to let this
 * item quietly undo an earlier one. That round's promise to the same reporter was a body "showing what is
 * set without opening anything — the employer number and the bank account it is paid from — and saying
 * plainly where nothing is set yet", because comparing two bodies meant opening both and remembering the
 * first. A list of names and Configured chips would put that back. It stays, under its own captions, and
 * it is now the whole reason this tab still says anything about the bodies at all.
 *
 * ⚠️ TWO DIFFERENT NUMBERS, TWO CAPTIONS — r226's rule, unchanged. The FILING number goes on the body's
 * filed form (company_statutory_my); the employer account is the reference on its PAYMENT slip
 * (company_statutory_authority). They are not duplicates, and summarising them into one anonymous
 * "employer number" is the exact fault r226 was raised for.
 *
 * ⚠️ THERE IS NO ROUTE PER AUTHORITY, AND THIS PARAGRAPH HAS NOW SAID BOTH THINGS. All four versions are
 * recorded, because the sentence that stands here is the sentence a future round builds on.
 *
 *   · r352 WROTE: no route `/admin/organization/<id>/<body>`, because it "would put a page load between
 *     'which body do I mean' and 'here are its fields'".
 *   · r353 KEPT that and narrowed it: the objection was about a route PER AUTHORITY, and r353 built ONE
 *     route showing all eight bodies at once, so "the objection the old sentence raised does not apply".
 *   · r355 REVERSED it and built `/admin/organization/<id>/statutory/<body>`, on the reporter's own ASCII
 *     sketch: "Selecting Edit → EPF opens a screen containing ONLY the EPF fields, with Cancel / Save."
 *   · r372 REVERSES IT BACK, AND r352 WAS RIGHT. The reporter contested that page in their own words —
 *     "an unnecessary intermediate page" — which is r352's objection almost verbatim, arrived at from the
 *     other side. The page is deleted; every body is a card on `…/statutory` with its fields already
 *     open. What r352 got wrong was not the objection but WHERE it applied: the fields do not belong on
 *     this TAB, and they do not belong behind a second page either.
 *
 * WHAT DID NOT CHANGE THROUGH ANY OF IT: this TAB has no per-body route and no per-body fields. One shared link
 * opens the statutory SCREEN for all eight bodies, and the reporter's first
 * approved point ("Open Settings becomes a link to a real page") is satisfied by that link. That route IS
 * registered in lib/permissions.ts under screenKey 'organization'; test/function-access.test.ts requires
 * exactly that, in BOTH directions — so the deleted route's entry had to be removed, not left behind.
 */

/**
 * ONE STATUTORY BODY, AS A READ-ONLY ROW OF THIS TAB'S LIST.
 *
 * The face: the body's own mark, its name, a one-line description, Configured / Not set up, and the
 * summary of what is on file. READ-ONLY THROUGHOUT — it renders text, never a link or field. That
 * was true while a workspace sat beside it and it is more true now: the only writer is the dedicated
 * setup screen, and `company_statutory_authority` is also what the EA officer block and the CP39 preparer
 * block read (localization/my/reports.ts), so a second set of controls over the same columns on a screen
 * nobody expects to save from is how two doors start disagreeing.
 *
 * 15e5bd93 rev 2 — `selected` / `onSelect` are GONE with the workspace they chose between, and the row's
 * selection `<button>` with them. What replaces it is a LINK: the reporter's first approved point is that
 * "Open Settings" becomes a link to a real page. The `<dl>` now sits beside that link rather than outside
 * a button, which was only ever a markup constraint (a button may contain phrasing content only).
 */
function StatutoryBodyRow({
  authority,
  row,
  statutory,
  subordinate = false,
  filingCountry,
  bankProfiles,
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
   * It is a presentation flag and nothing else. The body keeps its own CARD on the setup screen, its own
   * authority value and its own record — which is the point, because EIS's payment account genuinely
   * differs from SOCSO's on this tenant (see lib/statutory-authority-display.ts).
   */
  subordinate?: boolean;
  /** ISO code of the company. 'MY' is the only pack with a filing identity today. */
  filingCountry: string;
  bankProfiles: PanelBankProfile[];

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
   * code, which its card on the setup screen says in words.
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
      {/* 15e5bd93 rev 2 — THE ROW'S HEAD AND ITS ONE CONTROL. `aria-current` and the accent fill that
          marked the selected body are gone with the selection they expressed; what stands here now is the
          body's face and an "Open settings" LINK to the dedicated setup screen, which is the reporter's
          first approved point in their own words. A <div>, not a <button>: nothing on this row toggles. */}
      <div className="flex w-full items-start gap-3 p-3 text-left">
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

      </div>

      {/* 3783fd87 — WHAT IS SET, WITHOUT OPENING ANYTHING. A <dl> because each entry is a caption and
          its value, and the caption is what stops the two numbers being mistaken for each other.
          Rendered as plain text, never as a disabled input: a greyed-out box looks like something you can
          fix here, and the whole of this row is read-only — the setup screen is the only writer. */}
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
 * asked for the "tab/expand-style interface" to go. 15e5bd93 REVISION 2 (r353) went further on the same
 * instruction and took the statutory FIELDS off this panel altogether — they are ONE dedicated screen
 * (components/statutory-setup-screen.tsx: every body as a card, every field open, one Save; r355's
 * per-body page was contested as "an unnecessary intermediate page" and deleted in r372) — so the
 * Statutory tab holds the company's own registrations and a read-only list of the eight bodies that
 * LINKS there. See StatutoryBodyRow.
 *
 * ⚠️ ONE EXCEPTION, ON THE REPORTER'S APPROVED REQUEST (48652e18, r419): "Add a bank account" on the Bank
 * Account tab is a closed button again, moved ABOVE the saved accounts, that opens the blank form. It is not
 * a fold over information the reader came to see — it is an action, and the form behind it is empty. It is
 * the ONLY expand/collapse on the panel, and the guard pins exactly one such attribute in this file.
 *
 * DO NOT reintroduce a details/summary disclosure here — the source guard in
 * test/company-panel-bank-statutory-layout.test.ts fails the build if one comes back, and it also pins
 * that the saved bank accounts and the panel itself stay flat. The group-structure fold on the LISTING page is
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
     * 15e5bd93 rev 2 (r353) — `saveStatutoryTab` STOOD HERE AND IS GONE, with the consolidated statutory
     * Save it named. The reporter contested r352's one-Save-for-the-tab shape along with the in-tab
     * editing it depended on, and asked for Save and Cancel on each body's own card on a dedicated screen.
     * `app/admin/organization/statutory-tab-actions.ts` is retired rather than left bound to nothing:
     * a `'use server'` export nothing submits to is a second writer of `company_statutory_my` that no
     * screen exercises and no reader can see is dead.
     *
     * The Statutory tab's SSM / MyInvois registrations card therefore has its own Save button again —
     * which is exactly where 65b22c00's finding 1 left it, and that finding's objection to a scope on this
     * tab ("a sticky bar above eight statutory-body editors it does not own") is true once more now that
     * the editors have gone somewhere else entirely.
     */
  };
}) {
  const t = useTranslations('admin.organization');
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'general');
  /**
   * 48652e18 (r419) — "Add a bank account" is a DISCLOSURE again, closed on arrival, on the reporter's
   * approved request (it sits above the saved accounts, so it must not push them off the screen).
   *
   * It closes on Cancel (the button sets this) and after a SUCCESSFUL save, which is detected the only
   * way this component can see it: a bank account id appears that was not in the list before. The save's
   * redirect may or may not re-initialise this state; this effect makes the outcome the same either way,
   * and a REFUSED save (no new id) leaves the form open with the operator's entry.
   */
  const [bankAddOpen, setBankAddOpen] = useState(false);
  const knownBankIds = useRef<Set<string>>(new Set(bankProfiles.map((bp) => bp.id)));
  useEffect(() => {
    const added = bankProfiles.some((bp) => !knownBankIds.current.has(bp.id));
    knownBankIds.current = new Set(bankProfiles.map((bp) => bp.id));
    if (added) setBankAddOpen(false);
  }, [bankProfiles]);
  const c = company;
  const isMY = c.country === 'MY';
  // Readiness for the monthly filings: the three agency identifiers reports key on.
  // 48652e18 (r419) — the line under the Remove dialog's title: which account, at which bank, ending in
  // which four characters. The full number is never part of it.
  // The label is left out when it only repeats the bank (the service defaults a blank label to the bank's
  // name), and the ending is left out when the number is too short to have one that is not the whole.
  const bankRemoveSubject = (bp: PanelBankProfile) => {
    const bank = myBankLabel(bp.bank);
    const label = bp.accountLabel?.trim();
    const last4 = accountLast4(bp.debitAccountNo);
    return [label && label !== bank ? label : null, bank, last4 ? t('bankRemoveConfirmEnding', { last4 }) : null]
      .filter(Boolean)
      .join(' · ');
  };
  const statMissing = isMY
    ? [statutory?.epfEmployerNo, statutory?.socsoEmployerCode, statutory?.lhdnEmployerNo].filter((v) => !v).length
    : 0;

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
            what it does. Both keep their own immediate controls, and Delete keeps its confirmation.

            f00bd1eb — DELETE NOW ANSWERS BEFORE IT ACTS. Pressing it opens ONE of two dialogs, chosen by the
            server's own delete guard (`deleteBlockedBy`): the confirmation when the delete will succeed, or
            "Unable to Delete Company" with the reason and Archive instead. The refusal lives INSIDE the
            archive form, so its "Archive instead" submits exactly the archive the button beside it does —
            one archive form, one returnTo marker, no second path. Archive is offered whether or not the
            company could be deleted: hiding a company is always available. */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card p-3">
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
              ) : (
                <form action={actions.archiveCompany} className="flex flex-wrap items-center gap-1.5">
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="archived" value="true" />
                  <input type="hidden" name="returnTo" value="company" />
                  <Button type="submit" size="sm" variant="ghost">
                    {t('archiveCompany')}
                  </Button>
                  {c.canDelete && c.deleteBlockedBy ? (
                    <ConfirmSubmit
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      confirmVariant="default"
                      title={t('deleteRefusedTitle')}
                      description={t(COMPANY_DELETE_REFUSAL_KEY[c.deleteBlockedBy])}
                      confirmLabel={t('archiveInstead')}
                      cancelLabel={t('close')}
                    >
                      {t('deleteCompany')}
                    </ConfirmSubmit>
                  ) : null}
                </form>
              )}
              {!c.archivedAt && c.canDelete && !c.deleteBlockedBy ? (
                <form action={actions.deleteCompany}>
                  <input type="hidden" name="id" value={c.id} />
                  <ConfirmSubmit
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    // f00bd1eb — the confirmation's Delete is the red button the approved mockup shows; the
                    // trigger stays a quiet ghost beside Archive.
                    confirmVariant="destructive"
                    title={t('deleteCompanyTitle')}
                    description={t('deleteCompanyDescription')}
                    confirmLabel={t('delete')}
                  >
                    {t('deleteCompany')}
                  </ConfirmSubmit>
                </form>
              ) : null}
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
            {/* 48652e18 (r419) — ADD COMES FIRST, AND IT FOLDS. The reporter asked for "Add new bank
                account" above the accounts, as one closed button that opens the fields; it closes again
                on Cancel and after a successful save (see `bankAddOpen`). This REVERSES 3c2f55d7, which
                unfolded this form when it sat BELOW the list; it is the one disclosure on this panel, and
                test/company-panel-bank-statutory-layout.test.ts pins that it is exactly one. The form is
                MOUNTED only while open, so Cancel really discards what was typed. The dashed border still
                marks it as the ADD form rather than a saved one. */}
            <div className="rounded-md border border-dashed border-border" data-bank-add>
              <div className="px-3 py-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-expanded={bankAddOpen}
                  aria-controls={bankAddOpen ? `bank-add-${c.id}` : undefined}
                  onClick={() => setBankAddOpen((o) => !o)}
                >
                  {t('bankAccountAdd')}
                </Button>
              </div>
              {bankAddOpen ? (
                <div id={`bank-add-${c.id}`} className="border-t border-border/60 px-3 py-3">
                  <BankAccountForm
                    action={actions.setBankProfile}
                    companyId={c.id}
                    companyName={c.name}
                    profile={null}
                    onCancel={() => setBankAddOpen(false)}
                  />
                </div>
              ) : null}
            </div>
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
                        {/* 48652e18 (r419) — Remove ASKS FIRST (the house confirm, as Delete Company does).
                            The dialog names the account, its bank and only the LAST FOUR characters of the
                            number — never the whole number, even though the heading above prints it; a
                            number of four or fewer is named without digits (lib/bank-account-last4). Only
                            "Yes, remove" submits this form; Cancel closes the dialog and posts nothing. */}
                        <ConfirmSubmit
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          confirmVariant="destructive"
                          title={t('bankRemoveConfirmTitle')}
                          subtitle={bankRemoveSubject(bp)}
                          description={t('bankRemoveConfirmBody')}
                          confirmLabel={t('bankRemoveConfirmYes')}
                        >
                          {t('bankProfileRemove')}
                        </ConfirmSubmit>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
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
           * ── 15e5bd93 REVISION 2 (r353) — THIS TAB SHOWS THE SETUP, IT NO LONGER EDITS IT ───────
           *
           * ⚠️ THIS REPLACES r352'S "ONE SAVE FOR THE WHOLE STATUTORY TAB", AND THE REPORTER CONTESTED
           * THAT SHAPE. r352 answered 65b22c00's finding 1 by consolidating this tab: the eight bodies
           * became a rail plus a workspace with no Save buttons of their own, so one sticky bar could own
           * them and the SSM / MyInvois card together. The contest rejects the premise — "Do not expand
           * the statutory settings directly within the existing Statutory tab" — so the editors are gone
           * from here and the consolidated Save has nothing left to consolidate.
           *
           * FINDING 1 IS THEREFORE BACK WHERE IT WAS, AND THAT IS THE HONEST OUTCOME rather than a
           * regression: the audit's objection to a scope on this tab was that a sticky bar would sit
           * "above eight statutory-body editors it does not own". There are no editors here now, but there
           * is also only ONE card left — and a sticky Save/Discard bar above a single two-field card is
           * the "worse than none" that same finding named. So the registrations card keeps its own Save
           * button, exactly as it did before r352, and it stays on the tab r226 put it on.
           *
           * WHAT THE TAB IS FOR NOW: the company's own registrations (editable, here), and a read-only
           * list of the eight bodies with what is on file for each and a link to the dedicated screen
           * that edits them. Approved point 1, in the reporter's words: "Open Settings" becomes a link to
           * a real page.
           */
          <div className="flex flex-col gap-4 lg:flex-row">
            {/* ── COMPANY REGISTRATIONS ───────────────────────────────────────────────
                What is LEFT of the old flat identity list, and what is left is the point.

                r226 moved EPF's, SOCSO's and LHDN's filing numbers, and HRD Corp's contribution rate, onto
                their own body's editor, so that everything about one body is in one place. These two did
                NOT move, deliberately: neither the SSM registration number nor the MyInvois TIN belongs to
                a body an employer pays a contribution to, neither is in STATUTORY_AUTHORITIES, and the SSM
                number is read by two statutory files we produce (localization/my/borang-8a.ts,
                localization/my/socso-eis-file.ts). Giving either one a payment card would have been a
                tidier screen making a false claim.

                They did not move again in rev 2 either. The dedicated setup screen PRINTS both in its
                heading so an operator can check them without coming back, and edits neither: one owner,
                one editor, and a heading that reads rather than writes.

                This form posts only the two boxes it renders. That is safe because the writer is a PARTIAL
                PATCH (localization/my/company-statutory.ts): before r226 it was a full-row overwrite, and
                a form this shape would have silently NULLed EPF, SOCSO and LHDN.

                ⚠️ THE PACK FLAG IS `filingCountry`, NOT `country`, AND THE RENAME IS KEPT ON PURPOSE (r352,
                carried forward by r353). It was `name="country"` before r352 and the collision that forced
                the rename is real: lib/tab-save-dom.ts `syncCarriedValues` treats a HIDDEN input as a
                mirror of any VISIBLE control with the same name in a sibling section of the same scope, and
                every statutory body's editor carries a visible `country` for its postal address — so a
                hidden `country` here was overwritten with "Malaysia" and posted into `packFor()`, killing
                EVERY identity save with "No statutory pack for Malaysia".

                This card is no longer inside a consolidated scope, so that particular door is shut — but
                the name stays, and reverting it would be wrong twice over. `setCompanyStatutoryAction`
                reads `country` and defaults an absent one to 'MY', which is the only value this MY-only
                card ever posted; and the SAME collision is live on the dedicated setup screen, where a
                body's filing field and its visible postal `country` sit on one form. One name for one
                concept, on both screens. */}
            <form
              action={actions.setStatutory}
              className="w-full shrink-0 space-y-2.5 rounded-lg border border-border bg-card p-3 lg:w-72"
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
              {/* `saveStatutoryIdentity` — THE RETIRED CAPTION, BACK IN SERVICE. r352 took this button off
                  when the tab's one Save absorbed the card, and the key was kept in all six catalogues
                  rather than deleted, on the rule this repo keeps proving right: a retired string costs
                  nothing and re-translating a deleted one into six languages costs a round. */}
              <Button type="submit" size="sm">
                {t('saveStatutoryIdentity')}
              </Button>
              {/* The HRDF headcount hint ("mandatory at 10+, optional at 5–9") is deliberately gone —
                  HRDF eligibility is a free company choice, not a headcount rule. It now lives on the
                  HRD Corp body as that body's registration band. */}
            </form>

            {/* R46 orgbank (84719377) — per-authority PAYMENT setup: for each statutory body, which company
                bank account pays it, its address/contact, and the authorised signatory. Every authority in
                the controlled set is listed whether configured or not, so nothing is silently missing.

                ⚠️ THE LIST IS READ-ONLY AND IT NEVER COLLAPSES. efe424b0 turned a grid of tall cards into
                one divided LIST at the reporter's request ("displayed as a structured list rather than
                individual large boxes, allowing administrators to quickly identify, access, and manage
                each statutory setting"); r352 made the list permanent; rev 2 takes the FIELDS off it. What
                survives all three rounds is the sentence 3783fd87 was raised for: you can read what is set
                on every body at once, without opening anything.

                ⚠️ SOCSO AND EIS ARE ONE GROUP, NOT ONE SETTING, and the difference is the consolidation
                note in lib/statutory-authority-display.ts: their payment configurations genuinely differ on
                this tenant. So SOCSO's row is named for both bodies and carries the PERKESO mark, and EIS
                follows it as a SUBORDINATE row — indented, no second mark, its own record intact.

                Nothing is filtered out: `eis` remains a real authority that the services, the reports and
                the payroll feed all still know. */}
            <div className="min-w-0 flex-1 space-y-2.5 rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SubHeader>{t('authoritiesTitle')}</SubHeader>
                <Link
                  href={`/admin/organization/${c.id}/statutory`}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                  data-statutory-setup-link
                >
                  {t('authorityOpen')}
                  <span aria-hidden> →</span>
                </Link>
              </div>
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
                    />
                  ))}
                </ul>
              </nav>
            </div>
          </div>
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
