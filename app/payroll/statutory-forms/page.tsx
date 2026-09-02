import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { listCompanies } from '@/core/read';
import {
  complianceWorklist,
  cp22MonthCohort,
  listPlannedForms,
  listReports,
  listStatutoryLinks,
  submissionDueFor,
} from '@/core/reporting';
import type { FormOutput, StatutoryBodyKey } from '@/localization/country-pack';
import { Card, ErrorBanner, Field, PageHeader, SectionHeader, btnPrimary, inputCls, pageWideCls } from '@/components/ui';
import { todayInKualaLumpur, yearOptions } from '@/lib/hr-date';
import { payrollProcessBack } from '../back';

/**
 * Payroll → Statutory Forms: the shelf, by the authority you file with (6babf4f6, redesigning 956cec85).
 *
 * THE REQUEST'S PREMISE WAS WRONG, AND THE SCREEN SAID SO BY WHAT IT DID NOT DRAW. The item asked for a
 * redesign on the grounds that "the current module contains the required functionality" — it did not.
 * The pack registered FIVE reports (my.contributions, my.cp39, my.epf, my.socso-eis, my.cp8d) plus the
 * per-employee EA and the CP22/CP22A worklist. Borang BBCB, PERKESO 8B, SIP 2 / 2A, TP3, PCB 2(II),
 * CP21, CP39A and every Other-Statutory report on the reporter's list were NEVER BUILT. A greyed-out row
 * for each would read as broken software rather than as an unbuilt form, so there were none.
 *
 * ⚠️ r224 — THE PARAGRAPH ABOVE IS HISTORY NOW, AND IT IS PAST TENSE BECAUSE THREE OF ITS FACTS EXPIRED
 * WHILE IT STILL READ AS PRESENT. It is kept because it records why the shelves are catalog-driven, and
 * corrected because a reader who trusts it is wrong about the screen in front of them. What has changed:
 *
 *   • The pack now registers EIGHT reports, not five. `my.borang-a` (r217) and `my.borang-8a` (r219)
 *     joined as KWSP's and PERKESO's own contribution forms, and `my.hrd-levy` (r224) joined as the
 *     first entry the Other shelf has ever carried. The header used to name the five and say "the
 *     catalog's five are the five"; the count is deliberately no longer written down, because a number
 *     in prose beside a list is a number that goes stale the next time the list moves.
 *   • The Other shelf is NO LONGER EMPTY. It held a heading, a hint and an empty state over zero
 *     entries, which reads as broken software rather than as an authority nothing is filed with — so
 *     the HRD Corp levy, whose figures every payslip has stamped since Wave 2A, is registered against
 *     `body: 'other'` and appears there. The empty state stays for the shelves and searches that are
 *     genuinely empty, and for a jurisdiction whose pack registers nothing.
 *   • TP1 is BUILT and its card now opens. It was on the shelf marked "not built yet" while the
 *     declaration screen (/payroll/transactions/tp1) and the drawn form (lib/tp1-pdf.ts) had both
 *     shipped — the shelf's one job is to tell the truth about what it can produce, and on that row it
 *     was not. It is a LINK rather than a report for the reason the EA rows are: a TP1 is one person's
 *     declaration for one deduction month, so there is no company-wide table to generate.
 *
 * THE UNBUILT FORMS NAMED ABOVE ARE STILL UNBUILT, minus TP1, and still carry their honest "not built
 * yet" mark: see MY_PLANNED_FORMS, whose type makes an action on one impossible rather than merely
 * unwritten.
 *
 * WHAT WAS ACTUALLY WRONG. The forms were one flat list; nothing said which authority a form belonged to
 * unless you read across to "Submitted to"; and "Open form" took you OFF this screen to the general
 * Reports page, beside a dropdown of every other report and a generation history — so getting to the
 * next form meant starting again. That is what the shelves and the per-form screen fix.
 *
 * STILL GENERATES NOTHING. This page calls `listReports`, `listStatutoryLinks`, `submissionDueFor` and
 * the CP22/CP22A worklist — metadata and lifecycle dates. The figures live one click away on
 * `[formId]`, which calls the SHARED generator. A second generator for the same statutory figures is the
 * duplication 241817ef spent two rounds undoing, and test/statutory-forms-page.test.ts pins that.
 *
 * DRIVEN OFF THE CATALOG, WHICH IS THE SCALABILITY THE REPORTER ASKED FOR. A form appears on a shelf
 * because it declares `submission.body`, not because this file names it. Build the next form, declare
 * its body, and it turns up here with its own deadline and its own buttons — no edit to this screen.
 *
 * ── 587ee719: THE LIST UNDER THE PILLS ──────────────────────────────────────────────────────────────
 *
 * THE ITEM'S PREMISE WAS WRONG A SECOND TIME, IN THE OPPOSITE DIRECTION. It asked for the five category
 * tabs; 6babf4f6 had already shipped them, URL-driven, and they are untouched by this round. The gap was
 * the list beneath: the reporter named nineteen forms and this screen drew six rows, every one carrying
 * the same "Open form" link, with nothing to tell an operator that CP22 comes out on LHDN's own page
 * while the rest hand you our own spreadsheet — or that the other thirteen forms were never built.
 *
 * SO EVERY ENTRY NOW CARRIES A STATUS, AND THE ACTION HAS TO MATCH IT. `official` / `figures` /
 * `draft-file` come off the catalog entry (localization/my/reports.ts); the fourth, "not built yet",
 * belongs to `MY_PLANNED_FORMS`, whose descriptors carry NO href and NO action key, so a planned form
 * cannot render a button however this file is later edited. That type — not a boolean and not this
 * screen's discipline — is what stops the failure the whole item guards against: a button labelled
 * "Borang A" that emits the EPF contributions spreadsheet.
 *
 * STILL NO RENAMES, AND THAT REFUSAL OUTLIVED THE THING IT WAS PROTECTING. The EPF contributions listing
 * is not relabelled "Borang A" and the SOCSO + EIS listing is not relabelled "Borang 8A", because what
 * they produce is not those forms — `my.epf`'s wage column is gross pay where Borang A needs the
 * EPF-liable wage. r224 corrects the second half of this paragraph, which said both names "sit on the
 * same shelf as unbuilt entries instead": they are BUILT (r217 / r219) and sit on the same shelf as
 * SEPARATE, generatable forms beside the listings they were never allowed to rename. The refusal is what
 * made that possible rather than what stood in for it.
 *
 * THE SEARCH BOX IS A `q` SEARCH PARAM ON THE SAME GET FORM, filtered server-side, for the same reason
 * the body pills are links: the view stays in the address, so it survives a refresh and can be sent to
 * somebody. It matches the TRANSLATED name, description and hint, so it works in the viewer's language.
 */

/**
 * The shelves, in the reporter's own order — and the ONE place that order lives.
 *
 * A `Record` keyed by the union rather than an array, deliberately: add a body to `StatutoryBodyKey` and
 * tsc fails HERE until the shelf has a heading, instead of the new authority's forms silently vanishing
 * from a page that renders only the bodies it happens to list.
 */
const BODY_SHELVES: Record<StatutoryBodyKey, true> = { epf: true, perkeso: true, lhdn: true, other: true };
const BODY_ORDER = Object.keys(BODY_SHELVES) as StatutoryBodyKey[];

const STATUS_CLS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};
const WL_STATUS: Record<string, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  due_soon: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  upcoming: 'bg-muted text-muted-foreground',
};

/**
 * 587ee719 — the statuses, their i18n keys and their colours, in ONE place.
 *
 * `planned` is a status this screen adds, not one the catalog can declare: it is what a `PlannedFormDef`
 * renders as, and no generatable entry can ever carry it. The legend at the top of the page and the chip
 * on each card read from the same map, so the two cannot drift.
 *
 * 8ca344bf ADDS `agency-layout`, BETWEEN `official` AND `figures` — and its POSITION in this order is the
 * point, not decoration. The legend is read top to bottom as a ladder of how close a form is to the
 * agency's own document, and Borang 8A sits exactly there: every box where the agency's form puts it, on
 * our paper, because PERKESO publishes no blank page to print onto. Filing it under `figures` would have
 * been the false modesty that makes the ladder useless; filing it under `official` is the false claim the
 * whole vocabulary exists to prevent.
 */
type FormStatus = 'official' | 'agency-layout' | 'figures' | 'draft-file' | 'planned';
const STATUS_ORDER: FormStatus[] = ['official', 'agency-layout', 'figures', 'draft-file', 'planned'];
const FIDELITY_KEY: Record<FormStatus, string> = {
  official: 'fidelity_official',
  'agency-layout': 'fidelity_agency_layout',
  figures: 'fidelity_figures',
  'draft-file': 'fidelity_draft_file',
  planned: 'fidelity_planned',
};
const FIDELITY_HINT_KEY: Record<FormStatus, string> = {
  official: 'fidelity_official_hint',
  'agency-layout': 'fidelity_agency_layout_hint',
  figures: 'fidelity_figures_hint',
  'draft-file': 'fidelity_draft_file_hint',
  planned: 'fidelity_planned_hint',
};
const FIDELITY_CLS: Record<FormStatus, string> = {
  official: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  'agency-layout': 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300',
  figures: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300',
  'draft-file': 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  planned: 'bg-muted text-muted-foreground',
};
const OUTPUT_KEY: Record<FormOutput, string> = {
  pdf: 'output_pdf',
  xlsx: 'output_xlsx',
  csv: 'output_csv',
  print: 'output_print',
  file: 'output_file',
};

/**
 * One card on a shelf, whatever kind of catalog entry produced it. FLAT DATA, assembled on the server:
 * every string is already translated and `action` is a plain href, never a callback — a closure crossing
 * from a server component to a client one 500s on every request while tsc and the suite stay green.
 *
 * `action: null` is how a planned form renders: no href to click, and nothing to accidentally wire up.
 */
type ShelfCard = {
  key: string;
  order: number;
  name: string;
  description: string | null;
  hint: string | null;
  status: FormStatus;
  /** Output chips (PDF / Excel / …) followed by the period chip. */
  chips: string[];
  /** The agency upload file this entry also emits, if any — its own chip, because it is its own claim. */
  draftFile: boolean;
  due: { dueBy: string | null; status: string } | null;
  action: { href: string; label: string } | null;
  /**
   * d3a9383c — the row's second action, when the catalog entry declares one. r220 gives the two EA rows a
   * THIRD (the blank form and the field register beside it), and makes the tooltip optional: not every
   * extra action has a caveat worth a hover, and a shared one would say the wrong thing on some row.
   */
  secondary: ShelfExtraAction | null;
  tertiary: ShelfExtraAction | null;
  /**
   * r242 — the ONE name the row's extra actions sit under, when the catalog entry gives them one.
   *
   * Null ⇒ they render side by side exactly as they did (the CP22 row, with a single extra, needs no
   * name over it). The two EA rows declare one, because three actions at equal weight is how a reporter
   * pressed "Download blank EA form" believing it was the completed one.
   */
  extrasLabel: string | null;
};

type ShelfExtraAction = { href: string; label: string; title: string | null };

/**
 * r242 — a row's extra actions, either side by side (as before) or folded under one named disclosure.
 *
 * A `<details>`, not a menu: it is a server component with no client state to hand across the boundary,
 * it works with no JavaScript, and the two links inside it are the SAME links the row rendered before —
 * this demotes the blank form, it does not take it away.
 */
function ExtraActions({ items, groupLabel }: { items: ShelfExtraAction[]; groupLabel: string | null }) {
  if (items.length === 0) return null;
  const link = (x: ShelfExtraAction, cls: string) => (
    <Link key={x.href} href={x.href} title={x.title ?? undefined} className={cls}>
      {x.label}
    </Link>
  );
  const flat = 'rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent';
  if (!groupLabel) return <>{items.map((x) => link(x, flat))}</>;
  return (
    <details>
      <summary className={`inline-flex cursor-pointer list-none ${flat}`}>{groupLabel}</summary>
      {/* IN FLOW, NOT A FLOATING PANEL. The shelf Card clips its overflow, so an absolutely-positioned
          menu on the last row of a shelf would be cut off — and the blank form would stop being reachable
          for the one row that has it. Opening the fold makes the card taller instead. */}
      <div className="mt-1 flex flex-wrap justify-end gap-2">{items.map((x) => link(x, flat))}</div>
    </details>
  );
}

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** Default to the month just ENDED — the one whose submission is actually open. */
function previousMonth(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export default async function StatutoryFormsPage({
  searchParams,
}: {
  searchParams: Promise<{
    companyId?: string;
    periodKey?: string;
    year?: string;
    month?: string;
    body?: string;
    /** 587ee719 — the search term, filtered server-side so the view stays in the address. */
    q?: string;
    error?: string;
    from?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('payroll.statutoryForms');
  // d3a9383c — the CP22 document's own labels. Its own namespace rather than more keys on this screen's:
  // they describe a FORM, and CP22A will want the same set when it is built.
  const tCp22 = await getTranslations('payroll.cp22');
  const locale = await getLocale();
  // Month NAMES, in the viewer's language, from Intl rather than twelve translated keys per locale —
  // the same `Intl.DateTimeFormat(locale, …)` the roster and scheduled-actions screens use. UTC so a
  // month cannot shift by one in a negative-offset render.
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  const monthName = (mm: string) => monthFmt.format(new Date(Date.UTC(2000, Number(mm) - 1, 1)));
  const sp = await searchParams;
  const companies = (await listCompanies(s)).filter((c) => !c.archivedAt);
  const companyId = sp.companyId || companies[0]?.id || '';
  const today = todayInKualaLumpur();

  // The month is now two selects, but `periodKey` is still ACCEPTED: links to this screen exist in the
  // wild (the nav, bookmarks, the CP22 shelf entry), and a redesign that quietly stops resolving them
  // turns every one of those into the default month without saying so.
  const fallback = /^\d{4}-\d{2}$/.test(sp.periodKey ?? '') ? sp.periodKey! : previousMonth(today);
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year! : fallback.slice(0, 4);
  const month = MONTHS.includes(sp.month as (typeof MONTHS)[number]) ? sp.month! : fallback.slice(5, 7);
  const periodKey = `${year}-${month}`;
  // Six years back plus the current one, and ALWAYS the selected year — a link carrying an older year
  // would otherwise resolve correctly while the select silently displayed a different one.
  const years = yearOptions(today, year);
  const activeBody = BODY_ORDER.includes(sp.body as StatutoryBodyKey) ? (sp.body as StatutoryBodyKey) : null;
  // 587ee719 — the search term. Capped and lower-cased once; it is only ever compared against strings we
  // rendered ourselves, never interpolated into a query or a route.
  const q = (sp.q ?? '').trim().slice(0, 80);
  const needle = q.toLocaleLowerCase(locale);

  // Only the pack entries that ARE submissions. The monthly contributions overview has no `submission`
  // and is correctly absent here: it is an internal reconciliation view, not a form anybody files.
  const all = companyId ? await listReports(s, companyId) : [];
  const submissions = all.filter((r) => r.submission != null);
  const links = companyId ? await listStatutoryLinks(s, companyId) : [];
  // 587ee719 — the forms this jurisdiction has that we have NOT built. Descriptors with no href and no
  // action key, so they can be named but never actioned. See MY_PLANNED_FORMS.
  const planned = companyId ? await listPlannedForms(s, companyId) : [];
  const worklist = companyId ? await complianceWorklist(s, { companyId }) : [];
  const companyName = companies.find((c) => c.id === companyId)?.name ?? '—';
  // db46d9a2 — the month cohort, driven by the SAME two selects at the top of this screen. Null for a
  // company whose jurisdiction no pack owns: CP22 is an LHDN form, and the honest answer there is no card
  // at all, not "nobody started in July". The 60-day worklist below is untouched — it is the deadline
  // alarm, this is the month view, and widening the worklist's window would have made its statuses lie.
  const cohort = companyId ? await cp22MonthCohort(s, { companyId, periodKey }) : null;
  // Named BEFORE the download, not discovered after it: whose page will come out with a gap in it.
  const cohortGaps = (cohort?.rows ?? []).filter((r) => !r.hasIdentityNo || !r.hasTaxNo);
  // The heading names the month explicitly, because the control above it is labelled "Payroll month" and
  // this list is a HIRE month. Same Intl month name the selects use, so the two always agree.
  const cohortMonthLabel = `${monthName(month)} ${year}`;

  // `q` rides in the address beside company/year/month, so the body pills below preserve a search and a
  // searched view can be sent to somebody. Appended rather than always present: an empty `?q=` in every
  // pill link is noise in the bar and in the browser history.
  const qs =
    `companyId=${encodeURIComponent(companyId)}&year=${year}&month=${month}` +
    (q ? `&q=${encodeURIComponent(q)}` : '');
  const formHref = (reportId: string, kind: 'month' | 'year' | 'event') =>
    kind === 'year'
      ? `/payroll/statutory-forms/${encodeURIComponent(reportId)}?companyId=${encodeURIComponent(companyId)}&year=${year}`
      : `/payroll/statutory-forms/${encodeURIComponent(reportId)}?${qs}`;
  const linkHref = (href: string) =>
    href.replace('{companyId}', encodeURIComponent(companyId)).replace('{year}', year);
  /**
   * r220 — one extra action on a row, built from the catalog entry and nothing else.
   *
   * Both halves are read TOGETHER: an href without a label would render a button with no words on it, and
   * a label without an href would render words that do nothing, so either alone renders neither. That was
   * d3a9383c's rule for the second action and it is now the rule for both.
   *
   * `fallbackTitle` exists for exactly one row — the blank CP22, whose tooltip lives in `payroll.cp22`
   * beside the form it describes rather than in this screen's namespace.
   */
  const extraAction = (
    href: string | undefined,
    labelKey: string | undefined,
    titleKey: string | undefined,
    fallbackTitle: string | null,
  ): ShelfExtraAction | null =>
    href && labelKey
      ? {
          href: linkHref(href),
          label: t(labelKey as 'link_cp22_blank'),
          title: titleKey ? t(titleKey as 'link_cp22_blank') : fallbackTitle,
        }
      : null;

  // ── 587ee719: one shelf's cards, from three catalog collections, in the reporter's own order ───────
  //
  // The three sources answer three different questions — "what can this pack generate", "what can it
  // open", "what does it not have yet" — and they are deliberately still three types. They meet HERE, at
  // the last possible moment, flattened to the same card shape so the screen renders one list. The
  // planned entries lose nothing on the way in because there was nothing to lose: `action: null` is not
  // a decision this function makes, it is the only thing a `PlannedFormDef` can produce.
  const periodChip = (cadence: 'monthly' | 'annual' | 'event', concrete: boolean): string =>
    cadence === 'event'
      ? t('cadence_event')
      : cadence === 'annual'
        ? concrete
          ? t('chipYear', { period: year })
          : t('cadence_annual')
        : concrete
          ? t('chipMonth', { period: `${monthName(month)} ${year}` })
          : t('cadence_monthly');
  const outputChips = (outputs: readonly FormOutput[] | null | undefined): string[] =>
    (outputs ?? []).filter((o) => o !== 'file').map((o) => t(OUTPUT_KEY[o] as 'output_pdf'));

  const shelves = BODY_ORDER.filter((b) => activeBody == null || b === activeBody).map((body) => {
    const cards: ShelfCard[] = [];

    for (const r of submissions.filter((r) => r.submission!.body === body)) {
      const annual = r.periodKind === 'year';
      // `submissionDueFor` only models a monthly deadline (day N of the month AFTER the period), so a
      // YEAR period correctly comes back "unknown" — which is the honest answer for the annual Form E,
      // whose real statutory date was never stated to us. An invented deadline is worse than an absent
      // one: somebody files against it.
      const due = submissionDueFor(annual ? year : periodKey, r.submission!.dueDayOfNextMonth, today);
      cards.push({
        key: r.id,
        order: r.shelfOrder ?? 999,
        name: r.label,
        description: r.descriptionKey ? t(r.descriptionKey as 'desc_cp39') : null,
        hint: null,
        // A report without a declared fidelity falls back to `figures`, which is what every report on
        // this screen has always actually been — never `official`, which has to be earned.
        status: r.fidelity ?? 'figures',
        chips: [...outputChips(r.outputs), periodChip(r.cadence, true)],
        draftFile: (r.outputs ?? []).includes('file'),
        due,
        action: { href: formHref(r.id, r.periodKind), label: t('openForm') },
        secondary: null,
        tertiary: null,
        extrasLabel: null,
      });
    }

    for (const l of links.filter((l) => l.body === body)) {
      cards.push({
        key: l.id,
        order: l.shelfOrder ?? 999,
        name: t(l.labelKey as 'link_cp22'),
        description: l.descriptionKey ? t(l.descriptionKey as 'desc_cp22') : null,
        hint: t(l.hintKey as 'link_cp22_hint'),
        status: l.fidelity ?? 'figures',
        chips: [...outputChips(l.outputs), periodChip(l.cadence, true)],
        draftFile: (l.outputs ?? []).includes('file'),
        due: null,
        // The row's OWN action wording when it declares one — the CP22 entry scrolls to the worklist, it
        // does not open a form; `my.tp1` opens an employee list. Everything else falls back to the shared
        // label, which is why rewording either one never touches the other.
        //
        // r242 — the two EA entries now name `openForm` explicitly, which is the SHARED label they would
        // have fallen back to. Naming it is the point: the row that reads "Open form" is the row that ends
        // at a completed EA, and that decision belongs in the catalog beside the href it describes.
        action: { href: linkHref(l.href), label: t((l.actionLabelKey ?? 'openForm') as 'openForm') },
        // d3a9383c — a second action, when the catalog entry declares one (the blank fillable CP22; r220
        // added the blank C.P.8A to both EA rows). Rendered from the SAME data as the action beside it.
        //
        // r220 — THE TOOLTIP IS THE ENTRY'S OWN WHEN IT NAMES ONE. d3a9383c took it from `payroll.cp22`
        // because the sentence describes a FORM rather than this screen, and that is still true of the
        // CP22's — so an entry that declares no key still gets exactly that string, and the CP22 row is
        // unchanged. The blank C.P.8A's caveat is not the blank CP22's, and a screen that mapped ids to
        // namespaces would be the screen naming forms again, which is what the catalog exists to prevent.
        secondary: extraAction(l.secondaryHref, l.secondaryLabelKey, l.secondaryTitleKey, tCp22('blankTitle')),
        // r220 — the third: the EA field register, offered beside the blank form because a blank page you
        // cannot check box by box is only half of what was asked for.
        tertiary: extraAction(l.tertiaryHref, l.tertiaryLabelKey, l.tertiaryTitleKey, null),
        // r242 — and the ONE name those two now sit under on the EA rows. Read off the catalog like every
        // other string here; a row that declares no key renders its extras exactly as it did.
        extrasLabel: l.extrasLabelKey ? t(l.extrasLabelKey as 'link_ea_more') : null,
      });
    }

    for (const p of planned.filter((p) => p.body === body)) {
      cards.push({
        key: p.id,
        order: p.shelfOrder ?? 999,
        name: t(p.labelKey as 'link_cp22'),
        description: null,
        hint: t(p.hintKey as 'link_cp22_hint'),
        status: 'planned',
        // No period chip with a concrete month or year: an unbuilt form covers no period yet, and
        // "August 2026" beside it would read as an offer.
        chips: [periodChip(p.cadence, false)],
        draftFile: false,
        due: null,
        action: null,
        secondary: null,
        tertiary: null,
        extrasLabel: null,
      });
    }

    cards.sort((a, b) => a.order - b.order);
    const matching = needle
      ? cards.filter((c) =>
          [c.name, c.description, c.hint].some((x) => x && x.toLocaleLowerCase(locale).includes(needle)),
        )
      : cards;
    return {
      body,
      cards: matching,
      /** Before the search, so the heading counts the shelf and not the query. */
      total: cards.length,
      ready: cards.filter((c) => c.status !== 'planned').length,
    };
  });

  return (
    // c002b3c3 — the reporter's "the page layout does not fully utilize the available screen width",
    // answered. 152fea7f then moved the whole Payroll module off the old centred `max-w-[100rem]` cap
    // onto `pageWideCls`, the true full-browser-width container, so this screen follows it.
    <div className={pageWideCls}>
      <PageHeader back={await payrollProcessBack(sp.from)} title={t('pageTitle')} description={t('pageDescription')} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 py-4">
          {activeBody && <input type="hidden" name="body" value={activeBody} />}
          <Field label={t('company')}>
            <select name="companyId" defaultValue={companyId} className={inputCls}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('year')}>
            <select name="year" defaultValue={year} className={inputCls}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('month')}>
            <select name="month" defaultValue={month} className={inputCls}>
              {MONTHS.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </Field>
          {/* 587ee719 — the search box, on the SAME GET form as company/year/month so one Show applies
              every filter at once and the whole view lands in the address. A client-side filter would
              have made the searched view unshareable and unrefreshable, which is the exact thing the
              body pills below were built to avoid. */}
          <Field label={t('search')} className="w-full sm:w-72">
            <input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={80}
              placeholder={t('searchPlaceholder')}
              className={inputCls}
            />
          </Field>
          <button className="h-9 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent">
            {t('show')}
          </button>
          {q && (
            <Link
              href={`/payroll/statutory-forms?companyId=${encodeURIComponent(companyId)}&year=${year}&month=${month}${
                activeBody ? `&body=${activeBody}` : ''
              }`}
              className="h-9 rounded-md px-2 text-sm leading-9 text-muted-foreground hover:text-foreground"
            >
              {t('searchClear')}
            </Link>
          )}
        </form>
      </Card>

      {/* Plain links, not a client filter: the chosen shelf is then in the address, so it survives a
          refresh and can be sent to somebody. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('selectBody')}</span>
        <Link
          href={`/payroll/statutory-forms?${qs}`}
          className={`rounded-full border px-3 py-1 text-sm ${
            activeBody == null ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent'
          }`}
        >
          {t('allBodies')}
        </Link>
        {BODY_ORDER.map((b) => (
          <Link
            key={b}
            href={`/payroll/statutory-forms?${qs}&body=${b}`}
            className={`rounded-full border px-3 py-1 text-sm ${
              activeBody === b ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border hover:bg-accent'
            }`}
          >
            {t(`body_${b}` as 'body_epf')}
          </Link>
        ))}
      </div>

      {companyId && all.length === 0 && (
        <Card>
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noneForCountry')}</p>
        </Card>
      )}

      {/* 587ee719 — THE LEGEND, above the list rather than in a tooltip. Four statuses is three more than
          this screen had, and a chip nobody can decode is worse than no chip: the whole point of the
          status is that an operator can tell at a glance whether what they are about to download is a
          government form or our own working statement. */}
      {companyId && all.length > 0 && (
        <Card className="overflow-hidden">
          <SectionHeader title={t('legendTitle')} />
          <dl className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-2">
            {STATUS_ORDER.map((st) => (
              <div key={st} className="flex flex-wrap items-baseline gap-2">
                <dt
                  className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${FIDELITY_CLS[st]}`}
                >
                  {t(FIDELITY_KEY[st] as 'fidelity_official')}
                </dt>
                <dd className="min-w-0 flex-1 text-muted-foreground">
                  {t(FIDELITY_HINT_KEY[st] as 'fidelity_official_hint')}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      {shelves.map(({ body, cards, total, ready }) => (
        <Card key={body} className="overflow-hidden">
          <SectionHeader title={t(`body_${body}` as 'body_epf')} count={total} />
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t(`body_${body}_hint` as 'body_epf_hint')}
            {total > 0 && <span className="ml-2">· {t('shelfReady', { ready, total })}</span>}
          </p>

          {total === 0 ? (
            /* An honest empty shelf beats a row that opens nothing. Nothing is filed with this body yet;
               when a form for it is built it declares its body and appears here on its own. */
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('shelfEmpty')}</p>
          ) : cards.length === 0 ? (
            /* Searched, and this shelf holds nothing matching. Distinct from `shelfEmpty` on purpose:
               "nothing is filed here" and "nothing here matches what you typed" are different facts. */
            <p className="px-4 py-6 text-sm text-muted-foreground">{t('searchNoMatch')}</p>
          ) : (
            <ul className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-3">
              {cards.map((c) => (
                <li
                  key={c.key}
                  className={`flex flex-col gap-2 bg-card p-4 text-sm ${c.action ? '' : 'bg-muted/30'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className={`min-w-0 font-medium ${c.action ? '' : 'text-muted-foreground'}`}>{c.name}</div>
                    <span
                      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${FIDELITY_CLS[c.status]}`}
                    >
                      {t(FIDELITY_KEY[c.status] as 'fidelity_official')}
                    </span>
                  </div>

                  {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                  {/* The hint the earlier rounds settled — the CP22 "what you download here is what you
                      key in" notice, and the EA's language note. Kept beside the description rather than
                      replaced by it: they say different things and both are load-bearing. */}
                  {c.hint && <p className="text-xs text-muted-foreground">{c.hint}</p>}

                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t(`body_${body}` as 'body_epf')}
                    </span>
                    {c.chips.map((chip) => (
                      <span
                        key={chip}
                        className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {chip}
                      </span>
                    ))}
                    {/* The agency upload file is its own claim and gets its own chip: the figures beside
                        it are complete, the FILE has never been accepted by the portal it is built for. */}
                    {c.draftFile && (
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-[11px] font-medium ${FIDELITY_CLS['draft-file']}`}
                      >
                        {t('fidelity_draft_file')}
                      </span>
                    )}
                  </div>

                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {c.due?.dueBy && (
                        <span className="font-mono text-xs text-muted-foreground">
                          {t('dueByShort', { date: c.due.dueBy })}
                        </span>
                      )}
                      {c.due && (
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLS[c.due.status]}`}
                        >
                          {t(`status_${c.due.status}` as 'status_upcoming')}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {/* d3a9383c's second action and r220's third, rendered from the same shape so a row
                          with two extras cannot look like two different kinds of control. r242 folds them
                          under one name when the entry asks for it — same links, one less thing on the row
                          that can be mistaken for the route to a completed form. */}
                      <ExtraActions
                        items={[c.secondary, c.tertiary].filter((x): x is ShelfExtraAction => x !== null)}
                        groupLabel={c.extrasLabel}
                      />
                      {/* NO ACTION ELEMENT AT ALL for a form that was never built — not a disabled button,
                          which is still a button and still gets clicked at. A plain sentence, and nothing
                          to press. `c.action` is null for exactly one reason: the entry came from a
                          `PlannedFormDef`, which has no href to render. */}
                      {c.action ? (
                        <Link href={c.action.href} className="text-primary hover:underline">
                          {c.action.label}
                        </Link>
                      ) : (
                        <span className="text-xs italic text-muted-foreground">{t('noAction')}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      {/* db46d9a2 — THE MONTH VIEW. The Company and Payroll-month selects at the top of this screen already
          existed and already drove everything except CP22; now they drive this card too, so ANY month is
          reachable — July 2026, March 2026, a month two years back — rather than only the last 60 days.

          NO NEW PICKERS AND NO CLIENT STATE: it reads the same `companyId` / `year` / `month` search params
          the filter bar writes, so the list is addressable and can be sent to somebody.

          THE DOWNLOAD FORM IS A SIBLING OF THE FILTER FORM, NEVER NESTED INSIDE IT. A form inside a form is
          invalid HTML and browsers drop the inner one, which would silently turn the download button into a
          second "Show". It carries its own hidden companyId/year/month for the same reason. */}
      {cohort && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
            <div className="text-sm font-medium">
              {tCp22('monthTitle', { month: cohortMonthLabel })}
              <span className="ml-2 text-muted-foreground">({cohort.rows.length})</span>
            </div>
            {/* A month with nobody in it offers NO download button — an empty file is not a useful
                answer, and the route 404s on it. The card still says which month was asked for, so the
                operator knows the answer came back rather than the screen failing. */}
            {cohort.rows.length > 0 && (
              <form method="get" action="/payroll/cp22/batch" className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="companyId" value={companyId} />
                <input type="hidden" name="year" value={year} />
                <input type="hidden" name="month" value={month} />
                {/* 88076362 — THE BRANCH BOX IS GONE FROM HERE, and removing it is the honest move.
                    It existed to stamp box 1 of the 2020 page's "Kepada / To" block; CP22 [Pin.1/2021]
                    has no such block, so anything typed here would be silently discarded — a field that
                    does nothing is worse than no field. The branch now lives on the per-joiner review
                    screen and in its text export, which say plainly that it does not print. */}
                <button className={btnPrimary} title={tCp22('downloadAllTitle')}>
                  {tCp22('downloadAll')}
                </button>
              </form>
            )}
          </div>

          {cohort.rows.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm font-medium">{tCp22('monthEmpty', { month: cohortMonthLabel })}</p>
              <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
                {tCp22('monthEmptyHint', { company: companyName })}
              </p>
            </div>
          ) : (
            <>
              {/* THE CORRECTION WE OWE THE READER, and it sits beside the button rather than in a tooltip.
                  Since 1 September 2024 a CP22 goes through e-CP22 on MyTax; posted and hand-delivered
                  forms are not accepted. Nothing on this screen is labelled "for submission". */}
              <div className="mx-4 mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                <span className="font-medium">{tCp22('notFilingTitle')}</span>{' '}
                <span className="text-muted-foreground">{tCp22('notFiling')}</span>
              </div>

              {/* Before the download, not after it. `readinessTitle` is the SAME key the per-form screens
                  use for the same sentence — one wording for "these people are missing identifiers". */}
              {(cohortGaps.length > 0 || !cohort.employerNoOnFile) && (
                <div className="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  {cohortGaps.length > 0 && (
                    <p className="font-medium">{t('readinessTitle', { count: cohortGaps.length })}</p>
                  )}
                  <ul className="mt-1 space-y-0.5">
                    {cohortGaps.map((r) => (
                      <li key={r.employmentId}>
                        <span className="font-medium">{r.name}</span> —{' '}
                        {[
                          !r.hasTaxNo ? tCp22('missingTaxNo') : null,
                          !r.hasIdentityNo ? tCp22('missingIdentityNo') : null,
                        ]
                          .filter(Boolean)
                          .join(', ')}
                      </li>
                    ))}
                    {/* One row per company, so its absence gaps box 3 on every page at once. */}
                    {!cohort.employerNoOnFile && <li>{tCp22('missingEmployerNo', { company: companyName })}</li>}
                  </ul>
                </div>
              )}

              <p className="px-4 pt-3 text-xs text-muted-foreground">{tCp22('monthHint')}</p>

              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                      <th className="px-4 py-2 font-medium">{tCp22('colHireDate')}</th>
                      <th className="px-4 py-2 font-medium">
                        <span className="sr-only">{tCp22('columnHeading')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {cohort.rows.map((r) => (
                      <tr key={r.employmentId}>
                        <td className="px-4 py-2.5 font-medium">{r.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{r.hiredOn}</td>
                        <td className="px-4 py-2.5 text-right">
                          {/* The single-person REVIEW screen — the same link the worklist offers. */}
                          <Link
                            href={`/payroll/cp22/${r.employmentId}/preview`}
                            title={tCp22('reviewLinkTitle')}
                            className="inline-flex rounded-md border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-accent"
                          >
                            {tCp22('reviewLink')}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}

      {/* CP22 / CP22A live HERE now, not on Reports: they are LHDN statutory notices, and this is where
          somebody looking for a statutory form goes. Driven by the hire/termination lifecycle rather than
          a payroll period, which is why they are a worklist and not a form you pick a month for. */}
      <Card id="worklist" data-tour="payroll-worklist" className="scroll-mt-6 overflow-hidden">
        <SectionHeader title={t('worklistTitle')} count={worklist.length} />
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          {t('worklistDescription', { company: companyName })}
        </p>
        {worklist.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('worklistEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('colEmployee')}</th>
                  <th className="px-4 py-2 font-medium">{t('colForm')}</th>
                  <th className="px-4 py-2 font-medium">{t('colReason')}</th>
                  <th className="px-4 py-2 font-medium">{t('colEventDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('colNotifyBy')}</th>
                  <th className="px-4 py-2 font-medium">{t('colStatus')}</th>
                  {/* d3a9383c — the document itself. Headed for screen readers only: the mockup the
                      reporter approved shows the buttons under no visible heading. */}
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">{tCp22('columnHeading')}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {worklist.map((w) => (
                  <tr key={`${w.employmentId}-${w.form}`}>
                    <td className="px-4 py-2.5 font-medium">{w.name}</td>
                    <td className="px-4 py-2.5">{w.form}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{w.reason}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{w.eventDate}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{w.dueBy}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${WL_STATUS[w.status]}`}
                      >
                        {t(`status_${w.status}` as 'status_upcoming')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {/* CP22 ONLY. The CP22A leaver notice is a later round and this row says so plainly
                          rather than offering a button that would download the wrong form. */}
                      {w.form === 'CP22' ? (
                        /* 88076362 — the REVIEW screen, not the download. The reporter's whole complaint
                           was that pressing this produced a finished form with nowhere to check it
                           first; the download is one press further on, from a screen that shows every
                           box. The `/pdf` route is unchanged and still works on its own. */
                        <Link
                          href={`/payroll/cp22/${w.employmentId}/preview`}
                          title={tCp22('reviewLinkTitle')}
                          className="inline-flex rounded-md border border-border px-2.5 py-1 text-xs font-medium text-primary hover:bg-accent"
                        >
                          {tCp22('reviewLink')}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground" title={tCp22('cp22aNotYet')}>
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
