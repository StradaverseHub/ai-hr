'use client';

/**
 * ═══ 15e5bd93 REVISION 4 (r371) — ONE SCREEN, EVERY BODY OPEN, ONE SAVE ════════════════════════════
 *
 * ⚠️ FOURTH SHAPE FOR ONE ITEM, AND THE FIRST ONE BUILT AFTER SOMEBODY MEASURED THE LIVE SCREEN.
 * r352 built a rail plus a workspace INSIDE the company panel's Statutory tab; contested. r353 built a
 * dedicated screen of EIGHT ALWAYS-VISIBLE CARDS, each read-only until its own Edit was pressed;
 * contested. r355 built the reporter's own ASCII sketch — a TABLE of one row per body with View / Edit
 * drilling into `…/statutory/[authority]` — and the reporter called that drill-in "an unnecessary
 * intermediate page".
 *
 * The three previous rounds each re-read the words and re-arranged the information. This one rendered the
 * screen at 1280 / 1024 / 820 CSS px and MEASURED it, and the finding is that r355's shape was not merely
 * the wrong arrangement: it was visually broken. The Action column laid out past the right edge of its
 * container (the body description carried `truncate`, whose `white-space: nowrap` made the first cell's
 * min-content the whole 132-character description, 786px of a ~1000px table), so the `Action` heading
 * rendered as "AC" and the Edit link was not painted at all; the status pill's text wrapped OUT of its
 * own rounded background; the correspondence address was ellipsised with the literal "…" the reporter
 * drew; and on the body page the label sat at the far left of a 998px row with its value at the far
 * right. So this round REMOVES a shape rather than inventing a fifth one.
 *
 * ── WHAT THE REPORTER'S THREE FIELDS ASK FOR, READ AS ONE DOCUMENT ────────────────────────────────
 *   · expected_behavior — every statutory body as its own card on one dedicated full-width screen
 *   · expected_function — ONE Save for the entire screen, everything written together, staying here
 *   · the contest       — no intermediate page, and no View/Edit click after arriving
 * The only shape that satisfies all three at once is this one: one screen, all eight bodies as cards,
 * every field already open for typing, one Save. Their "Statutory Type" heading and "only the sections
 * applicable to the selected type" are PER CARD — each card is headed by its body and shows only the
 * groups that body has (EIS has no filing number of its own; only HRD Corp has a contribution rate).
 * The contest is their latest word, so expected_behavior's separate View mode with an Edit button is
 * superseded by it.
 *
 * ── WHAT WAS MOVED HERE RATHER THAN REWRITTEN ────────────────────────────────────────────────────
 * `StatutoryBodyCard` below IS r355's `components/statutory-body-screen.tsx` editor, folded back in as a
 * card: the same three group headings, the same field order, the same thirteen posted names, the same
 * `filingCountry` hidden flag, the same tolerance for a signatory who has left, the same Clear form and
 * the same EIS sentence. What went with the per-body route, and only because the mechanism it served no
 * longer exists:
 *   · `mode` / `StatutoryBodyMode` and the whole read-only `<dl>`. There is no View step to render.
 *   · the per-card Cancel link and the per-card Save button. There is ONE Save for the screen.
 *   · `statutoryBodyViewCaption`, `backToStatutorySetup`, `authorityView` and the four column captions.
 *     RETIRED in all six catalogues, never deleted — i18n/request.ts deep-merges each locale over
 *     English, so dropping a key from en.json alone leaves a Malay reader the old sentence.
 *
 * ── WHAT WENT WITH THE TABLE, AND THE SPELLINGS SO A FUTURE ROUND KNOWS WHAT IT IS RE-ADDING ──────
 * Two layout mechanisms existed only to express "EIS belongs under SOCSO" in a container that could not
 * say it any other way, and both are gone because the container is:
 *
 *   · `subordinate` — the r355 table's presentation flag, `subordinate={perkesoGroup && a === 'eis'}` on
 *     the row and `subordinate && 'pl-6'` on its first cell. Eight full-width cards in the controlled
 *     set's own order carry adjacency by themselves, and EIS says in WORDS that it files under SOCSO's
 *     employer code — which survives a layout change, as an indent does not.
 *   · `cardFor('eis', true)` — r353's re-draw of EIS inside SOCSO's own cell. That existed ONLY because
 *     r353 laid the cards out in a TWO-COLUMN GRID, where the third card lands under the first rather
 *     than under SOCSO. One column of cards needs neither, and — the safer half — the controlled set now
 *     maps straight through with no `.filter()` anywhere, which is the one shape that can silently drop a
 *     body.
 *
 * Also gone: the r355 `<table>` and the four house constants it used (`tableWrapCls`, `theadCls`,
 * `thCls`, `tbodyCls`). `tableWrapCls`'s `overflow-x-auto` is what hid the clipped Action column behind a
 * scroller with no affordance, and there is no horizontal scroller on this screen at all now. The shared
 * constants themselves are untouched: every other admin table keeps the house look.
 *
 * ── THE TWO STATUS COLUMNS ARE GONE WITH THE TABLE, AND THE PREVIOUS ANSWER IS CARRIED FORWARD ────
 * r355's list drew two columns and the r355 plan told the reporter what each one meant:
 *
 *     "Payment Setup  =  we hold a payment record for that body
 *      Status         =  it is actually contributing"
 *
 * That answer was honest and it is RETIRED rather than silently dropped. Both columns belonged to the
 * table, and the table is gone. Each card now carries ONE word — Set up / Not set up — which means the
 * same thing for all eight bodies: a `company_statutory_authority` row exists. It is still derived
 * through `statutoryRowStatus`, the one shared derivation, so this screen and any future reader cannot
 * disagree about what "set up" means. HRD Corp's separate fact — whether it contributes at all — is the
 * HRDF Contribution Rate select on its own card, which is where it is CHOSEN, so it is still on the
 * screen and still honest.
 *
 * ── WHAT THE SAVE IS, AND THE ONE PROPERTY THAT MATTERS MOST ─────────────────────────────────────
 * `TabSaveScope` (r352's rails, still live for the General tab) wraps the eight cards; each body's form
 * carries `data-save-section="<authority>"`; `saveCompanyStatutoryTabAction` unpacks the dirty ones.
 *
 * ⚠️ ONLY THE BODIES THE OPERATOR TOUCHED ARE WRITTEN. A Save that wrote all eight would CREATE a
 * `company_statutory_authority` row for every body and flip every "Not set up" card to "Set up" —
 * registering eight statutory bodies because somebody fixed a postcode. The dirty set is computed from
 * the live DOM by lib/tab-save-dom.ts and enforced again on the server.
 *
 * ── THE IDENTITY CARD IS READ-ONLY HERE. THE DECISION, STATED ─────────────────────────────────────
 * The four filing identifiers live on `company_statutory_my`, and they are EDITED inside each body's own
 * card through `MY_FILING_FIELD` (r226). This card PRINTS them and holds no input at all. SSM and
 * MyInvois keep their one editor on the company panel's Statutory tab, where r226 put them. Editable in
 * two places would be two doors onto one column, and whichever was saved second would win.
 */
import { useTranslations } from 'next-intl';
import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { COUNTRY_NAME_OPTIONS } from '@/lib/countries';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
import { AUTHORITY_ICON, AUTHORITY_LOGO, MY_FILING_FIELD, statutoryRowStatus } from '@/lib/statutory-authority-display';
import { myBankLabel } from '@/lib/my-banks';
import type { TabSaveResult } from '@/lib/tab-save-sections';
import { Field, inputCls } from './ui';
import { OptionSelect } from './option-select';
import { EmployeeSearchField, type EmployeeSearchOption } from './employee-search-field';
import { TabSaveScope } from './tab-save-scope';
// TYPE-ONLY, so nothing of the company panel reaches this route's bundle: the five shapes are that
// panel's props contract and a second declaration of them is a second thing to keep in step.
import type {
  PanelBankProfile,
  PanelOption,
  PanelSignatory,
  PanelStatutory,
  PanelStatutoryAuthority,
} from './company-panel';

/**
 * 15e5bd93 — THE MARKER THAT TELLS `removeCompanyStatutoryAuthorityAction` WHICH SCREEN IT WAS PRESSED
 * ON, so a cleared body lands back here rather than on the company panel.
 *
 * An EXPLICIT hidden input rather than a client-injected marker, so it does not depend on hydration, and
 * a fixed literal compared against a literal on the server, never a path echoed into a redirect.
 * `app/admin/actions.ts` `fromStatutorySetupScreen` is the other half; the two strings are pinned
 * against each other by test/organization-stay-on-save.test.ts.
 */
const RETURN_TO_SETUP = 'statutory-setup';

/**
 * ⚠️ `whitespace-nowrap` IS A FIX, NOT A FLOURISH (defect D2, measured on the live r355 screen). Without
 * it "Not set up" wrapped inside a squeezed 81px column and the word "UP" rendered OUTSIDE the rounded
 * background — a pill with its own text falling out of it.
 */
const badge = {
  emerald:
    'whitespace-nowrap rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  // 3783fd87 — a LINED chip, not a filled grey one: on a white card a grey fill is the thing the reporter
  // asked us to take out, and a border carries the same boundary.
  muted:
    'whitespace-nowrap rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

/**
 * ONE GRID FOR EVERY GROUP ON EVERY CARD (defect D6). Measured on r355's edit form at 1280: the filing
 * number was 484px (a 2-column grid), the account number, city, state, postcode, country, phone and
 * email were 320px (a 3-column grid), the bank select 648px and the signatory and address lines 976px —
 * four widths for one kind of field, with a postcode box as wide as an email box.
 *
 * Every group on every card now uses THIS constant and spans of 1 or 3 only, so a box of a given kind is
 * the same width wherever it appears and every label sits directly above its own control on one of three
 * shared column lines.
 */
const cardGridCls = 'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-3';

function SubHeader({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

type Action = (fd: FormData) => void | Promise<void>;

export type StatutorySetupActions = {
  /**
   * THE ONE SAVE. A `'use server'` action passed by reference from the RSC page (the r123 hazard is a
   * closure built in the page, not a reference handed down). `app/admin/organization/statutory-tab-actions.ts`.
   */
  saveStatutoryScreen: (fd: FormData) => Promise<TabSaveResult>;
  /**
   * Each body form's own binding. It is NOT the reader's route to a write any more — `TabSaveScope`
   * intercepts `submit` on every `[data-save-section]` form and turns it into the consolidated save —
   * but the binding stays, because a `<form>` with no action at all POSTs to the current URL, and
   * because a bound form is what that guard intercepts.
   */
  setStatutoryAuthority: Action;
  /** "Clear this authority" — bucket (b), its own form OUTSIDE the section marker and outside the Save. */
  removeStatutoryAuthority: Action;
};

/**
 * STATUTORY IDENTITY (MY), AT THE TOP, READ-ONLY — so the reader can confirm whose configuration they are
 * about to edit before they touch it.
 *
 * Six facts in order: SSM registration no., MyInvois TIN, then the three filing numbers and HRD Corp's
 * rate. The three filing numbers are read out of `MY_FILING_FIELD` rather than spelled out here, so this
 * card and the per-body cards can never disagree about which number belongs to which body or what it is
 * called — the r226 fault in miniature.
 *
 * ⚠️ NO `truncate` ON A VALUE (defect D3). The r355 body page ellipsised an ordinary Malaysian
 * correspondence address — the literal "…" the reporter drew — because its value element carried
 * `truncate text-right`. Nothing on this screen is held to a single line: a value wraps rather than being
 * cut, and a label is never separated from what it names.
 *
 * ⚠️ AN ABSENT VALUE SAYS "Not set" AND NEVER GUESSES. HRD Corp's rate is printed only when the identity
 * row actually carries one: payroll resolves a MISSING row to 'not_registered' and charges nothing
 * (core/payroll.ts), but printing "No Contribution" for a company with no row at all would assert a
 * registration decision nobody made (§8 — an absent box asserts nothing).
 */
function IdentityCard({ statutory, filingCountry }: { statutory: PanelStatutory; filingCountry: string }) {
  const t = useTranslations('admin.organization');
  const hrdfBandKey =
    statutory?.hrdfStatus === 'mandatory'
      ? 'hrdfMandatory'
      : statutory?.hrdfStatus === 'optional'
        ? 'hrdfOptional'
        : statutory?.hrdfStatus === 'not_registered'
          ? 'hrdfNotRegistered'
          : null;

  const facts: { key: string; label: string; value: string | null }[] = [
    { key: 'ssmRegistrationNo', label: t('ssmRegistrationNo'), value: statutory?.ssmRegistrationNo || null },
    { key: 'myinvoisTin', label: t('myinvoisTin'), value: statutory?.myinvoisTin || null },
    // The three filing numbers, in the controlled set's order, taken from the SHARED map so that adding a
    // body with a filing number puts it on this card automatically rather than silently omitting it.
    ...(filingCountry === 'MY'
      ? STATUTORY_AUTHORITIES.flatMap((a) => {
          const f = MY_FILING_FIELD[a];
          return f ? [{ key: f.name, label: t(f.labelKey as never), value: statutory?.[f.name] || null }] : [];
        })
      : []),
    ...(filingCountry === 'MY'
      ? [{ key: 'hrdfStatus', label: t('hrdfStatusLabel'), value: hrdfBandKey ? t(hrdfBandKey as never) : null }]
      : []),
  ];

  return (
    <section data-statutory-identity className="rounded-lg border border-border bg-card p-4">
      <p className="text-sm font-semibold text-foreground">{t('statutoryIdentityMY')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('statutoryIdentityHint')}</p>
      <dl className={cn('mt-3', cardGridCls, 'gap-y-2')}>
        {facts.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{f.label}</dt>
            <dd
              className={cn(
                'break-words text-xs tabular-nums',
                f.value ? 'font-medium text-foreground' : 'italic text-muted-foreground',
              )}
            >
              {f.value ?? t('authorityValueNotSet')}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * ONE STATUTORY BODY, AS ONE CARD, WITH EVERY FIELD ALREADY OPEN FOR TYPING.
 *
 * No View step, no Edit button, no fold: the contest's own words are that both are an unnecessary click
 * between arriving and changing something. The card carries one word saying whether the body is set up,
 * and then the three groups it has.
 *
 * ⚠️ THE DESCRIPTION WRAPS (defect D1). r355's row held it on one line with `truncate`, and because
 * `white-space: nowrap` fixes a cell's min-content at the whole string, the 132-character SOCSO
 * description made the table 42–322px wider than its container and pushed the Action column off the
 * screen. Nothing on this screen is held to a single line.
 */
function StatutoryBodyCard({
  authority,
  companyId,
  filingCountry,
  statutory,
  row,
  bankProfiles,
  signatories,
  stateOptions,
  actions,
}: {
  /** Always a member of `STATUTORY_AUTHORITIES` — this screen maps the controlled set itself. */
  authority: string;
  companyId: string;
  /** ISO code of the company. 'MY' is the only pack with a filing identity today. */
  filingCountry: string;
  statutory: PanelStatutory;
  row: PanelStatutoryAuthority | null;
  bankProfiles: PanelBankProfile[];
  signatories: PanelSignatory[];
  stateOptions: PanelOption[];
  actions: StatutorySetupActions;
}) {
  const t = useTranslations('admin.organization');
  const r = row;
  /**
   * ONE WORD, DERIVED IN THE ONE PLACE. `statutoryRowStatus` is the shared derivation r355 introduced;
   * only its `configured` half is read now, because the card carries a single status word rather than
   * the two columns the table had. See the header note: the second fact is not lost, it is the HRDF
   * Contribution Rate select on HRD Corp's own card, where it is chosen.
   */
  const { configured } = statutoryRowStatus(authority, !!row, statutory?.hrdfStatus ?? null);
  const Icon = AUTHORITY_ICON[authority] ?? Landmark;
  const logo = AUTHORITY_LOGO[authority];
  // r226 — this body's FILING identity (the number on its filed form), where it has one. Distinct from
  // `accountNo`, which is the employer account on the PAYMENT SLIP. See MY_FILING_FIELD.
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
    signatoryOptions.unshift({ value: r.signatoryPersonId, name: t('authoritySignatoryFormer'), employeeCode: null });
  }

  return (
    <section data-statutory-card={authority} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* efe424b0 — the body's OWN mark, from public/statutory/, with the Lucide icon as the fallback
              for a body whose file we do not have. `object-contain` on a fixed box because the seven marks
              are different shapes. Decorative, so it carries an empty alt and the body's NAME is the text
              beside it. */}
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
          <div className="min-w-0 space-y-0.5">
            {/* Dynamic message keys (`authority_epf` / `authorityDesc_epf`, …) — one pair per entry in
                STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's
                existing convention for a computed key. NOTE: the i18n-coverage test cannot see dynamic
                keys, so adding an authority means adding BOTH its label and its description to all six
                locales by hand (test/company-panel-bank-statutory-layout.test.ts checks that they exist). */}
            <div className="text-sm font-semibold text-foreground">{t(`authority_${authority}` as never)}</div>
            <p className="text-xs leading-snug text-muted-foreground">{t(`authorityDesc_${authority}` as never)}</p>
          </div>
        </div>
        <span className={configured ? badge.emerald : badge.muted} data-statutory-card-status={authority}>
          {configured ? t('statutoryCardSetUp') : t('statutoryCardNotSetUp')}
        </span>
      </div>

      {/**
       * ⚠️ `data-save-section` IS THE FENCE. lib/tab-save-dom.ts reads, marks, packs and re-baselines
       * ONLY these subtrees, and `saveCompanyStatutoryTabAction` writes only the ones the client named.
       * The Clear form below deliberately does NOT carry it.
       */}
      <form
        action={actions.setStatutoryAuthority}
        data-save-section={authority}
        data-statutory-form={authority}
        className="space-y-4"
      >
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="authority" value={authority} />
        {/* The marker that says which flow a REFUSED Clear belongs to. The consolidated Save does not
            redirect at all — it returns a TabSaveResult — so this rides along for the one writer that
            still redirects. See RETURN_TO_SETUP above. */}
        <input type="hidden" name="returnTo" value={RETURN_TO_SETUP} />
        {/* `filingCountry` is the hidden flag that tells the writer a filing control was on this card at
            all, and it is deliberately NOT called `country`: that name is already taken further down by
            the body's postal address, and a collision there would post a country NAME into the
            statutory-pack lookup (`No statutory pack for Malaysia`). It matters MORE on this screen than
            it did on the per-body page — lib/tab-save-dom.ts `syncCarriedValues` copies a VISIBLE
            control's value into any hidden input of the same name, and there are now EIGHT visible
            postal `country` selects in one scope. Emitted once, for whichever of the two controls is
            present; a body with neither posts nothing towards the identity row. */}
        {(filing || showHrdf) && <input type="hidden" name="filingCountry" value={filingCountry} />}

        {/* ── GROUP 1 · THE FILING IDENTITY (r226) ─────────────────────────────────────────────── */}
        {(filing || showHrdf || sharesSocsoCode) && (
          <div className="space-y-2">
            <SubHeader>{showHrdf ? t('authorityRegistrationSection') : t('authorityFilingSection')}</SubHeader>
            {filing && <p className="text-xs text-muted-foreground">{t('authorityFilingHint')}</p>}
            {showHrdf && <p className="text-xs text-muted-foreground">{t('authorityRegistrationHint')}</p>}
            {sharesSocsoCode && <p className="text-xs text-muted-foreground">{t('authorityEisSharesSocso')}</p>}
            {(filing || showHrdf) && (
              <div className={cardGridCls}>
                {filing && (
                  <Field label={t(filing.labelKey as never)}>
                    <input name={filing.name} defaultValue={statutory?.[filing.name] ?? ''} className={inputCls} />
                  </Field>
                )}
                {showHrdf && (
                  <Field label={t('hrdfStatusLabel')}>
                    <select name="hrdfStatus" defaultValue={statutory?.hrdfStatus ?? 'not_registered'} className={inputCls}>
                      <option value="not_registered">{t('hrdfNotRegistered')}</option>
                      <option value="mandatory">{t('hrdfMandatory')}</option>
                      <option value="optional">{t('hrdfOptional')}</option>
                    </select>
                  </Field>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── GROUP 2 · THE PAYMENT SETUP ──────────────────────────────────────────────────────── */}
        <div className="space-y-2">
          <SubHeader>{t('authorityPaymentSection')}</SubHeader>
          <p className="text-xs text-muted-foreground">{t('authorityPaymentHint')}</p>
          <div className={cardGridCls}>
            <Field label={t('authorityAccountNo')}>
              <input
                name="accountNo"
                defaultValue={r?.accountNo ?? ''}
                className={inputCls}
                placeholder={t('authorityAccountNoHint')}
              />
            </Field>
            <Field label={t('authorityBankAccount')}>
              <select name="bankProfileId" defaultValue={r?.bankProfileId ?? ''} className={inputCls}>
                <option value="">{t('authorityBankAccountNone')}</option>
                {bankProfiles.map((bp) => (
                  // 3c2f55d7 rev 2 — the account number is shown IN FULL. It was masked to its last four
                  // digits, which is an employee-facing habit applied where it does not belong: this
                  // screen is admin-only (RLS), the number is the company's OWN debit account, and an
                  // admin routing EPF to the right account needs to read the whole thing. The masks on
                  // EMPLOYEE bank details elsewhere are a different decision and stay.
                  <option key={bp.id} value={bp.id}>
                    {(bp.accountLabel || myBankLabel(bp.bank)) + ' · ' + bp.debitAccountNo}
                  </option>
                ))}
              </select>
            </Field>
            {/* Not a <Field>: that WRAPS its children in a <label>, and this control is a div holding two
                inputs plus a clear button — a wrapping label would attach itself to whichever input came
                first and every click on the row would re-focus the text box. The caption points at the
                field's own id instead. `fieldLabel` is kept on the prop because lib/tab-save-dom.ts reads
                it for a change summary; r353 established that this editor was the ONLY exercise of
                `hiddenInputIsUserFacing` / `controlDisplay` in the repo, so the prop and its direct
                coverage (§4 of test/15e5bd93-statutory-screen.dom.test.tsx) both stay. */}
            <div className="flex min-w-0 flex-col gap-1.5">
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

        {/* ── GROUP 3 · THE CORRESPONDENCE ADDRESS ─────────────────────────────────────────────── */}
        <div className="space-y-2">
          <SubHeader>{t('authorityAddressSection')}</SubHeader>
          <p className="text-xs text-muted-foreground">{t('authorityAddressHint')}</p>
          <div className={cardGridCls}>
            {/* The address that r355's view mode joined into one comma-separated line and then
                ellipsised (D3) is THREE full-width boxes here, each holding its own line whole. */}
            <Field label={t('addressLine1')} className="sm:col-span-3">
              <input name="addressLine1" defaultValue={r?.addressLine1 ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addressLine2')} className="sm:col-span-3">
              <input name="addressLine2" defaultValue={r?.addressLine2 ?? ''} className={inputCls} />
            </Field>
            <Field label={t('addressLine3')} className="sm:col-span-3">
              <input name="addressLine3" defaultValue={r?.addressLine3 ?? ''} className={inputCls} />
            </Field>
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

      {/* Bucket (b) of docs/audits/65b22c00-organization-save-classification.md: this DELETES the body's
          row, so it is a form of its own, outside the section marker and outside the screen Save. It is
          the only place in the product that can clear a body's payment setup. `TabSaveScope`'s
          document-level submit guard asks before it writes while the screen is dirty, because its
          redirect would re-render the screen and take the unsaved edits with it. `authority` rides along
          ONLY so a refused Clear can be returned here — `removeCompanyStatutoryAuthorityAction` keys the
          delete off the row `id`. */}
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
    </section>
  );
}

/**
 * THE SCREEN. The read-only identity card, then one card per supported body, inside one save scope.
 *
 * ⚠️ NOTHING IS FILTERED OUT AND NOTHING IS SLICED. The cards run over `STATUTORY_AUTHORITIES` itself, in
 * the controlled set's own order — which is also the order the company panel's read-only list uses, so a
 * body cannot appear on one screen and vanish from the other. EIS is a card of its own, immediately after
 * SOCSO, and says on its face that it files under SOCSO's employer code: its PAYMENT account genuinely
 * differs from SOCSO's on this tenant (see the consolidation note in lib/statutory-authority-display.ts),
 * so merging the two would leave EIS's account on file with no screen able to edit it.
 */
export function StatutorySetupScreen({
  companyId,
  filingCountry,
  statutory,
  statutoryAuthorities = [],
  bankProfiles = [],
  signatories = [],
  stateOptions = [],
  backHref,
  actions,
}: {
  companyId: string;
  filingCountry: string;
  statutory: PanelStatutory;
  statutoryAuthorities?: PanelStatutoryAuthority[];
  bankProfiles?: PanelBankProfile[];
  signatories?: PanelSignatory[];
  stateOptions?: PanelOption[];
  /** Where Cancel goes — the company's Statutory TAB, which is also where the header's Back link goes. */
  backHref: string;
  actions: StatutorySetupActions;
}) {
  const t = useTranslations('admin.organization');

  return (
    <TabSaveScope
      tabKey="statutory"
      identity={{ companyId }}
      saveAction={actions.saveStatutoryScreen}
      /**
       * WHAT THE BAR SAYS IT COVERS. On this screen the scope really is the whole screen, so it names
       * every body — which is also the honest answer to "what does one Save write?": whichever of these
       * you touched. The identity card is NOT named, because it is read-only and cannot be saved from
       * here; a bar naming a card the reader cannot change is the control-that-lies the prop exists to
       * prevent.
       */
      covers={STATUTORY_AUTHORITIES.map((a) => t(`authority_${a}` as never))}
      /** 15e5bd93 (r352) — eight cards with an identical field set, so "3 changed" must say WHICH three. */
      sectionLabels={Object.fromEntries(STATUTORY_AUTHORITIES.map((a) => [a, t(`authority_${a}` as never)]))}
      screenActions={{
        leave: { href: backHref, label: t('statutoryScreenCancel') },
        saveLabel: t('statutoryScreenSave'),
        /**
         * The reporter listed these three by name. `beforeunload` (inside the scope) also covers a closed
         * tab, a reload and a typed address — but a browser's own unload prompt CANNOT carry three
         * buttons and cannot be worded, so that one route offers leave-or-stay only. Said plainly here
         * rather than implied to be ours.
         */
        prompt: {
          title: t('statutoryUnsavedTitle'),
          body: t('statutoryUnsavedBody'),
          cancel: t('statutoryUnsavedCancel'),
          discard: t('statutoryUnsavedDiscard'),
          save: t('statutoryUnsavedSave'),
        },
      }}
    >
      <IdentityCard statutory={statutory} filingCountry={filingCountry} />

      {bankProfiles.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('authoritiesNoBankAccounts')}</p>
      )}

      {STATUTORY_AUTHORITIES.map((a) => (
        <StatutoryBodyCard
          key={a}
          authority={a}
          companyId={companyId}
          filingCountry={filingCountry}
          statutory={statutory}
          row={statutoryAuthorities.find((rr) => rr.authority === a) ?? null}
          bankProfiles={bankProfiles}
          signatories={signatories}
          stateOptions={stateOptions}
          actions={actions}
        />
      ))}
    </TabSaveScope>
  );
}
