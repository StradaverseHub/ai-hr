import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
// 97a9b0ab — reads the ruleset/pack provenance already present in the payslip's statutory JSONB.
import { payslipProvenance } from '@/core/payslip-recompute';
// 3c473773 — which box each earning belongs in (read from the payslip's own stamp), and the employer-borne
// disclosure (read from the payslip's own snapshot). Neither is re-derived from today's settings.
import { payslipDisplayEarnings } from '@/core/pay-display-category';
import { payslipEmployerBorne, type EmployerBorneKey } from '@/core/payslip-employer-borne';

/** The label key for each employer-borne component, exhaustive over EmployerBorneKey. */
const EMPLOYER_BORNE_LABEL: Record<EmployerBorneKey, 'epf' | 'socso' | 'skbbk' | 'eis' | 'pcb'> = {
  epf: 'epf', socso: 'socso', skbbk: 'skbbk', eis: 'eis', tax: 'pcb',
};
import { Card } from '@/components/ui';
import { PrintButton } from '@/components/print-button';

const rm = (n: unknown) =>
  `RM ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type RecordLine = { code: string; name: string; amount: number };
type Stat = {
  epfEmployee?: number;
  epfEmployer?: number;
  socsoEmployee?: number;
  socsoEmployer?: number;
  socsoSkbbk?: number;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PayslipPage({ params }: { params: Promise<{ payslipId: string }> }) {
  const { payslipId } = await params;
  if (!UUID.test(payslipId)) notFound(); // malformed id → 404, not a DB-error 500
  const s = await getSession();
  const p = await payslipDetail(s, payslipId);
  if (!p) notFound();
  const st = (p.statutory ?? {}) as Stat;
  const prov = payslipProvenance(p.statutory);
  // 3c473773 — the earnings boxes as THIS payslip recorded them. Absent on every payslip issued before the
  // pay items carried a category, in which case these are the stored columns and the page is unchanged.
  const disp = payslipDisplayEarnings(p);
  const eb = payslipEmployerBorne(p.statutory);
  const t = await getTranslations('me.payslip');

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
            <h1 className="text-lg font-semibold tracking-tight">{t('title', { payPeriod: p.payPeriod })}</h1>
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
          {/* f3148da1 — the converted OT excess is folded into stored allowance; show the base allowance net
              of it, then a dedicated line for the pay item, so gross still reconciles. */}
          <Row label={t('allowances')} value={rm(disp.allowance - Number(st.otConvert?.amount ?? 0))} />
          <Row label={t('overtime')} value={rm(disp.overtime)} />
          {Number(st.otConvert?.amount) > 0 && (
            <Row label={t('otConverted', { item: st.otConvert!.name })} value={rm(st.otConvert!.amount)} />
          )}
          <Row label={t('bonus')} value={rm(disp.bonus)} />
          {/* 3c473773 — the Claim box, shown only when a pay item was deliberately categorised into it. */}
          {disp.claim > 0 && <Row label={t('claim')} value={rm(disp.claim)} />}
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
          {Number(st.socsoSkbbk) > 0 && <Row label={t('skbbk')} value={rm(eb.employee.skbbk)} />}
          <Row label={t('eis')} value={rm(eb.employee.eis)} />
          <Row label={t('pcb')} value={rm(eb.employee.pcb)} />
          {Number(st.cp38) > 0 && <Row label={t('cp38')} value={rm(st.cp38)} />}
          {/* 1.2.4 Zakat — informational only: PCB above is ALREADY net of this (LHDN §E.5 offset), so it
              is NOT re-added to total deductions. Muted, shown only when there is an election this month. */}
          {Number(st.zakat) > 0 && (
            <Row label={t('zakat')} value={`${rm(st.zakat)} · ${t('zakatOffsetNote')}`} muted />
          )}
          {Number(p.otherDeductions) > 0 && <Row label={t('otherDeductions')} value={rm(p.otherDeductions)} />}
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('totalDeductions')}</span>
            <span className="tabular-nums">−{rm(p.totalDeductions)}</span>
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
        </section>

        {st.recordLines && st.recordLines.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('recordLinesHeading')}
            </h2>
            {st.recordLines.map((l) => (
              <Row key={l.code} label={l.name} value={rm(l.amount)} muted />
            ))}
            <p className="mt-2 text-xs text-muted-foreground">{t('recordLinesNote')}</p>
          </section>
        )}

        {p.daysWorked != null && (
          <p className="text-xs text-muted-foreground">
            {t('proratedNote', { days: Number(p.daysWorked) })}
          </p>
        )}

        {/* 97a9b0ab — provenance. Both values were already recorded and neither was ever shown:
            `statutory.version` is the statutory ruleset that produced these figures (stamped on every
            payslip since 2026.0) and `payslip.version` counts recalculations. Showing them is what lets
            "why did my tax change when my pay didn't?" get a specific answer instead of reassurance. */}
        {(prov.rulesetVersion || p.version > 1) && (
          <p className="text-xs text-muted-foreground">
            {prov.rulesetVersion && t('provenanceFooter', { ruleset: prov.rulesetVersion })}
            {p.version > 1 && <> {t('provenanceRevision', { n: p.version })}</>}
          </p>
        )}
      </Card>
    </div>
  );
}
