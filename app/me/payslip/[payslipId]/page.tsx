import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { payslipDetail } from '@/core/payroll';
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
          <Row label={t('basicSalary')} value={rm(p.basic)} />
          <Row label={t('allowances')} value={rm(p.allowance)} />
          <Row label={t('overtime')} value={rm(p.overtime)} />
          <Row label={t('bonus')} value={rm(p.bonus)} />
          <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2 text-sm font-semibold">
            <span>{t('grossPay')}</span>
            <span className="tabular-nums">{rm(p.gross)}</span>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('deductionsHeading')}
          </h2>
          <Row label={t('epf')} value={rm(st.epfEmployee)} />
          <Row label={t('socso')} value={rm(st.socsoEmployee)} />
          {Number(st.socsoSkbbk) > 0 && <Row label={t('skbbk')} value={rm(st.socsoSkbbk)} />}
          <Row label={t('eis')} value={rm(st.eisEmployee)} />
          <Row label={t('pcb')} value={rm(st.pcb)} />
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
      </Card>
    </div>
  );
}
