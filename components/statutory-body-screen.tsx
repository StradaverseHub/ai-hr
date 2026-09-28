'use client';

/**
 * ═══ 15e5bd93 REVISION 3 (r355) — ONE STATUTORY BODY, ON A SCREEN OF ITS OWN ═══════════════════════
 *
 * ⚠️ THIS IS THE THIRD SHAPE FOR ONE ITEM AND THE FIRST ONE THE REPORTER DREW THEMSELVES. r352 built a
 * rail plus a workspace INSIDE the company panel's Statutory tab; contested. r353 built a dedicated screen
 * whose body was EIGHT ALWAYS-VISIBLE CARDS, each read-only until its own Edit was pressed; contested
 * again. The reporter then drew the layout in the ticket as an ASCII sketch, transcribed into
 * docs/mockups/15e5bd93-statutory-rows-r3.html, and it says: the list is a TABLE of one row per body, and
 * "Selecting Edit → EPF opens a screen containing ONLY the EPF fields, with Cancel / Save."
 *
 * So this file is `StatutoryBodyCard` from r353, MOVED rather than rewritten. The editor itself is
 * unchanged in substance: the same three group headings, the same field order, the same thirteen posted
 * names, the same `filingCountry` flag, the same signatory tolerance, the same `<dl>` for view mode. What
 * changed is what decides which of the two is shown.
 *
 * ── VIEW / EDIT IS NOW THE URL, NOT CLIENT STATE, AND THAT REPLACES THREE r353 MECHANISMS ─────────
 * r353 held `editing: string | null` on the screen, disabled the other seven Edit buttons while one card
 * was open, and explained the lock on screen (`statutoryScreenEditingHint`). All three existed for ONE
 * reason, which that round recorded: unmounting a dirty form when another card's Edit was pressed would
 * discard typing silently. There is no second form on this screen to discard, so:
 *
 *   · `?mode=edit` renders the form; anything else renders the `<dl>`. The mode is a CLOSED LIST resolved
 *     on the server (see the route) — never the posted string echoed back.
 *   · Cancel is a LINK to the list, not an onClick. Leaving the page is what discards, which is the
 *     plainest possible version of "Cancel really discards": there is no form left mounted to hold typing.
 *   · `statutoryScreenEditingHint` and `authorityEditing` are RETIRED — kept in all six catalogues, the way
 *     `authorityOpen`, `authorityClose`, `tabOther` and `tabBankAccount` each were, because a retired string
 *     costs nothing and re-translating a deleted one into six languages costs a round. Two of those four
 *     have already come back.
 *
 * ── WHERE A SAVE AND A REFUSAL GO, AND WHY THEY DIFFER ───────────────────────────────────────────
 * The approved plan: "Saving writes only that body and returns you to the list with its row refreshed."
 * So SUCCESS leaves this screen — `okStatutorySetup` already builds exactly that address, unchanged from
 * r353. A REFUSAL must NOT: the message is about a form that is only on this route, and app/admin/
 * _redirects.ts states the rule in its own words ("a refused save … showed the refusal on a screen that no
 * longer held the form it was about"). `failStatutoryBody` returns here with `?mode=edit`, which is the one
 * thing r355 adds to the r353 redirect contract.
 *
 * ── TWO DIFFERENT NUMBERS, TWO CAPTIONS — r226's rule, unchanged ──────────────────────────────────
 * The FILING number goes on the body's filed form (`company_statutory_my`); the employer account is the
 * reference on its PAYMENT slip (`company_statutory_authority`). They are not duplicates, and merging them
 * into one anonymous "employer number" is the exact fault r226 was raised for.
 *
 * ⚠️ THE FILING NUMBER IS EDITED HERE AND NOWHERE ELSE. The rev-3 list screen prints the four filing
 * identifiers in a READ-ONLY card at the top (approved: "so you can confirm whose configuration you are
 * about to edit"). Read-only there, editable here, one owner — `company_statutory_my` through
 * MY_FILING_FIELD. Two editable copies would be two doors onto one column and whichever was saved second
 * would win, which is the fault this map was built to prevent.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COUNTRY_NAME_OPTIONS } from '@/lib/countries';
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
 * 15e5bd93 — THE MARKER THAT TELLS `setCompanyStatutoryAuthorityAction` WHICH SCREEN IT WAS PRESSED ON.
 *
 * Unchanged from r353, deliberately: the statutory payment setup is still ONE flow, it just spans two
 * routes now. Success goes to the list either way; the refusal path reads the posted `authority` — through
 * `isStatutoryAuthority`, never as a raw string — to come back to this screen.
 *
 * An EXPLICIT hidden input rather than a client-injected marker, so it does not depend on hydration, and a
 * fixed literal compared against a literal on the server, never a path echoed into a redirect.
 * `app/admin/actions.ts` `fromStatutorySetupScreen` is the other half; the two strings are pinned against
 * each other by test/organization-stay-on-save.test.ts.
 */
const RETURN_TO_SETUP = 'statutory-setup';

const badge = {
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  // 3783fd87 — a LINED chip, not a filled grey one: on a white card a grey fill is the thing the reporter
  // asked us to take out, and a border carries the same boundary.
  muted:
    'rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

type Action = (fd: FormData) => void | Promise<void>;

export type StatutorySetupActions = {
  setStatutoryAuthority: Action;
  removeStatutoryAuthority: Action;
};

/** The two shapes of this screen. A CLOSED SET, resolved on the server — see the route. */
export type StatutoryBodyMode = 'view' | 'edit';

export function StatutoryBodyScreen({
  mode,
  authority,
  companyId,
  filingCountry,
  statutory,
  row,
  bankProfiles = [],
  signatories = [],
  stateOptions = [],
  actions,
}: {
  mode: StatutoryBodyMode;
  /** Already validated through `isStatutoryAuthority` by the route. Never a posted string. */
  authority: string;
  companyId: string;
  /** ISO code of the company. 'MY' is the only pack with a filing identity today. */
  filingCountry: string;
  statutory: PanelStatutory;
  row: PanelStatutoryAuthority | null;
  bankProfiles?: PanelBankProfile[];
  signatories?: PanelSignatory[];
  stateOptions?: PanelOption[];
  actions: StatutorySetupActions;
}) {
  const t = useTranslations('admin.organization');
  const editing = mode === 'edit';
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
   * THE TWO ADDRESSES THIS SCREEN KNOWS, BUILT IN ONE PLACE from the company id and the ALREADY-VALIDATED
   * authority. Back, Cancel and Save all land on the list; Edit is this same route with the other mode.
   */
  const listHref = `/admin/organization/${companyId}/statutory`;
  const editHref = `${listHref}/${authority}?mode=edit`;

  /**
   * ⚠️ AN ABSENT VALUE SAYS "Not set"; IT NEVER GUESSES. HRD Corp's band is shown only when the identity
   * row actually carries one: payroll resolves a MISSING row to 'not_registered' and charges nothing
   * (core/payroll.ts), but printing "No Contribution" for a company that has no row at all would assert a
   * registration decision nobody made (§8 — an absent box asserts nothing).
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
   * each other (r226). Rendered as text, never as a disabled input: a greyed-out box looks like something
   * you can fix where you are standing, and view mode is not a writer.
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
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* efe424b0 — the body's OWN mark, from public/statutory/, with the Lucide icon as the fallback
              for a body whose file we do not have. `object-contain` on a fixed box because the seven marks
              are different shapes. Decorative, so it carries an empty alt and the body's NAME is the text
              beside it. NOTE: unlike r353's card there is no subordinate case here — EIS gets the PERKESO
              mark on its OWN screen, because it is the only body on it and there is no group head above it
              to carry it once. The indent that expresses "EIS under SOCSO" belongs to the list. */}
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
          <div className="min-w-0 space-y-1">
            {/* Dynamic message keys (`authority_epf` / `authorityDesc_epf`, …) — one pair per entry in
                STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's
                existing convention for a computed key. NOTE: the i18n-coverage test cannot see dynamic
                keys, so adding an authority means adding BOTH its label and its description to all six
                locales by hand (test/company-panel-bank-statutory-layout.test.ts checks that they exist). */}
            <div className="truncate text-sm font-semibold text-foreground">
              {t(`authority_${authority}` as never)}
            </div>
            <p className="text-xs leading-snug text-muted-foreground">
              {editing ? t('statutoryBodyEditCaption') : t('statutoryBodyViewCaption')}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={configured ? badge.emerald : badge.muted}>
            {configured ? t('authorityConfigured') : t('authorityNotConfigured')}
          </span>
          {/* VIEW MODE IS NOT A DEAD END. The reporter's sketch only draws the list and the edit screen, but
              a read-only page whose only way forward is the browser Back button is a screen that has to be
              escaped rather than used. A LINK to this same route in the other mode — never a button, because
              nothing here toggles client state. */}
          {!editing && (
            <Link href={editHref} className="text-xs font-medium text-primary hover:underline" data-statutory-edit-link>
              {t('authorityEdit')}
            </Link>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <form action={actions.setStatutoryAuthority} data-statutory-form={authority} className="space-y-3">
            <input type="hidden" name="companyId" value={companyId} />
            <input type="hidden" name="authority" value={authority} />
            {/* The marker that says which flow this save belongs to: the save returns to the LIST and a
                REFUSAL returns here. See RETURN_TO_SETUP above. */}
            <input type="hidden" name="returnTo" value={RETURN_TO_SETUP} />
            {/* `filingCountry` is the hidden flag that tells the writer a filing control was on this form
                at all, and it is deliberately NOT called `country`: that name is already taken further
                down by the body's postal address, and a collision there would post a country NAME into
                the statutory-pack lookup (`No statutory pack for Malaysia`). Emitted once, for whichever
                of the two controls is present; a body with neither posts nothing towards the identity row.
                KEPT FROM r352 THROUGH r353 AND r355 — the rename is the fix for a real defect that killed
                every identity save, and this screen still puts a filing control and a visible postal
                `country` on one form. */}
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
                    lib/tab-save-dom.ts reads it for a change summary; r353 established that this file's
                    predecessor was the ONLY exercise of `hiddenInputIsUserFacing` / `controlDisplay` in the
                    repo, so the prop and its direct coverage both stay. */}
                <div className="flex flex-col gap-1.5 sm:col-span-3">
                  <label htmlFor={`sig-${authority}`} className="text-xs font-medium text-muted-foreground">
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

            {/* Cancel and Save, for this body alone, in the drawing's own order. Cancel is a LINK because
                there is no client state to reset — leaving the route IS the discard, and a <button> here
                would have to be outside the form or it would submit it. */}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Link
                href={listHref}
                className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                data-statutory-cancel-link
              >
                {t('authorityCancel')}
              </Link>
              <Button type="submit" size="sm">
                {t('authoritySave')}
              </Button>
            </div>
          </form>

          {/* Bucket (b) of docs/audits/65b22c00-organization-save-classification.md: this DELETES the
              body's row, so it is a form of its own and outside the Save. It is the only place in the
              product that can clear a body's payment setup, and it moved here with the editor rather than
              being dropped. `authority` rides along ONLY so a refused Clear can be returned to this
              screen — `removeCompanyStatutoryAuthorityAction` keys the delete off the row `id`. */}
          {r && (
            <form action={actions.removeStatutoryAuthority} data-statutory-clear={authority}>
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="companyId" value={companyId} />
              <input type="hidden" name="authority" value={authority} />
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
              <dd
                className={cn(
                  'truncate text-right',
                  f.value ? 'font-medium text-foreground' : 'italic text-muted-foreground',
                )}
              >
                {f.value ?? t('authorityValueNotSet')}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
