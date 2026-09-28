'use client';

/**
 * ═══ 15e5bd93 REVISION 2 (r353) — STATUTORY PAYMENT SETUP, AS A DEDICATED SCREEN ═══════════════════
 *
 * ⚠️ THIS SUPERSEDES WHAT r352 SHIPPED, AND THE REPORTER CONTESTED IT IN WRITING. r352 built a permanent
 * left-hand rail plus a workspace INSIDE the company panel's Statutory tab, with one Save for the tab.
 * The contest is explicit and it is not what that was: "Do not expand the statutory settings directly
 * within the existing Statutory tab" and "The preferred approach is a dedicated full-width screen". They
 * also asked for something r352 did not attempt at all — a VIEW mode with an Edit button, distinct from
 * an EDIT mode with Save and Cancel.
 *
 * The approved drawing is docs/mockups/15e5bd93-statutory-dedicated-screen.html, whose own comment records
 * what it does and does not promise. The six approved points, and where each one lives here:
 *
 *   1. Its own full-width page, `/admin/organization/<companyId>/statutory`, the company name in the
 *      heading with its SSM and MyInvois numbers  →  app/admin/organization/[companyId]/statutory/page.tsx
 *   2. Every SUPPORTED body gets its own card, all visible at once, in the controlled set's order
 *      (lib/statutory-authorities.ts)                                        →  `cells` below
 *   3. Each card starts READ-ONLY with an Edit button; Edit turns that ONE card into a form with Save
 *      and Cancel; the others stay read-only                                 →  `editing` state
 *   4. Saving keeps the operator here and names what was saved               →  `okStatutorySetup`
 *   5. A Back link returns to the company's Statutory tab                    →  the page's PageHeader
 *   6. SOCSO and EIS stay paired, EIS indented under SOCSO, two records      →  the PERKESO group cell
 *
 * ── VIEW MODE IS GENUINELY NEW ────────────────────────────────────────────────────────────────────
 * Nothing in this product rendered these fields read-only before this round; the drawing says so too.
 * The treatment is a `<dl>` of caption + value with "Not set" where nothing is on file — the same shape
 * 3783fd87 put on the rail row's face, and for the same reason: a greyed-out disabled input looks like
 * something you can fix where you are standing, and this half of the card is not a writer.
 *
 * ⚠️ AN EDIT FORM IS UNMOUNTED WHEN IT IS NOT OPEN, AND THAT INVERTS r352 ON PURPOSE. That round kept
 * all eight panes mounted and merely hidden with CSS, because ONE Save read every body's fields out of
 * the DOM — an unmounted pane would have been a body whose edits could not be saved at all. There is no
 * such reader now: each card posts its own form to the existing per-body action. With the form left
 * mounted, Cancel would toggle a class and leave the operator's typing sitting in the DOM, to reappear
 * the next time Edit was pressed on that card — a control lying about what it does. So `viewing` renders
 * the `<dl>` and `editing` renders the `<form>`, and Cancel really does discard.
 *
 * ⚠️ ONE CARD AT A TIME IS THE REQUIREMENT *AND* THE DATA GUARD. While a card is open the other seven
 * Edit buttons are DISABLED rather than merely unhelpful: with them live, pressing another body's Edit
 * would unmount a dirty form and discard the typing with no warning at all. The drawing shows the other
 * cards' Edit affordances looking ordinary — it is a sketch of the layout, and this is the one place the
 * build is deliberately stricter than the picture. `statutoryScreenEditingHint` says why, on screen.
 *
 * ── TWO DIFFERENT NUMBERS, TWO CAPTIONS — r226's rule, unchanged ──────────────────────────────────
 * The FILING number goes on the body's filed form (`company_statutory_my`); the employer account is the
 * reference on its PAYMENT slip (`company_statutory_authority`). They are not duplicates, and merging
 * them into one anonymous "employer number" is the exact fault r226 was raised for. Both captions are
 * separate in view mode and in edit mode.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
import { AUTHORITY_ICON, AUTHORITY_LOGO, MY_FILING_FIELD } from '@/lib/statutory-authority-display';
import { myBankLabel } from '@/lib/my-banks';
import { Button, Field, inputCls } from './ui';
import { OptionSelect } from './option-select';
import { EmployeeSearchField, type EmployeeSearchOption } from './employee-search-field';
// TYPE-ONLY, so nothing of the company panel reaches this route's bundle: the four shapes are that
// panel's props contract and a second declaration of them is a second thing to keep in step.
import type {
  PanelBankProfile,
  PanelOption,
  PanelSignatory,
  PanelStatutory,
  PanelStatutoryAuthority,
} from './company-panel';

/**
 * 15e5bd93 rev 2 — THE MARKER THAT TELLS `setCompanyStatutoryAuthorityAction` WHICH SCREEN IT WAS
 * PRESSED ON, so the save returns HERE and not to the company panel.
 *
 * An EXPLICIT hidden input in each form rather than a client-injected marker — it must not depend on
 * hydration — and a fixed literal compared against a literal on the server, never a path echoed into a
 * redirect. `app/admin/actions.ts` `fromStatutorySetupScreen` is the other half; the two strings are
 * pinned against each other by test/organization-stay-on-save.test.ts.
 */
const RETURN_TO_SETUP = 'statutory-setup';

const badge = {
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  // 3783fd87 — a LINED chip, not a filled grey one: on a white card a grey fill is the thing the reporter
  // asked us to take out, and a border carries the same boundary.
  muted:
    'rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
  primary:
    'rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary',
};

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

type Action = (fd: FormData) => void | Promise<void>;

export type StatutorySetupActions = {
  setStatutoryAuthority: Action;
  removeStatutoryAuthority: Action;
};

type CardProps = {
  authority: string;
  row: PanelStatutoryAuthority | null;
  statutory: PanelStatutory;
  /** ISO code of the company. 'MY' is the only pack with a filing identity today. */
  filingCountry: string;
  companyId: string;
  bankProfiles: PanelBankProfile[];
  signatories: PanelSignatory[];
  stateOptions: PanelOption[];
  /**
   * efe424b0 — draw this body as part of the group ABOVE it: indented, and without a second copy of the
   * mark its group head already carries. Only EIS under SOCSO today.
   *
   * A presentation flag and nothing else. The body keeps its own form, its own `authority` value and its
   * own record — which is the point, because EIS's payment account genuinely differs from SOCSO's on this
   * tenant (see the consolidation note in lib/statutory-authority-display.ts).
   */
  subordinate?: boolean;
  editing: boolean;
  /** True when some OTHER card is open, so this card's Edit is refused rather than silently destructive. */
  locked: boolean;
  onEdit: () => void;
  onCancel: () => void;
  actions: StatutorySetupActions;
};

/**
 * ONE STATUTORY BODY, AS A CARD THAT IS READ-ONLY UNTIL YOU PRESS EDIT.
 *
 * ── THE THREE GROUPS IN EDIT MODE, AND WHY THE FIRST ONE HAS THREE FACES ─────────────────────────
 * The groups are the headings r226 introduced (`authorityFilingSection`, `authorityPaymentSection`) plus
 * the name the address run got in r352 (`authorityAddressSection`), which was the one block of fields
 * with no heading at all. No field is added, removed, renamed or re-validated by this round.
 *
 * ⚠️ HRD CORP'S FIRST GROUP IS "Registration", NOT "Filing identity", and that is r226's rule rather
 * than a leftover. Its control is not a number — it is a registration BAND (no contribution / 1.0% /
 * 0.5%) that decides whether the levy is charged at all. Rendering it under a caption promising a
 * filed-form number tells the operator something untrue about the box they are filling in.
 *
 * ⚠️ EIS GETS A SENTENCE WHERE ITS FILING NUMBER WOULD BE. It has none of its own: it files under
 * SOCSO's PERKESO employer code. A second input writing `socsoEmployerCode` would be two controls
 * fighting over one column and whichever was saved second would win; an empty box would read as a number
 * somebody forgot. So: `authorityEisSharesSocso`, in the group where the missing box would have been.
 *
 * ── THE SIGNATORY PICKER ─────────────────────────────────────────────────────────────────────────
 * Scoped to ACTIVE employees of THIS company, searchable by Employee ID or name (EmployeeSearchField).
 * Legacy-tolerant the same way the profile-option pickers are: a stored signatory who has since left is
 * injected into the option list as "former employee" so the field still POSTS them, and editing the
 * phone number does not silently clear the signatory. (EmployeeSearchField drops a value that is not in
 * its list, which without this would have turned an unrelated save into a wipe.) The service refuses to
 * newly APPOINT a leaver — that rule is untouched.
 */
function StatutoryBodyCard({
  authority,
  row,
  statutory,
  filingCountry,
  companyId,
  bankProfiles,
  signatories,
  stateOptions,
  subordinate = false,
  editing,
  locked,
  onEdit,
  onCancel,
  actions,
}: CardProps) {
  const t = useTranslations('admin.organization');
  const r = row;
  const configured = !!r;
  const Icon = AUTHORITY_ICON[authority] ?? Landmark;
  const logo = AUTHORITY_LOGO[authority];
  // r226 — this body's FILING identity (the number on its filed form), where it has one. Distinct from
  // `accountNo`, which is the employer account on the PAYMENT SLIP. See MY_FILING_FIELD.
  const filing = filingCountry === 'MY' ? MY_FILING_FIELD[authority] : undefined;
  const showHrdf = filingCountry === 'MY' && authority === 'hrdf';
  const sharesSocsoCode = filingCountry === 'MY' && authority === 'eis';

  /**
   * ⚠️ AN ABSENT VALUE SAYS "Not set"; IT NEVER GUESSES. HRD Corp's band is shown only when the identity
   * row actually carries one: payroll resolves a MISSING row to 'not_registered' and charges nothing, but
   * printing "No Contribution" for a company that has no row at all would assert a registration decision
   * nobody made (§8 — an absent box asserts nothing).
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
  /**
   * The signatory as a PERSON, not as an id. A stored signatory who has left the company is named as
   * "Former employee (kept on record)" rather than shown as a UUID or, worse, as "Not set" — the value
   * IS on file and still governs a payment advice.
   */
  const signatoryName = r?.signatoryPersonId
    ? (signatories.find((sg) => sg.personId === r.signatoryPersonId)?.name ?? t('authoritySignatoryFormer'))
    : null;
  const address = [r?.addressLine1, r?.addressLine2, r?.addressLine3, r?.city, r?.postcode, r?.state, r?.country]
    .filter((v) => !!v && String(v).trim() !== '')
    .join(', ');

  /**
   * WHAT IS ON FILE, READ WITHOUT PRESSING ANYTHING. A `<dl>` because each entry is a caption and its
   * value, and the caption is what stops the FILING number and the PAYMENT reference being mistaken for
   * each other (r226). Rendered as text, never as a disabled input.
   */
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
      // 3c2f55d7 rev 2 — the company's own debit account is printed IN FULL on this admin-only screen.
      label: t('authorityBankAccount'),
      value: paidFrom ? (paidFrom.accountLabel || myBankLabel(paidFrom.bank)) + ' · ' + paidFrom.debitAccountNo : null,
    },
    { key: 'signatory', label: t('authoritySignatory'), value: signatoryName },
    { key: 'address', label: t('authorityAddressSection'), value: address || null },
    { key: 'phone', label: t('phone'), value: r?.phone || null },
    { key: 'email', label: t('authorityEmail'), value: r?.email || null },
  ];

  // The searchable option list: this company's active employees, plus — only when the saved signatory is
  // no longer among them — the stored person, so the hidden input keeps posting the id already on record.
  const signatoryOptions: EmployeeSearchOption[] = signatories.map((sg) => ({
    value: sg.personId,
    name: sg.name,
    employeeCode: sg.employeeCode,
  }));
  if (r?.signatoryPersonId && !signatories.some((sg) => sg.personId === r.signatoryPersonId)) {
    signatoryOptions.unshift({ value: r.signatoryPersonId, name: t('authoritySignatoryFormer'), employeeCode: null });
  }

  return (
    <section
      data-statutory-card={authority}
      data-statutory-mode={editing ? 'editing' : 'viewing'}
      className={cn(
        'space-y-3 rounded-lg border bg-card p-3',
        editing ? 'border-primary' : 'border-border',
        // efe424b0 / approved point 6 — EIS is drawn beneath SOCSO and indented. It is inside SOCSO's
        // grid cell (see `cells` below) so "under SOCSO" is true of the LAYOUT and not only of the
        // reading order, which a two-column grid would otherwise have broken.
        subordinate && 'ml-6',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* efe424b0 — the body's OWN mark, from public/statutory/, with the Lucide icon as the fallback
              for a body whose file we do not have. `object-contain` on a fixed box because the seven marks
              are different shapes. Decorative, so it carries an empty alt and the body's NAME is the text
              beside it. A SUBORDINATE card shows no mark: the group head above it already carries
              PERKESO's, and a second copy would read as a second organisation rather than the same one. */}
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
          <div className="min-w-0 space-y-1">
            {/* Dynamic message keys (`authority_epf` / `authorityDesc_epf`, …) — one pair per entry in
                STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's
                existing convention for a computed key. NOTE: the i18n-coverage test cannot see dynamic
                keys, so adding an authority means adding BOTH its label and its description to all six
                locales by hand (test/company-panel-bank-statutory-layout.test.ts checks that they exist). */}
            <div className="truncate text-sm font-semibold text-foreground">
              {t(`authority_${authority}` as never)}
            </div>
            <p className="text-xs leading-snug text-muted-foreground">{t(`authorityDesc_${authority}` as never)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={editing ? badge.primary : configured ? badge.emerald : badge.muted}>
            {editing ? t('authorityEditing') : configured ? t('authorityConfigured') : t('authorityNotConfigured')}
          </span>
          {!editing && (
            <button
              type="button"
              onClick={onEdit}
              disabled={locked}
              className="text-xs font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            >
              {t('authorityEdit')}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <form action={actions.setStatutoryAuthority} data-statutory-form={authority} className="space-y-3">
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="authority" value={authority} />
            {/* The marker that keeps the operator on THIS screen after the save, and names the body in the
                confirmation. See RETURN_TO_SETUP above. */}
            <input type="hidden" name="returnTo" value={RETURN_TO_SETUP} />
            {/* `filingCountry` is the hidden flag that tells the writer a filing control was on this form
                at all, and it is deliberately NOT called `country`: that name is already taken further
                down by the body's postal address, and a collision there would post a country NAME into
                the statutory-pack lookup (`No statutory pack for Malaysia`). Emitted once, for whichever
                of the two controls is present; a body with neither posts nothing towards the identity row.
                KEPT FROM r352 — the rename is the fix for a real defect that killed every identity save,
                and this screen still puts a filing control and a visible postal `country` on one form. */}
            {(filing || showHrdf) && <input type="hidden" name="filingCountry" value={filingCountry} />}

            {/* ── GROUP 1 · THE FILING IDENTITY (r226) ─────────────────────────────────────────── */}
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
                )}
                {sharesSocsoCode && <p className="text-xs text-muted-foreground">{t('authorityEisSharesSocso')}</p>}
              </div>
            )}

            {/* ── GROUP 2 · THE PAYMENT SETUP ──────────────────────────────────────────────────── */}
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
                        // 3c2f55d7 rev 2 — the account number is shown IN FULL. It was masked to its last
                        // four digits, which is an employee-facing habit applied where it does not belong:
                        // this screen is admin-only (RLS), the number is the company's OWN debit account,
                        // and an admin routing EPF to the right account needs to read the whole thing. The
                        // masks on EMPLOYEE bank details elsewhere are a different decision and stay.
                        <option key={bp.id} value={bp.id}>
                          {(bp.accountLabel || myBankLabel(bp.bank)) + ' · ' + bp.debitAccountNo}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                {/* Not a <Field>: that WRAPS its children in a <label>, and this control is a div holding
                    two inputs plus a clear button — a wrapping label would attach itself to whichever
                    input came first and every click on the row would re-focus the text box. The caption
                    points at the field's own id instead. `fieldLabel` is kept on the prop because
                    lib/tab-save-dom.ts reads it for a change summary, and the personnel tab-save guards
                    depend on that pair (see `hiddenInputIsUserFacing`); it costs nothing here. */}
                <div className="flex flex-col gap-1.5 sm:col-span-3">
                  <label
                    htmlFor={`sig-${authority}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {t('authoritySignatory')}
                  </label>
                  <EmployeeSearchField
                    id={`sig-${authority}`}
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

            {/* ── GROUP 3 · THE CORRESPONDENCE ADDRESS ─────────────────────────────────────────── */}
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
                  <OptionSelect
                    name="state"
                    value={r?.state ?? null}
                    options={stateOptions}
                    placeholder={t('optionNone')}
                  />
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

            {/* Approved point 3: Save and Cancel, on this card, for this body alone. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm">
                {t('authoritySave')}
              </Button>
              <button
                type="button"
                onClick={onCancel}
                className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('authorityCancel')}
              </button>
            </div>
          </form>

          {/* Bucket (b) of docs/audits/65b22c00-organization-save-classification.md: this DELETES the
              body's row, so it is a form of its own and outside the card's Save. Kept on the screen the
              editor moved to — it is the only place in the product that can clear a body's payment
              setup, and dropping it here would have removed a capability rather than relocating it. */}
          {r && (
            <form action={actions.removeStatutoryAuthority} data-statutory-clear={authority}>
              <input type="hidden" name="id" value={r.id} />
              {/* `id` is the authority ROW; `companyId` is where the save came from and therefore where
                  it returns to, and `returnTo` says WHICH of that company's two screens. */}
              <input type="hidden" name="companyId" value={companyId} />
              <input type="hidden" name="returnTo" value={RETURN_TO_SETUP} />
              <button className="text-xs font-medium text-rose-600 hover:underline dark:text-rose-400">
                {t('authorityClear')}
              </button>
            </form>
          )}
        </>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {summary.map((f) => (
            <div key={f.key} className="col-span-2 flex min-w-0 items-baseline justify-between gap-2">
              <dt className="shrink-0 text-muted-foreground">{f.label}</dt>
              <dd className={cn('truncate text-right', f.value ? 'font-medium text-foreground' : 'italic text-muted-foreground')}>
                {f.value ?? t('authorityValueNotSet')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/**
 * THE SCREEN. Every supported body visible at once, each read-only until its own Edit is pressed.
 *
 * ⚠️ NOTHING IS FILTERED OUT AND NOTHING IS SLICED. The cards run over `STATUTORY_AUTHORITIES` itself,
 * in the controlled set's own order, which is also the order the company panel's read-only rail lists
 * them in — so a body cannot appear on one screen and vanish from the other.
 */
export function StatutorySetupScreen({
  companyId,
  filingCountry,
  statutory,
  statutoryAuthorities = [],
  bankProfiles = [],
  signatories = [],
  stateOptions = [],
  actions,
}: {
  companyId: string;
  filingCountry: string;
  statutory: PanelStatutory;
  statutoryAuthorities?: PanelStatutoryAuthority[];
  bankProfiles?: PanelBankProfile[];
  signatories?: PanelSignatory[];
  stateOptions?: PanelOption[];
  actions: StatutorySetupActions;
}) {
  const t = useTranslations('admin.organization');
  /**
   * WHICH card is open, as client state. `null` on arrival: the screen opens entirely read-only, which is
   * approved point 3 — "Each card starts READ-ONLY showing what is saved, with an Edit button."
   *
   * One value, not a set, and that is the requirement rather than an optimisation: one card editable at a
   * time is what removes the two-dirty-scopes problem r352 recorded, because there is never a second
   * unsaved form for a save or a navigation to lose.
   */
  const [editing, setEditing] = useState<string | null>(null);

  const cardFor = (authority: string, subordinate = false) => (
    <StatutoryBodyCard
      key={authority}
      authority={authority}
      row={statutoryAuthorities.find((r) => r.authority === authority) ?? null}
      statutory={statutory}
      filingCountry={filingCountry}
      companyId={companyId}
      bankProfiles={bankProfiles}
      signatories={signatories}
      stateOptions={stateOptions}
      subordinate={subordinate}
      editing={editing === authority}
      locked={editing !== null}
      onEdit={() => setEditing(authority)}
      onCancel={() => setEditing(null)}
      actions={actions}
    />
  );

  /**
   * ⚠️ SOCSO AND EIS ARE ONE GRID CELL, NOT ONE SETTING — approved point 6, and the layout half of it.
   *
   * The drawing puts the cards in two columns and indents EIS. In a two-column grid the third card lands
   * under the FIRST, not under SOCSO, so "EIS indented under SOCSO" would have been true of the reading
   * order and false of the picture. Pairing them inside one cell makes it true of both, and it is the
   * arrangement the drawing was describing.
   *
   * They remain TWO RECORDS with two forms: measured on production 2026-09-22 their payment accounts
   * genuinely differ (one company pays SMSB_EIS and SMSB_SOCSO), so a single card backed by SOCSO's row
   * would leave EIS's account on file with no screen able to edit it. See
   * lib/statutory-authority-display.ts.
   */
  const perkesoGroup = filingCountry === 'MY';
  const cells = STATUTORY_AUTHORITIES.filter((a) => !(perkesoGroup && a === 'eis')).map((a) =>
    perkesoGroup && a === 'socso' ? (
      <div key="perkeso" className="space-y-3">
        {cardFor('socso')}
        {cardFor('eis', true)}
      </div>
    ) : (
      cardFor(a)
    ),
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('authoritiesHint')}</p>
      {bankProfiles.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('authoritiesNoBankAccounts')}</p>
      )}
      {/* Said on screen rather than left for the reader to discover from a dead button — see the
          "ONE CARD AT A TIME" note at the top of this file. */}
      {editing !== null && (
        <p className="text-xs text-muted-foreground" data-statutory-editing-hint>
          {t('statutoryScreenEditingHint')}
        </p>
      )}
      <div className="grid items-start gap-3 lg:grid-cols-2">{cells}</div>
    </div>
  );
}
