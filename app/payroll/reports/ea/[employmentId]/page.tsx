import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { employeeEaCompanies, employeeEaStatement } from '@/core/reporting';
import { isAdmin, canManagePayroll } from '@/lib/authz';
import { Card } from '@/components/ui';
import { eaReadiness, type EaBoxCaption } from '@/lib/ea-readiness';
import { PrintButton } from '@/components/print-button';
import { ToastFromQuery } from '@/components/ui/toast-trigger';
import { EaAmendPanel, type AmendField } from './ea-amend-panel';

/**
 * A box caption, as a fragment of a SENTENCE rather than as a row label.
 *
 * The captions are the form's own — "1. Full name of employee / pensioner (Mr/Ms/Mrs)" — so joining them
 * raw into the footnote produced a leading box number mid-sentence and, on the last one, "…7. PERKESO
 * no.." with two full stops. Strips the leading "<n>. " and any trailing period; changes no caption
 * anywhere else, because the row labels still render the full form wording.
 */
const trimBoxCaption = (s: string) => s.replace(/^\s*\d+\.\s*/, '').replace(/\.\s*$/, '');

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Row({
  label,
  value,
  muted,
  amended,
  amendedLabel,
}: {
  label: string;
  value: React.ReactNode;
  muted?: boolean;
  amended?: boolean;
  amendedLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={`flex items-center gap-2 ${muted ? 'text-muted-foreground' : ''}`}>
        {label}
        {amended && amendedLabel && (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            {amendedLabel}
          </span>
        )}
      </span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

export default async function EaStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ employmentId: string }>;
  searchParams: Promise<{ year?: string; company?: string; lang?: string }>;
}) {
  const { employmentId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(employmentId)) notFound();
  const { year, company, lang } = await searchParams;
  /* r242 — THE DOCUMENT'S LANGUAGE, NOT THE VIEWER'S. An EA-shelf arrival names the language the shelf row
     promised (English or Bahasa Malaysia); every other arrival carries none and the PDF renders in the
     viewer's own locale, exactly as it always has. Shape-checked here rather than trusted: this value is
     appended to a download address. */
  const eaLang = lang === 'en' || lang === 'ms' ? lang : null;
  const yr = /^\d{4}$/.test(year ?? '') ? (year as string) : String(new Date().getFullYear());
  const s = await getSession(); // RLS-scopes the read to what this user may see

  // b7b22514 — AN EA FORM BELONGS TO ONE EMPLOYER, and after an Entity Transfer a year can span two. The
  // page renders one employer's form at a time (which is how it is printed and filed) and offers a
  // switcher when there is more than one, so nobody leaves with a partial tax record. An unrecognised
  // company id is ignored rather than honoured — showing the WRONG employer's figures is the failure here.
  const employers = await employeeEaCompanies(s, { employmentId, year: yr });
  const selected = employers.find((c) => c.companyId === company)?.companyId;
  const ea = await employeeEaStatement(s, { employmentId, year: yr, ...(selected ? { companyId: selected } : {}) });
  if (!ea) notFound();

  // The amend panel writes to ea_override, which is keyed (employment, year, field) with no company — so
  // it may only be offered on the employer whose form those rows actually overlay (the current one).
  const isCurrentEmployer = !selected || employers.some((c) => c.companyId === selected && c.isCurrent);

  const t = await getTranslations('payroll.ea');
  const canAmend = isAdmin(s) || canManagePayroll(s); // server gate for the "Amend EA figures" panel

  // b36a8a91 — IS THIS FORM READY TO BE FILED? Derived from the statement ALREADY read above, joined to
  // the field register; see lib/ea-readiness.ts for what "missing" is allowed to mean. It counts and names
  // boxes and computes no figure, so the panel cannot disagree with the form printed beneath it.
  const readiness = eaReadiness(ea);
  // The box's name in the form's own vocabulary — the same caption Section A prints for it two rows down,
  // never a second wording for one box. Two captions where the form takes either document (I.C. / passport).
  // Every key reachable here is also dereferenced statically below, which is what keeps them covered by
  // test/i18n-coverage.test.ts's static sweep.
  const boxName = (captions: readonly EaBoxCaption[]) => captions.map((k) => t(k as 'name')).join(' / ');

  const CATEGORY: Record<number, string> = {
    1: t('category1'),
    2: t('category2'),
    3: t('category3'),
  };

  const period =
    ea.employee.hiredOn || ea.employee.terminatedOn
      ? `${ea.employee.hiredOn ?? '—'} → ${ea.employee.terminatedOn ?? t('present')}`
      : '—';

  // 1.2.6 — which Part B/D/E lines carry an HR amendment (drives the "Amended" badge + original tooltip).
  const ovByField = new Map(ea.overrides.map((o) => [o.field, o]));
  const amendedBadge = t('override.amendedBadge');
  // The amend panel's per-field rows: derived original + active amended value (null if none) + reason.
  const fieldLabels: Record<string, string> = {
    grossSalary: t('override.fieldGrossSalary'),
    bonus: t('override.fieldBonus'),
    allowances: t('override.fieldAllowances'),
    gross: t('override.fieldGross'),
    mtd: t('override.fieldMtd'),
    cp38: t('override.fieldCp38'),
    zakat: t('override.fieldZakat'),
    epf: t('override.fieldEpf'),
    socso: t('override.fieldSocso'),
    eis: t('override.fieldEis'),
    // 6036dab7 — the manual boxes. They reuse the SECTION labels rather than getting their own amend-panel
    // wording, so the operator amends the line they can see on the form above.
    directorFee: t('directorFee'),
    tipsPerquisites: t('tipsPerquisites'),
    taxBorneByEmployer: t('taxBorneByEmployer'),
    esos: t('esos'),
    gratuity: t('gratuity'),
    arrears: t('arrears'),
    benefitsInKind: t('benefitsInKind'),
    livingAccommodation: t('livingAccommodation'),
    unapprovedFundRefund: t('unapprovedFundRefund'),
    compensation: t('compensation'),
    pension: t('pension'),
    annuity: t('annuity'),
  };
  const derivedFor: Record<string, number> = {
    grossSalary: ovByField.get('grossSalary')?.original ?? ea.partB.grossSalary,
    bonus: ovByField.get('bonus')?.original ?? ea.partB.bonus,
    allowances: ovByField.get('allowances')?.original ?? ea.partB.allowances,
    gross: ovByField.get('gross')?.original ?? ea.partB.gross,
    mtd: ovByField.get('mtd')?.original ?? ea.partD.mtd,
    cp38: ovByField.get('cp38')?.original ?? ea.partD.cp38,
    zakat: ovByField.get('zakat')?.original ?? ea.partD.zakat,
    epf: ovByField.get('epf')?.original ?? ea.partE.epf,
    socso: ovByField.get('socso')?.original ?? ea.partE.socso,
    eis: ovByField.get('eis')?.original ?? ea.partE.eis,
    directorFee: ovByField.get('directorFee')?.original ?? ea.partB.directorFee,
    tipsPerquisites: ovByField.get('tipsPerquisites')?.original ?? ea.partB.tipsPerquisites,
    taxBorneByEmployer: ovByField.get('taxBorneByEmployer')?.original ?? ea.partB.taxBorneByEmployer,
    esos: ovByField.get('esos')?.original ?? ea.partB.esos,
    gratuity: ovByField.get('gratuity')?.original ?? ea.partB.gratuity,
    arrears: ovByField.get('arrears')?.original ?? ea.partB.arrears,
    benefitsInKind: ovByField.get('benefitsInKind')?.original ?? ea.partB.benefitsInKind,
    livingAccommodation: ovByField.get('livingAccommodation')?.original ?? ea.partB.livingAccommodation,
    unapprovedFundRefund: ovByField.get('unapprovedFundRefund')?.original ?? ea.partB.unapprovedFundRefund,
    compensation: ovByField.get('compensation')?.original ?? ea.partB.compensation,
    pension: ovByField.get('pension')?.original ?? ea.partC.pension,
    annuity: ovByField.get('annuity')?.original ?? ea.partC.annuity,
  };
  // #18 — the statutory EA fields reconciled against the year's filed CP39/agency total. For these, the
  // payroll-derived value IS the filed total (same payslip.statutory.* source), so filedTotal = derived.
  // 6036dab7 — `cp38` joins them (it is remitted on the same CP39 return as the MTD); `zakat` does not,
  // because it goes to a state religious authority and this system holds no filed total for it. The set
  // here MIRRORS core/ea-override.ts's STATUTORY_FIELDS — the service is the authority, this is the hint.
  const STATUTORY_EA_FIELDS = new Set(['mtd', 'cp38', 'epf', 'socso', 'eis']);
  // 6036dab7 — THE ORDER IS THE FORM'S ORDER, not the vocabulary's: the panel is read against the
  // statement printed directly above it, and a box that is hard to find in the panel is a box that gets
  // left empty. Derived figures first (Part B cash, then D, then E), then the manual boxes in form order.
  const amendFields: AmendField[] = (
    [
      'grossSalary',
      'bonus',
      'directorFee',
      'allowances',
      'tipsPerquisites',
      'taxBorneByEmployer',
      'esos',
      'gratuity',
      'arrears',
      'benefitsInKind',
      'livingAccommodation',
      'unapprovedFundRefund',
      'compensation',
      'gross',
      'pension',
      'annuity',
      'mtd',
      'cp38',
      'zakat',
      'epf',
      'socso',
      'eis',
      // da4fc817 — Section D's four. Three have no payroll source at all, so the amend panel is the ONLY
      // way they are ever entered; `tp1Relief` is derived and amendable for the reason `mtd` is.
      'tp1Relief',
      'donations',
      'zakatOther',
      'childRelief',
    ] as const
  ).map((field) => ({
    field,
    label: fieldLabels[field],
    original: derivedFor[field],
    amended: ovByField.get(field)?.amended ?? null,
    reason: ovByField.get(field)?.reason ?? null,
    statutory: STATUTORY_EA_FIELDS.has(field),
    filedTotal: STATUTORY_EA_FIELDS.has(field) ? derivedFor[field] : null,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/payroll/reports" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← {t('backToReports')}
        </Link>
        <div className="flex items-center gap-3">
          {/* ⚠️ r242 — THE DOWNLOAD HAD TO COME WITH THE ROUTE. Until this round an EA-shelf arrival
              clicked a name and got the PDF immediately; b36a8a91 sends that click to this screen
              instead, so the download it replaced has to be ON this screen or the round would have
              deleted a capability while calling itself an improvement. Same route the /me tab already
              uses — one renderer, not a second — and it carries the shelf's language when there was one. */}
          <a
            href={`/me/ea/${employmentId}/pdf?year=${yr}${eaLang ? `&lang=${eaLang}` : ''}`}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {t('downloadPdf')}
          </a>
          <PrintButton />
        </div>
      </div>

      {/* b7b22514 — a transfer year has one form PER EMPLOYER. Shown only when there is genuinely more
          than one, so the ordinary single-employer year is visually unchanged. Without it the screen looks
          complete while holding half the employee's tax record. */}
      {employers.length > 1 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10 print:hidden">
          <p className="font-medium text-amber-900 dark:text-amber-200">{t('multiEmployer.title', { count: employers.length })}</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300/90">{t('multiEmployer.body')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {employers.map((c) => {
              const active = c.companyId === ea.employerId;
              return (
                <Link
                  key={c.companyId}
                  href={`/payroll/reports/ea/${employmentId}?year=${yr}&company=${c.companyId}`}
                  aria-current={active ? 'page' : undefined}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'border-amber-600 bg-amber-600 text-white'
                      : 'border-amber-400 bg-white text-amber-900 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200'
                  }`}
                >
                  {c.name}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* ea54fe6e §7/§8 — PAY ITEMS THAT PUT MONEY ON THIS FORM AND ARE NOT MAPPED TO AN EA LINE.
          Shown whatever the year, on purpose: the mapping has to be finished BEFORE the first year that
          routes it, and an operator who only sees this on the form that needed it has already missed.
          It names the items rather than counting them — "3 pay items are unmapped" sends someone hunting
          through the catalogue. Not a failure state: the form is correct either way, the amounts simply
          stay in the summary boxes, and the wording says exactly that rather than implying a lost figure. */}
      {ea.routing.unmapped.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-500/40 dark:bg-amber-500/10 print:hidden">
          <p className="font-medium text-amber-900 dark:text-amber-200">{t('eaMapping.title')}</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300/90">{t('eaMapping.body')}</p>
          <ul className="mt-2 space-y-0.5 text-amber-800 dark:text-amber-300/90">
            {ea.routing.unmapped.map((u) => (
              <li key={u.code} className="font-mono text-xs">
                {u.code} · <span className="font-sans">{u.name}</span>
              </li>
            ))}
          </ul>
          {/* Only say "not yet in effect" when that is true, so the notice never contradicts the form. */}
          {!ea.routing.active && (
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-300/90">
              {t('eaMapping.pending', { year: ea.routing.fromYear })}
            </p>
          )}
          <Link
            href="/admin/pay-components"
            className="mt-3 inline-block rounded-md border border-amber-400 bg-white px-3 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 dark:bg-transparent dark:text-amber-200"
          >
            {t('eaMapping.action')}
          </Link>
        </div>
      )}

      <Card className="space-y-5 p-6">
        <div className="border-b border-border pb-4">
          <h1 className="text-lg font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('yearEnded', { year: ea.year, employer: ea.employer.name })}
            {ea.employer.eNumber ? ` · E ${ea.employer.eNumber}` : ''}
          </p>
          {/* d6e2cccc — THIS SCREEN IS NOT THE FORM, AND SAYING SO IS THE WHOLE ROUND. The reporter
              photographed this page and filed "the EA is not the statutory form"; what downloads from
              the button above IS the C.P.8A (Pin. 2023), drawn by lib/ea-pdf.ts to an arrangement
              measured off the blank C.P.8A they themselves supplied. The gap was never the PDF, it was
              that nothing on the screen in front of it said which one you were looking at.
              print:hidden — it is a note about the screen, so it must not appear on the printed sheet.
              AGENTS 28b: this asserts only what OUR download is, never what LHDN does or does not
              publish. */}
          <p className="mt-2 text-xs text-muted-foreground print:hidden">{t('previewNotice')}</p>
        </div>

        {/* ⚠️ HR ONLY, ON THE SAME PREDICATE THE AMEND PANEL USES. This page has no role gate of its own:
            app/me/page.tsx links EVERY employee here for their own EA (self-serve tax filing), and RLS
            scoping is what stops them reading somebody else's. So an ungated readiness panel would tell an
            ordinary employee that their record is incomplete and send them to Personnel Management — an
            admin screen they cannot open. The panel is a note to the person who can act on it. */}
        {canAmend && (
        <>
        {/* b36a8a91 — WHETHER THIS FORM IS READY, AND WHAT IS STOPPING IT. Above the boxes, because the
            answer is what the reader came for; `print:hidden` because it is a note to the reviewer and not
            part of the statement the employee is handed.
            ⚠️ The green line claims ONLY that nothing the form takes from the employee's RECORD is absent.
            It says nothing about whether a figure is right, and the note under it says so rather than
            letting "Ready for review" be read as an assurance about the money (AGENTS 28). */}
        <div
          className={`rounded-lg border px-4 py-3 print:hidden ${
            readiness.ready
              ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10'
              : 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                readiness.ready
                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
              }`}
            >
              {readiness.ready ? t('readiness.ready') : t('readiness.required')}
            </span>
            <span
              className={`text-sm font-medium ${
                readiness.ready ? 'text-emerald-900 dark:text-emerald-200' : 'text-amber-900 dark:text-amber-200'
              }`}
            >
              {readiness.ready ? t('readiness.readyNote') : t('readiness.requiredNote', { count: readiness.missing.length })}
            </span>
          </div>

          {/* Each empty box by NAME, and where on the employee's record the detail belongs — the panel exists
              because "one of these fifty rows is blank" is not something a reader should have to find. */}
          {readiness.missing.length > 0 && (
            <ul className="mt-3 divide-y divide-amber-200/70 dark:divide-amber-500/20">
              {readiness.missing.map((m) => (
                <li
                  key={m.captions.join('/')}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 text-sm"
                >
                  <span className="font-medium text-amber-900 dark:text-amber-200">{boxName(m.captions)}</span>
                  <span className="text-xs text-amber-800 dark:text-amber-300/90">
                    {m.where === 'profile' ? t('readiness.whereProfile') : t('readiness.whereStatutory')}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            {t('readiness.checkedNote', { boxes: readiness.checked.map((c) => trimBoxCaption(boxName(c.captions))).join(' · ') })}
          </p>
        </div>
        </>
        )}

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionAEmployeeParticulars')}
          </h2>
          <Row label={t('name')} value={ea.employee.name} />
          {/* 6036dab7 — job title, employee number and passport. All three read from tables the statement
              already joined; the passport is the same column the CP39 form reads for the same purpose. */}
          <Row label={t('jobTitle')} value={ea.employee.jobTitle || '—'} />
          <Row label={t('employeeNo')} value={ea.employee.employeeNo || '—'} />
          <Row label={t('incomeTaxNo')} value={ea.employee.taxNo || '—'} />
          <Row label={t('icNo')} value={ea.employee.ic || '—'} />
          <Row label={t('passportNo')} value={ea.employee.passport || '—'} />
          <Row label={t('epfNo')} value={ea.employee.epfNo || '—'} />
          <Row label={t('socsoNo')} value={ea.employee.socsoNo || '—'} />
          <Row label={t('mtdCategory')} value={CATEGORY[ea.employee.category] ?? ea.employee.category} />
          <Row label={t('childrenTaxRelief')} value={ea.employee.children} />
          <Row label={t('employmentPeriod')} value={period} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionBEmploymentIncome')}
          </h2>
          <Row label={t('grossSalary')} value={rm(ea.partB.grossSalary)} amended={ovByField.has('grossSalary')} amendedLabel={amendedBadge} />
          <Row label={t('bonus')} value={rm(ea.partB.bonus)} amended={ovByField.has('bonus')} amendedLabel={amendedBadge} />
          <Row label={t('directorFee')} value={rm(ea.partB.directorFee)} amended={ovByField.has('directorFee')} amendedLabel={amendedBadge} />
          <Row label={t('allowancesPerquisites')} value={rm(ea.partB.allowances)} amended={ovByField.has('allowances')} amendedLabel={amendedBadge} />
          <Row label={t('tipsPerquisites')} value={rm(ea.partB.tipsPerquisites)} amended={ovByField.has('tipsPerquisites')} amendedLabel={amendedBadge} />
          <Row label={t('taxBorneByEmployer')} value={rm(ea.partB.taxBorneByEmployer)} amended={ovByField.has('taxBorneByEmployer')} amendedLabel={amendedBadge} />
          <Row label={t('esos')} value={rm(ea.partB.esos)} amended={ovByField.has('esos')} amendedLabel={amendedBadge} />
          <Row label={t('gratuity')} value={rm(ea.partB.gratuity)} amended={ovByField.has('gratuity')} amendedLabel={amendedBadge} />
          <Row label={t('arrears')} value={rm(ea.partB.arrears)} amended={ovByField.has('arrears')} amendedLabel={amendedBadge} />
          {/* Feedback 09b554e9 — the year's tax-exempt allowance portions (informational: already inside
              the allowances line; LHDN's EA reports exempt allowances in their own section). */}
          <Row label={t('exemptAllowances')} value={rm(ea.partB.exemptAllowances ?? 0)} muted />
          {/* 6036dab7 — BIK and living accommodation were the words "not tracked"; they are manual boxes
              now, filled from the same amend panel as every other amended figure. */}
          <Row label={t('benefitsInKind')} value={rm(ea.partB.benefitsInKind)} amended={ovByField.has('benefitsInKind')} amendedLabel={amendedBadge} />
          <Row label={t('livingAccommodation')} value={rm(ea.partB.livingAccommodation)} amended={ovByField.has('livingAccommodation')} amendedLabel={amendedBadge} />
          <Row label={t('unapprovedFundRefund')} value={rm(ea.partB.unapprovedFundRefund)} amended={ovByField.has('unapprovedFundRefund')} amendedLabel={amendedBadge} />
          <Row label={t('compensation')} value={rm(ea.partB.compensation)} amended={ovByField.has('compensation')} amendedLabel={amendedBadge} />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span className="flex items-center gap-2">
              {t('totalGrossRemuneration')}
              {ovByField.has('gross') && (
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  {amendedBadge}
                </span>
              )}
            </span>
            <span className="tabular-nums">{rm(ea.partB.gross)}</span>
          </div>
        </section>

        {/* 6036dab7 — C · Pension and other payments. The section did not exist on this screen at all,
            which the plan calls the clearest gap against the customer's field mapping. Neither figure has
            a payroll source, so both are manual boxes; the total is recomputed from the two lines. */}
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionCPensionOther')}
          </h2>
          <Row label={t('pension')} value={rm(ea.partC.pension)} amended={ovByField.has('pension')} amendedLabel={amendedBadge} />
          <Row label={t('annuity')} value={rm(ea.partC.annuity)} amended={ovByField.has('annuity')} amendedLabel={amendedBadge} />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('totalPensionOther')}</span>
            <span className="tabular-nums">{rm(ea.partC.total)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionDTotalDeductions')}
          </h2>
          <Row label={t('monthlyTaxDeduction')} value={rm(ea.partD.mtd)} amended={ovByField.has('mtd')} amendedLabel={amendedBadge} />
          {/* 6036dab7 — CP38 is stamped on every regular payslip (payslip.statutory.cp38, the same scalar
              the monthly CP39 return files). It printed the words "not tracked" here for a year after
              payroll started producing it: stale wording, not an unimplemented figure. */}
          <Row label={t('cp38Deductions')} value={rm(ea.partD.cp38)} amended={ovByField.has('cp38')} amendedLabel={amendedBadge} />
          {/* 1.2.4 Zakat — the year's accumulated zakat-via-salary (Z), now sourced from the payslips. */}
          <Row label={t('zakatViaSalary')} value={rm(ea.partD.zakat)} amended={ovByField.has('zakat')} amendedLabel={amendedBadge} />
          {/* da4fc817 — D4, D5(a), D5(b), D6, in the official form's order. Shown only when set OR amended,
              which mirrors the PDF's `optionalRow`: an absent box asserts nothing, a box reading 0.00
              asserts the money does not exist (AGENTS 28). `tp1Relief` is derived from the year's approved
              TP1 declarations, so it is usually real; the other three appear once HR enters them. */}
          {(ea.partD.donations !== 0 || ovByField.has('donations')) && (
            <Row label={t('donations')} value={rm(ea.partD.donations)} amended={ovByField.has('donations')} amendedLabel={amendedBadge} />
          )}
          {(ea.partD.tp1Relief !== 0 || ovByField.has('tp1Relief')) && (
            <Row label={t('tp1Relief')} value={rm(ea.partD.tp1Relief)} amended={ovByField.has('tp1Relief')} amendedLabel={amendedBadge} />
          )}
          {(ea.partD.zakatOther !== 0 || ovByField.has('zakatOther')) && (
            <Row label={t('zakatOther')} value={rm(ea.partD.zakatOther)} amended={ovByField.has('zakatOther')} amendedLabel={amendedBadge} />
          )}
          {(ea.partD.childRelief !== 0 || ovByField.has('childRelief')) && (
            <Row label={t('childRelief')} value={rm(ea.partD.childRelief)} amended={ovByField.has('childRelief')} amendedLabel={amendedBadge} />
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionEContributions')}
          </h2>
          {/* da4fc817 — the official Section E names the fund before its amount and carries exactly two
              figures. EIS is kept but printed below the section, exactly as the PDF does, so the two
              surfaces cannot describe one form two ways. */}
          <Row label={t('fundName')} value={ea.partE.fundName} />
          <Row label={t('epfKwsp')} value={rm(ea.partE.epf)} amended={ovByField.has('epf')} amendedLabel={amendedBadge} />
          <Row label={t('socso')} value={rm(ea.partE.socso)} amended={ovByField.has('socso')} amendedLabel={amendedBadge} />
          <Row label={t('sectionFExemptAllowances')} value={rm(ea.partB.exemptAllowances ?? 0)} />
          <Row label={t('eisSip')} value={rm(ea.partE.eis)} amended={ovByField.has('eis')} amendedLabel={amendedBadge} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('sectionFTaxExempt')}
          </h2>
          {/* 6036dab7 — LEFT SAYING "not tracked", DELIBERATELY, and it is the only line on this form that
              still does. Section F on the C.P.8A is the total of tax reliefs and deductions APPROVED by
              LHDN (the TP1 items), which is not the same thing as the tax-exempt allowance portions Part B
              already reports — and this screen's own label for it ("Total tax-exempt allowances") may
              itself be wrong. We hold no copy of the official artwork to settle which it is, so wiring
              `partB.exemptAllowances` in here would be attaching a real number to a box we cannot name.
              An honest blank beats a confident wrong figure on a tax document; see MY_STATUTORY_LINKS on
              why this catalogue never claims `fidelity: 'official'` without the agency's own page. */}
          <Row label={t('taxExemptAllowances')} value={t('notTracked')} muted />
        </section>

        {/* 6036dab7 — the boxes with no payroll source say so in one place, rather than each printing a
            muted "not tracked" that reads as "this product cannot do it". */}
        {canAmend && isCurrentEmployer && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
            {t('manualEntryNote')}
          </div>
        )}

        {/* 1.2.6 — "Amended" note shown when ≥1 EA field was overwritten by HR (drives the same marker the
            PDF prints). */}
        {ea.overrides.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            {t('override.amendedNote')}
          </div>
        )}

        {/* CP8D / Form E adjacency note — overrides are EA-only; Form E figures stay payroll-derived. */}
        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
          {t('formEUnaffectedNote')}
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
          ℹ️ {t('disclaimer', { year: ea.year, version: ea.statutoryVersion })}
        </div>
      </Card>

      {/* Admin-only "Amend EA figures" panel (server-gated). Original vs amended + required reason + confirm. */}
      {canAmend && isCurrentEmployer && <EaAmendPanel employmentId={employmentId} year={yr} fields={amendFields} />}

      <ToastFromQuery />
    </div>
  );
}
