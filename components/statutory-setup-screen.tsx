'use client';

/**
 * ═══ 15e5bd93 REVISION 3 (r355) — STATUTORY PAYMENT SETUP: IDENTITY ON TOP, ONE ROW PER BODY ════════
 *
 * ⚠️ THIRD SHAPE, FIRST ONE THE REPORTER DREW. r352 built a rail plus a workspace INSIDE the company
 * panel's Statutory tab; contested. r353 built this dedicated screen with EIGHT ALWAYS-VISIBLE CARDS, each
 * read-only until its own Edit was pressed; contested again. The reporter then drew the layout in the
 * ticket themselves, as an ASCII sketch, and the approved plan says in so many words: "We are not
 * interpreting it again." The sketch, transcribed, is docs/mockups/15e5bd93-statutory-rows-r3.html.
 *
 * WHAT IT ASKS FOR, AND WHERE EACH PART IS:
 *
 *   1. Statutory Identity (MY) at the TOP, carrying the company's SSM number and MyInvois TIN AND the four
 *      filing identifiers — EPF employer no., SOCSO employer code, LHDN E number, HRDF status — "so you can
 *      confirm whose configuration you are about to edit before you touch anything"   →  `IdentityCard`
 *   2. The eight bodies as a plain TABLE: Statutory | Payment Setup | Status | Action. One line each. No
 *      fields, no forms, nothing expanded.                                            →  the `<table>`
 *   3. SOCSO and EIS stay two rows, EIS indented under SOCSO                           →  `subordinate`
 *   4. View and Edit open a screen for that one body alone
 *      →  app/admin/organization/[companyId]/statutory/[authority]/page.tsx + components/statutory-body-screen.tsx
 *
 * ── WHAT r353 SHIPPED HERE AND WHAT HAPPENED TO IT ────────────────────────────────────────────────
 * `StatutoryBodyCard` — the read-only `<dl>`, the edit `<form>`, the thirteen posted names, the
 * `filingCountry` flag, the signatory tolerance, the Clear button — was MOVED WHOLE to
 * components/statutory-body-screen.tsx, not rewritten and not dropped. What went with the eight cards, and
 * only because the mechanism it served no longer exists:
 *
 *   · the `editing: string | null` state, the `locked` prop and the disabled Edit buttons. All three
 *     existed to stop one card's Edit unmounting another card's dirty form. There is at most ONE form in
 *     this flow now and it is on its own route, so there is no second form to discard.
 *   · `statutoryScreenEditingHint` and `authorityEditing`, which explained that lock. RETIRED, not deleted
 *     from the catalogues — the way `authorityOpen`, `authorityClose`, `tabOther` and `tabBankAccount` each
 *     were, and two of those four have already come back.
 *   · `STATUTORY_AUTHORITIES.filter((a) => !(perkesoGroup && a === 'eis'))` and the `cardFor('eis', true)`
 *     re-draw. That filter existed ONLY because the cards were laid out in a TWO-COLUMN GRID, where the
 *     third card lands under the first rather than under SOCSO, so EIS had to be pulled out and re-drawn
 *     inside SOCSO's cell. A table is one column of rows and `STATUTORY_AUTHORITIES` already orders EIS
 *     immediately after SOCSO, so the whole controlled set maps straight through with NOTHING excluded —
 *     which is strictly safer than the filter it replaces, because a filter over the controlled set is the
 *     one shape that can silently drop a body.
 *
 * ── THE TWO STATUS COLUMNS ARE TWO FACTS, AND THE PLAN PROMISED THE REPORTER THAT PRECISELY ───────
 * Their sketch has both columns, so both are drawn, and `statutoryRowStatus` in
 * lib/statutory-authority-display.ts is the ONE place either is derived:
 *
 *     Payment Setup  =  a `company_statutory_authority` row exists for that body
 *     Status         =  it is actually contributing
 *
 * For seven bodies these coincide and the plan says so to the reporter in plain words. For HRD Corp they
 * genuinely differ — `hrdf_status` is not_registered | mandatory | optional — so "Configured + Inactive" is
 * a real, reachable state. NO ENABLE/DISABLE SWITCH WAS INVENTED to make the column more interesting than
 * the data (CLAUDE.md §8: a shared caption may say only what is true of every member and checkable from
 * this repo). See the derivation's own header for the payroll lines that make the HRDF half checkable.
 *
 * ── THE IDENTITY CARD IS READ-ONLY HERE. THE DECISION, STATED ─────────────────────────────────────
 * The four filing identifiers live on `company_statutory_my`, not on `company_statutory_authority`, and
 * they are EDITED inside each body's editor through `MY_FILING_FIELD` (r226). This card PRINTS them and
 * holds no input at all. Editable in two places would be two doors onto one column, and whichever was
 * saved second would win — which is the fault MY_FILING_FIELD was built to prevent. One owner, one editor,
 * one read-only view.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { STATUTORY_AUTHORITIES } from '@/lib/statutory-authorities';
import { MY_FILING_FIELD, statutoryRowStatus } from '@/lib/statutory-authority-display';
import { tableWrapCls, tbodyCls, theadCls, thCls } from './ui';
import type { PanelBankProfile, PanelStatutory, PanelStatutoryAuthority } from './company-panel';

const badge = {
  emerald:
    'rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  // 3783fd87 — a LINED chip, not a filled grey one: on a white card a grey fill is the thing the reporter
  // asked us to take out, and a border carries the same boundary.
  muted:
    'rounded-full border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
};

/**
 * STATUTORY IDENTITY (MY), AT THE TOP, READ-ONLY — the first thing the reporter's sketch asks for.
 *
 * Six facts in their sketch's own order: SSM registration no., MyInvois TIN, then the three filing numbers
 * and HRD Corp's band. The three filing numbers are read out of `MY_FILING_FIELD` rather than spelled out
 * here, so this card and the per-body editors can never disagree about which number belongs to which body
 * or what it is called — the r226 fault in miniature.
 *
 * ⚠️ AN ABSENT VALUE SAYS "Not set" AND NEVER GUESSES. HRD Corp's band is printed only when the identity
 * row actually carries one: payroll resolves a MISSING row to 'not_registered' and charges nothing
 * (core/payroll.ts), but printing "No Contribution" for a company with no row at all would assert a
 * registration decision nobody made (§8 — an absent box asserts nothing). That is why the Status column and
 * this caption read differently for a company with no identity row: the column states what payroll WILL DO
 * (charge nothing), the caption states what the company HAS DECIDED (nothing on file).
 *
 * ⚠️ SSM AND MyInvois ARE STILL EDITED ON THE COMPANY PANEL'S STATUTORY TAB and nowhere else. Neither is a
 * body an employer pays a contribution to, neither is in STATUTORY_AUTHORITIES, and the SSM number is read
 * by two statutory files we produce (localization/my/borang-8a.ts, localization/my/socso-eis-file.ts) — so
 * it keeps one editor and one owner. They are printed here because the reporter asked to be able to CHECK
 * them without going back, which is what printing them does.
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
    <section data-statutory-identity className="rounded-lg border border-border bg-card p-3">
      <p className="text-sm font-semibold text-foreground">{t('statutoryIdentityMY')}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t('statutoryIdentityHint')}</p>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col">
            <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{f.label}</dt>
            <dd
              className={cn(
                'truncate text-xs tabular-nums',
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
 * ONE STATUTORY BODY, AS ONE ROW OF THE TABLE. Four cells, exactly the reporter's four columns.
 *
 * NO FIELD AND NO FORM. Every writer in this flow is on the per-body route; this row renders text and two
 * LINKS. That is the whole of what the reporter contested twice — r352 put the fields in the tab and r353
 * put them behind eight Edit buttons on this screen, and both times the answer was "one line each".
 */
function StatutoryBodyTableRow({
  authority,
  row,
  statutory,
  subordinate = false,
  bodyHref,
}: {
  authority: string;
  row: PanelStatutoryAuthority | null;
  /** The company's statutory IDENTITY row — the HRD Corp band the Status cell reads for that one body. */
  statutory: PanelStatutory;
  /**
   * efe424b0 / the sketch's own indent — draw this body as part of the group ABOVE it. Only EIS under
   * SOCSO today.
   *
   * A presentation flag and nothing else. The body keeps its own record, its own `authority` value and its
   * own screen — which is the point, because EIS's payment account genuinely differs from SOCSO's on this
   * tenant (see the consolidation note in lib/statutory-authority-display.ts).
   */
  subordinate?: boolean;
  bodyHref: string;
}) {
  const t = useTranslations('admin.organization');
  const { configured, contributing } = statutoryRowStatus(authority, !!row, statutory?.hrdfStatus ?? null);

  return (
    <tr data-statutory-row={authority}>
      <td className="px-3 py-2">
        <div className={cn('min-w-0', subordinate && 'pl-6')}>
          {/* Dynamic message keys (`authority_epf` / `authorityDesc_epf`, …) — one pair per entry in
              STATUTORY_AUTHORITIES, present in all six locales. The `as never` cast is the repo's existing
              convention for a computed key. NOTE: the i18n-coverage test cannot see dynamic keys, so adding
              an authority means adding BOTH its label and its description to all six locales by hand
              (test/company-panel-bank-statutory-layout.test.ts checks that they exist). */}
          <span className="block truncate text-sm font-medium">{t(`authority_${authority}` as never)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {t(`authorityDesc_${authority}` as never)}
          </span>
        </div>
      </td>
      <td className="px-3 py-2">
        <span className={configured ? badge.emerald : badge.muted} data-statutory-payment-setup>
          {configured ? t('authorityConfigured') : t('authorityNotConfigured')}
        </span>
      </td>
      <td className="px-3 py-2">
        <span className={contributing ? badge.emerald : badge.muted} data-statutory-status>
          {contributing ? t('authorityStatusActive') : t('authorityStatusInactive')}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <Link
          href={`${bodyHref}?mode=view`}
          className="text-xs font-medium text-primary hover:underline"
          data-statutory-view-link={authority}
        >
          {t('authorityView')}
        </Link>
        <Link
          href={`${bodyHref}?mode=edit`}
          className="ml-3 text-xs font-medium text-primary hover:underline"
          data-statutory-edit-link={authority}
        >
          {t('authorityEdit')}
        </Link>
      </td>
    </tr>
  );
}

/**
 * THE LIST. The identity card, then one row per supported body.
 *
 * ⚠️ NOTHING IS FILTERED OUT AND NOTHING IS SLICED. The rows run over `STATUTORY_AUTHORITIES` itself, in
 * the controlled set's own order — which is also the order the company panel's read-only list uses, so a
 * body cannot appear on one screen and vanish from the other. EIS is indented rather than pulled out,
 * because in a table its place in the set already puts it directly beneath SOCSO.
 *
 * ⚠️ THIS SCREEN TAKES NO `actions` PROP AND THAT IS DELIBERATE. It cannot write, so there is nothing to
 * wire; the two authority writers are passed to the per-body route instead. A screen that holds a server
 * action it never submits is how the next round re-adds half a feature.
 */
export function StatutorySetupScreen({
  companyId,
  filingCountry,
  statutory,
  statutoryAuthorities = [],
  bankProfiles = [],
}: {
  companyId: string;
  filingCountry: string;
  statutory: PanelStatutory;
  statutoryAuthorities?: PanelStatutoryAuthority[];
  /**
   * Only for the "no bank account to pay from" warning. The row itself does not name the paying account:
   * the sketch's four columns do not include it, and it is on the body's own screen and on the company
   * panel's Statutory tab list, which is where 3783fd87's "read what is set without opening anything"
   * promise lives.
   */
  bankProfiles?: PanelBankProfile[];
}) {
  const t = useTranslations('admin.organization');
  const perkesoGroup = filingCountry === 'MY';

  return (
    <div className="space-y-3">
      <IdentityCard statutory={statutory} filingCountry={filingCountry} />

      <p className="text-sm font-semibold text-foreground">{t('authoritiesTitle')}</p>
      <p className="text-xs text-muted-foreground">{t('authoritiesHint')}</p>
      {bankProfiles.length === 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('authoritiesNoBankAccounts')}</p>
      )}

      <div className={tableWrapCls}>
        <table className="w-full text-sm">
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>{t('statutoryColBody')}</th>
              <th className={thCls}>{t('statutoryColPaymentSetup')}</th>
              <th className={thCls}>{t('statutoryColStatus')}</th>
              <th className={cn(thCls, 'text-right')}>{t('statutoryColAction')}</th>
            </tr>
          </thead>
          <tbody className={tbodyCls}>
            {STATUTORY_AUTHORITIES.map((a) => (
              <StatutoryBodyTableRow
                key={a}
                authority={a}
                row={statutoryAuthorities.find((r) => r.authority === a) ?? null}
                statutory={statutory}
                subordinate={perkesoGroup && a === 'eis'}
                bodyHref={`/admin/organization/${companyId}/statutory/${a}`}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
