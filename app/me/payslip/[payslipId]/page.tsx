import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
// 3c473773 — which box each earning belongs in (read from the payslip's own stamp), and the employer-borne
// disclosure (read from the payslip's own snapshot). Neither is re-derived from today's settings.
import { payslipDisplayEarnings } from '@/core/pay-display-category';
import { absenceDaysLabel, payslipAbsenceLines } from '@/core/payslip-absence-lines';
import { payslipEmployerBorne, type EmployerBorneKey } from '@/core/payslip-employer-borne';
import { payslipSkbbkLineShown, payslipSkbbkSubject } from '@/core/payslip-skbbk-line';
// 6b134681 — the pay items behind the Overtime and Bonus figures, named from the payslip's own stamp.
// The SAME derivation the printed PDF and Transaction View → History use, so the three cannot disagree
// about which items make up a figure or how one is labelled.
// 417d4937 — and `recordLineIdentity`, the read-time repair for RECORD lines: until r196 the kernel
// named a consumed one-off from the transaction's free-text remark, and that fix reaches only runs
// calculated after it, so an already-issued payslip keeps the old wording unless the screen repairs it.
import {
  earningRowShown,
  payItemLabel,
  payItemLinesForBuckets,
  payItemLinesReconcile,
  recordLineIdentity,
  storedComponentLines,
} from '@/core/payslip-earning-lines';
// The tenant catalogue is readable by every tenant member (migration 0065 `pay_component_rls`), so the
// employee's own payslip can name its items correctly without any widening of what they may see.
import { listPayComponents } from '@/core/pay-components';

/** The label key for each employer-borne component, exhaustive over EmployerBorneKey. */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** `nonPayable` is read only by `recordLineIdentity`, and it is what stops a record-only BIK — whose
 *  stored name IS the pay item's own description — being relabelled from today's catalogue and captioned
 *  "Entered as …". Absent ⇒ written before the stamp (core/payroll.ts `PayslipRecordLine`). */
type RecordLine = { code: string; name: string; amount: number; nonPayable?: boolean };
type Stat = {
  epfEmployee?: number;
  epfEmployer?: number;
  socsoEmployee?: number;
  socsoEmployer?: number;
  socsoSkbbk?: number;
  /** a96d320c rev 2 — the SKBBK ELECTION as this run recorded it. Absent on every earlier slip; read
   *  through `payslipSkbbkSubject`, which is the one place `absent` and `false` are told apart. */
  skbbkSubject?: boolean;
  eisEmployee?: number;
  eisEmployer?: number;
  pcb?: number;
  cp38?: number;
  zakat?: number;
  recordLines?: RecordLine[];
  // f3148da1 Step 4 — OT excess redirected to a pay item (shown as a distinct earnings line).
  otConvert?: { code: string; name: string; amount: number };
};

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-1.5 text-sm last:border-0">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : 'font-medium'}`}>{value}</span>
    </div>
  );
}

/**
 * 6b134681 — the pay items that make up the figure above, indented under it.
 *
 * The reporter keyed "B0001 — ANGPOW RM500" and this page answered "Bonus RM500.00". The code and the
 * description were on the payslip all along (`statutory.componentLines`); the bonus figure was simply the
 * one earnings box that was never broken out. Rendered ONLY from what the payslip stored — never
 * re-derived from today's pay-item setup, which is how a breakdown ends up contradicting the total it
 * sits under. No new message keys: a pay item's own label is data, not chrome.
 */
function SubLines({ lines }: { lines: { code: string | null; name: string; amount: number }[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mb-1 ms-3 border-s border-border/60 ps-3">
      {lines.map((l, i) => (
        <li
          key={`${l.code ?? ''}-${i}`}
          className="flex items-baseline justify-between gap-4 py-0.5 text-xs text-muted-foreground"
        >
          <span>{payItemLabel(l)}</span>
          <span className="tabular-nums">{rm(l.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * f35f758a — "August 2026", not the stored "2026-08".
 *
 * The idiom this repo already uses for a month name on four screens (statutory forms, the roster,
 * scheduled actions, the EA report): `Intl.DateTimeFormat`, month long, timeZone UTC so a month cannot
 * shift by one in a negative-offset render. No new message keys — twelve month names × six locales is a
 * translation set to maintain for something the platform already knows.
 *
 * A SCREEN formats in the reader's own language. The downloaded document deliberately does not: its
 * embedded font is Latin-1 and a Chinese, Thai or Tamil month name would print as question marks
 * (lib/payslip-pdf-strings.ts).
 */
function monthYear(payPeriod: string, locale: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(payPeriod ?? '');
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return payPeriod ?? '';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)),
  );
}

export default async function PayslipPage({ params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) notFound(); // malformed id → 404, not a DB-error 500
  const s = await getSession();
  const p = await payslipDetail(s, payslipId);
  if (!p) notFound();
  const st = (p.statutory ?? {}) as Stat;
  // 3c473773 — the earnings boxes as THIS payslip recorded them. Absent on every payslip issued before the
  // pay items carried a category, in which case these are the stored columns and the page is unchanged.
  const disp = payslipDisplayEarnings(p);
  const eb = payslipEmployerBorne(p.statutory);
  // e2632276 — the unpaid-leave / absence halves of "Other deductions", named and day-counted. Read from
  // THIS payslip's own stamp; a slip issued before this shipped has none and renders exactly as before.
  const absence = payslipAbsenceLines(p.statutory, p.otherDeductions);
  // 6b134681 — the named items behind Overtime and Bonus, from this payslip's OWN per-item stamp. Each
  // list is shown only when it adds up to the figure it explains (a payslip whose display categories
  // moved money between boxes, or one issued before the stamp existed, keeps the bare figure) — the same
  // reconciliation rule the printed document applies, from the same function.
  // f3148da1 — the allowance figure with the OT-converted excess taken back out; it gets its own row
  // below, so gross still reconciles. Named here because a96d320c rev 2 tests it for zero as well as
  // printing it, and the two must be the same number.
  const allowanceNet = disp.allowance - Number(st.otConvert?.amount ?? 0);
  const stored = storedComponentLines(p.statutory);
  const otLines = payItemLinesForBuckets(stored, ['ot']);
  const bonusLines = payItemLinesForBuckets(stored, ['bonus']);
  const showOtLines = payItemLinesReconcile(otLines, disp.overtime);
  const showBonusLines = payItemLinesReconcile(bonusLines, disp.bonus);
  // 417d4937 — code → today's pay item description, for the record-line label repair. Read only when
  // this payslip actually carries record lines, so the ordinary payslip costs no extra query.
  const payItemNames: Record<string, string> =
    st.recordLines && st.recordLines.length > 0
      ? Object.fromEntries((await listPayComponents(s, { includeArchived: true })).map((c) => [c.code, c.name]))
      : {};
  const t = await getTranslations('me.payslip');
  // r367 — the employer-contributions note lives under `payroll.individualPayslip`, where the payslip
  // DOCUMENT already resolves it (lib/payslip-pdf-strings.ts). Bound here rather than copied under
  // `me.` because a second key would be a seventh translation to keep in step for one sentence; a
  // namespace on this page is deduplication, not a permission boundary, exactly as the admin payslip
  // screen and the two PDF routes already treat it.
  const tIp = await getTranslations('payroll.individualPayslip');
  const locale = await getLocale();

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Link href="/me" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          ← {t('backToWorkspace')}
        </Link>
        <div className="flex items-center gap-2">
          <a
            href={`/me/payslip/${payslipId}/pdf`}
            download
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
          >
            {t('downloadPdf')}
          </a>
          <PrintButton />
        </div>
      </div>

      <Card className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {t('title', { payPeriod: monthYear(p.payPeriod, locale) })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {/* Employee ID left-of-name (feedback 38668d9b) */}
              {p.employeeCode ? `${p.employeeCode} · ` : ''}
              {p.employee} · {p.company}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium capitalize text-muted-foreground">
            {p.status}
          </span>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('earnings')}
          </h2>
          <Row label={t('basicSalary')} value={rm(disp.basic)} />
          {/* a96d320c rev 2 — AN EARNING LINE WITH NOTHING ON IT IS NOT SHOWN, and the SCREEN follows the
              DOCUMENT rather than the other way round: the printed payslip stops rendering a zero
              Allowance / Overtime / Bonus in the same round (lib/payslip-pdf.ts `earningsRowsOf`), and a
              screen that kept them would disagree with the PDF downloaded from it about what the month
              contained. The test is the STORED figure on this payslip — `payslipDisplayEarnings` off its
              own snapshot — never today's pay-item setup. Basic salary is deliberately not subject to the
              rule; the statutory deduction lines below are deliberately not subject to it either.

              `|| showOtLines` / `|| showBonusLines`: a sub-line list belongs TO its row, so a figure that
              is zero because its named items cancel each other out keeps its row and prints 0.00 with the
              items under it. Hiding the heading and leaving the detail would be an orphan — the one way
              this rule could make a payslip harder to read rather than shorter. */}
          {/* f3148da1 — the converted OT excess is folded into stored allowance; show the base allowance net
              of it, then a dedicated line for the pay item, so gross still reconciles. */}
          {earningRowShown(allowanceNet) && <Row label={t('allowances')} value={rm(allowanceNet)} />}
          {(earningRowShown(disp.overtime) || showOtLines) && <Row label={t('overtime')} value={rm(disp.overtime)} />}
          {showOtLines && <SubLines lines={otLines} />}
          {Number(st.otConvert?.amount) > 0 && (
            <Row label={t('otConverted', { item: st.otConvert!.name })} value={rm(st.otConvert!.amount)} />
          )}
          {(earningRowShown(disp.bonus) || showBonusLines) && <Row label={t('bonus')} value={rm(disp.bonus)} />}
          {/* 6b134681 — "B0001 · ANGPOW  RM500.00" under the Bonus figure, instead of the figure alone.
              The classification (additional remuneration ⇒ the bonus box) decides the BOX; it never gets
              to stand in for the pay item's own code and description. */}
          {showBonusLines && <SubLines lines={bonusLines} />}
          {/* 3c473773 — the Claim box, shown only when a pay item was deliberately categorised into it. */}
          {earningRowShown(disp.claim) && <Row label={t('claim')} value={rm(disp.claim)} />}
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('grossPay')}</span>
            <span className="tabular-nums">{rm(p.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('deductionsHeading')}
          </h2>
          {/* 3c473773 issue 2 — what was actually deducted from YOU: the computed share less anything the
              employer agreed to fund on your behalf, read from this payslip's own snapshot. The full share
              is unchanged, is what is remitted to KWSP / PERKESO / LHDN, and is restated below. A payslip
              carrying no snapshot (every one issued before the setting existed) renders as it always did. */}
          <Row label={t('epf')} value={rm(eb.employee.epf)} />
          <Row label={t('socso')} value={rm(eb.employee.socso)} />
          {/* a96d320c rev 2 — the ELECTION, not the amount: `> 0` could not tell "no SKBBK" from "has
              SKBBK, contributed 0.00". One predicate, shared with the printed document and the two admin
              payslip surfaces — core/payslip-skbbk-line.ts carries the argument. */}
          {payslipSkbbkLineShown(payslipSkbbkSubject(st), eb.employee.skbbk) && (
            <Row label={t('skbbk')} value={rm(eb.employee.skbbk)} />
          )}
          <Row label={t('eis')} value={rm(eb.employee.eis)} />
          <Row label={t('pcb')} value={rm(eb.employee.pcb)} />
          {/* 970e4143 — WHAT WAS DEDUCTED, and only when it could be carved out of "Other deductions".
              Never `st.cp38`: that is the PRE-CLAMP instalment (a 9,000 direction against 6,500 of pay
              printed 9,000.00 when 5,606.65 was taken), and the applied figure is folded INTO the
              other-deductions column, so a row beside an uncarved residual counted it twice. One decider
              for all three payslip surfaces — core/payslip-absence-lines.ts. */}
          {absence.cp38.show && <Row label={t('cp38')} value={rm(absence.cp38.amount)} />}
          {/* 3a092cf0 — A REAL DEDUCTION LINE, not an informational aside. This row used to be MUTED with
              the amount and the offset note crammed into the value column, because the total below it
              genuinely excluded the zakat: the kernel never charged it, so a full-strength row would have
              made the column stop adding up. The kernel charges it now, so the row prints like every
              deduction beside it — a plain tabular figure that the reader can add to the ones above.
              The offset note moves to the LABEL, where it answers the question the reporter actually
              asked (why is PCB zero and zakat 30?) without displacing the amount. */}
          {Number(st.zakat) > 0 && (
            <Row label={`${t('zakat')} · ${t('zakatOffsetNote')}`} value={rm(st.zakat)} />
          )}
          {/* e2632276 — two named lines in place of the unnamed lump; the residual keeps the section
              summing to Total deductions, and is hidden when it nets to zero. */}
          {absence.unpaidLeave && (
            <Row
              label={`${t('unpaidLeaveLine')} · ${absenceDaysLabel(absence.unpaidLeave.days, t('dayUnit'), t('daysUnit'))}`}
              value={rm(absence.unpaidLeave.amount)}
            />
          )}
          {absence.absent && (
            <Row
              label={`${t('absentLine')} · ${absenceDaysLabel(absence.absent.days, t('dayUnit'), t('daysUnit'))}`}
              value={rm(absence.absent.amount)}
            />
          )}
          {absence.showResidual && <Row label={t('otherDeductions')} value={rm(absence.residual)} />}
          {/* 6b4ca488 — no minus prefix. The ticket named the admin surfaces, but this ESS slip renders
              the SAME positive `totalDeductions` with the SAME literal U+2212, and leaving it here would
              mean the employee's copy and the admin copy of one payslip print the figure differently.
              Display only; see app/payroll/individual-payslip/page.tsx for the full note. */}
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('totalDeductions')}</span>
            <span className="tabular-nums">{rm(p.totalDeductions)}</span>
          </div>
        </section>

        {/* ── Employer-borne statutory contributions (3c473773 issue 2) ──
            Without this block the deductions above do not visibly add up: an EPF share of RM629.00 reads
            RM0.00 and nothing says who paid it. The amounts come from this payslip's own stored snapshot,
            never from the employee's current flags — otherwise a payslip issued before the setting was
            switched on would retro-explain itself with today's settings. */}
        {eb.any && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('employerBorneHeading')}
            </h2>
            {eb.keys.map((k) => (
              <Row key={k} label={t(EMPLOYER_BORNE_LABEL[k])} value={rm(eb.borne[k])} />
            ))}
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
              <span>{t('employerBorneTotal')}</span>
              <span className="tabular-nums">{rm(eb.total)}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('employerBorneNote')}</p>
          </section>
        )}

        <div className="flex items-baseline justify-between rounded-lg bg-primary/5 px-4 py-3">
          <span className="text-sm font-semibold">{t('netPay')}</span>
          <span className="text-lg font-bold tabular-nums text-primary">{rm(p.net)}</span>
        </div>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('employerContributionsHeading')}
          </h2>
          <Row label={t('epf')} value={rm(st.epfEmployer)} muted />
          <Row label={t('socso')} value={rm(st.socsoEmployer)} muted />
          <Row label={t('eis')} value={rm(st.eisEmployer)} muted />
          <Row label={t('totalEmployerCost')} value={rm(p.employerCost)} muted />
          {/* r367 — THE SENTENCE THAT NOW CARRIES WHAT THE HEADING'S BRACKET USED TO.
              This heading read "Employer contributions (not deducted from you)". The bracket was
              load-bearing on the EMPLOYEE'S OWN copy above all: the row labels here and in Deductions
              further up are THE SAME KEYS — `epf`, `socso`, `eis` render in both blocks — so the heading was
              the only thing on this page telling the reader which of the two figures came out of their pay.
              The printed document has carried this sentence under the same box all along
              (lib/payslip-pdf.ts `empSpec.note`), and until this round no screen resolved the key at all.
              Already translated in all six catalogues; nothing is added. */}
          <p className="mt-2 text-xs text-muted-foreground">{tIp('employerContributionsNote')}</p>
        </section>

        {st.recordLines && st.recordLines.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('recordLinesHeading')}
            </h2>
            {/* 417d4937 — the pay item's own DESCRIPTION (not its code: this is the employee's copy and
                it has always read as words, and an internal TXN_* code would be a worse answer than the
                remark it replaces), with the words that were typed kept beside it. Nothing is rewritten
                and nothing is hidden; the amount is exactly as stored. */}
            {st.recordLines.map((l) => {
              const id = recordLineIdentity(l, payItemNames);
              return (
                <Row
                  key={l.code}
                  label={id.remark ? `${id.name} — ${t('recordLineRemark', { remark: id.remark })}` : id.name}
                  value={rm(l.amount)}
                  muted
                />
              );
            })}
            <p className="mt-2 text-xs text-muted-foreground">{t('recordLinesNote')}</p>
          </section>
        )}

        {/* f35f758a — THE TWO INTERNAL SENTENCES ARE OFF THE EMPLOYEE'S COPY.
            "Prorated on N days worked in this period." and "Calculated under statutory rules version X."
            both stood here and both came off the downloaded document too; leaving them on the screen
            beside a document that no longer carries them is the drift this product keeps being caught by.
            The day count is not lost — it is a FIELD on the downloaded payslip's employment panel, where
            it reads as information rather than as a note about the arithmetic.
            THE RULESET LINE SURVIVES ON THE HR-FACING SCREEN (app/payroll/individual-payslip/page.tsx),
            which is the split the plan committed to: whoever is checking a figure can still answer
            "why did my tax change when my pay did not?", and the employee is not shown the working.
            The message keys are kept — `provenanceFooter` is still resolved by the admin screen. */}
        {p.version > 1 && (
          // Not one of the two sentences, and not internal: a recalculated payslip must say it was
          // recalculated, or the employee cannot tell this copy from the one they filed last month.
          <p className="text-xs text-muted-foreground">{t('provenanceRevision', { n: p.version })}</p>
        )}
      </Card>
    </div>
  );
}
