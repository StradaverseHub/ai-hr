'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, inputCls } from '@/components/ui';
import { fmtHours2, fmtMin, fmtShort } from '@/components/attendance-format';
import type {
  RecomputeFigures,
  RecomputeFlag,
  RecomputeResult,
  RecomputeRow,
  RecomputeRunSummary,
} from '@/core/attendance-recompute';
import { applyRecomputeAction, previewRecomputeAction } from './actions';

/**
 * The Recompute screen (feedback 1c1b321a), modelled on app/attendance/import/punch-import.tsx: the same
 * idle → previewed → done island over a preview-then-commit server action pair.
 *
 * What the approved mockup promises, and therefore what this file owes:
 *  · every day that WOULD change, listed NOW beside AFTER across all six figures (hours worked, late-in,
 *    early-out, overtime by rate, day type, status);
 *  · the clock-in → clock-out column carrying the words "never changed", because the whole feature rests
 *    on that being true;
 *  · days that cannot be worked out cleanly in a SEPARATE table that says what happens to them (nothing);
 *  · the already-processed pay runs that would be flagged, shown BEFORE Apply, not after;
 *  · a plain result line, and a permanent list of past runs each of which re-opens to its own day list.
 *
 * The preview is never trusted as an instruction: Apply re-runs the whole computation server-side and
 * writes what IT derives.
 */

type Company = { id: string; name: string };
type Department = { id: string; name: string; companyId: string };
type Employee = {
  employmentId: string;
  name: string;
  employeeCode: string | null;
  companyId: string;
  departmentId: string | null;
};

type Phase = 'idle' | 'previewed' | 'done';

/** The five paid OT buckets plus the flat one, in the order the Records vocabulary lists them. */
const OT_BUCKETS: { key: keyof RecomputeFigures; rate: string }[] = [
  { key: 'otFlatMinutes', rate: 'flat' },
  { key: 'ot00Minutes', rate: '0.00' },
  { key: 'ot10Minutes', rate: '1.00' },
  { key: 'ot15Minutes', rate: '1.50' },
  { key: 'ot20Minutes', rate: '2.00' },
  { key: 'ot30Minutes', rate: '3.00' },
];

const CHANGED = 'font-semibold text-indigo-600 dark:text-indigo-400';

export function RecomputeClient({
  companies,
  departments,
  employees,
  recentRuns,
}: {
  companies: Company[];
  departments: Department[];
  employees: Employee[];
  recentRuns: RecomputeRunSummary[];
}) {
  const t = useTranslations('attendance.recompute');
  const router = useRouter();

  const [companyId, setCompanyId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employmentId, setEmploymentId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<RecomputeResult | null>(null);
  const [applied, setApplied] = useState<RecomputeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
  const deptOptions = useMemo(
    () => departments.filter((d) => d.companyId === companyId),
    [departments, companyId],
  );
  const empOptions = useMemo(
    () =>
      employees.filter(
        (e) => e.companyId === companyId && (departmentId === '' || e.departmentId === departmentId),
      ),
    [employees, companyId, departmentId],
  );

  const reset = () => {
    setPreview(null);
    setApplied(null);
    setPhase('idle');
    setError(null);
  };
  /** Any scope edit invalidates a preview: a preview is a statement about ONE scope. */
  const onScopeChange = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    reset();
  };

  const request = () => ({
    companyId,
    departmentId: departmentId || null,
    employmentIds: employmentId ? [employmentId] : null,
    from,
    to,
  });
  const canPreview = companyId !== '' && from !== '' && to !== '' && from <= to;

  const runPreview = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await previewRecomputeAction(request());
        setPreview(r);
        setApplied(null);
        setPhase('previewed');
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const runApply = () =>
    startTransition(async () => {
      setError(null);
      try {
        const r = await applyRecomputeAction(request());
        setApplied(r);
        setPhase('done');
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });

  const dayTypeText = (v: RecomputeFigures['dayType']) =>
    v === 'workday' ? t('dayWorking') : v === 'rest_day' ? t('dayRest') : v === 'holiday' ? t('dayHoliday') : '—';
  const statusText = (v: string) =>
    v === 'present' ? t('statusPresent') : v === 'late' ? t('statusLate') : v === 'half_day' ? t('statusHalfDay') : v;
  const reasonText = (r: RecomputeFlag['reason']) =>
    r === 'missing-clock-out' ? t('whyNoClockOut') : r === 'no-clock-in' ? t('whyNoClockIn') : t('whyStoredAbsent');

  /** The overtime cell: one line per non-empty rate bucket, "hours × rate". Empty is an em dash. */
  const otCell = (f: RecomputeFigures) => {
    const parts = OT_BUCKETS.map(({ key, rate }) => ({ rate, m: (f[key] as number | null) ?? 0 })).filter(
      (x) => x.m > 0,
    );
    if (parts.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="flex flex-col gap-0.5">
        {parts.map((x) => (
          <span key={x.rate} className="whitespace-nowrap">
            {fmtHours2(x.m)} × {x.rate === 'flat' ? t('rateFlat') : x.rate}
          </span>
        ))}
      </span>
    );
  };
  /** True when this row's overtime split moved at all — drives the AFTER-side highlight. */
  const otMoved = (r: RecomputeRow) => OT_BUCKETS.some(({ key }) => r.before[key] !== r.after[key]);

  const dayTable = (rows: RecomputeRow[]) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr className="bg-muted/40">
            <th className="px-3 py-2" colSpan={4} />
            <th className="border-l border-border px-3 py-2 font-medium" colSpan={6}>
              {t('groupNow')}
            </th>
            <th className="border-l border-border bg-indigo-50/60 px-3 py-2 font-medium dark:bg-indigo-500/10" colSpan={6}>
              {t('groupAfter')}
            </th>
          </tr>
          <tr className="bg-muted/50">
            <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
            <th className="px-3 py-2 font-medium">{t('colDate')}</th>
            <th className="px-3 py-2 font-medium">{t('colShift')}</th>
            <th className="px-3 py-2 font-medium">
              {t('colClock')}
              <span className="block text-[10px] normal-case text-muted-foreground">{t('colClockNote')}</span>
            </th>
            <th className="border-l border-border px-3 py-2 font-medium">{t('colHours')}</th>
            <th className="px-3 py-2 font-medium">{t('colLateIn')}</th>
            <th className="px-3 py-2 font-medium">{t('colEarlyOut')}</th>
            <th className="px-3 py-2 font-medium">{t('colOvertime')}</th>
            <th className="px-3 py-2 font-medium">{t('colDayType')}</th>
            <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
            <th className="border-l border-border px-3 py-2 font-medium">{t('colHours')}</th>
            <th className="px-3 py-2 font-medium">{t('colLateIn')}</th>
            <th className="px-3 py-2 font-medium">{t('colEarlyOut')}</th>
            <th className="px-3 py-2 font-medium">{t('colOvertime')}</th>
            <th className="px-3 py-2 font-medium">{t('colDayType')}</th>
            <th className="px-3 py-2 font-medium">{t('colStatus')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={`${r.employmentId}-${r.date}`}>
              <td className="px-3 py-2.5 font-medium">
                {r.employeeCode ? <span className="mr-1.5 text-muted-foreground">{r.employeeCode}</span> : null}
                {r.name}
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">{r.date}</td>
              <td className="px-3 py-2.5 text-muted-foreground">{r.shiftCode ?? '—'}</td>
              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                {r.checkInAt.slice(0, 5)} → {r.checkOutAt ? r.checkOutAt.slice(0, 5) : '—'}
              </td>

              <td className="border-l border-border px-3 py-2.5 tabular-nums">{fmtMin(r.before.workedMinutes)}</td>
              <td className="px-3 py-2.5 tabular-nums">{fmtShort(r.before.lateMinutes)}</td>
              <td className="px-3 py-2.5 tabular-nums">{fmtShort(r.before.earlyOutMinutes)}</td>
              <td className="px-3 py-2.5 tabular-nums">{otCell(r.before)}</td>
              <td className="px-3 py-2.5">{dayTypeText(r.before.dayType)}</td>
              <td className="px-3 py-2.5">{statusText(r.before.status)}</td>

              <td
                className={`border-l border-border px-3 py-2.5 tabular-nums ${r.before.workedMinutes !== r.after.workedMinutes ? CHANGED : ''}`}
              >
                {fmtMin(r.after.workedMinutes)}
              </td>
              <td className={`px-3 py-2.5 tabular-nums ${r.before.lateMinutes !== r.after.lateMinutes ? CHANGED : ''}`}>
                {fmtShort(r.after.lateMinutes)}
              </td>
              <td
                className={`px-3 py-2.5 tabular-nums ${r.before.earlyOutMinutes !== r.after.earlyOutMinutes ? CHANGED : ''}`}
              >
                {fmtShort(r.after.earlyOutMinutes)}
              </td>
              <td className={`px-3 py-2.5 tabular-nums ${otMoved(r) ? CHANGED : ''}`}>
                {otCell(r.after)}
                {r.otPreserved && <span className="block text-[10px] text-muted-foreground">{t('otPreserved')}</span>}
              </td>
              <td className={`px-3 py-2.5 ${r.before.dayType !== r.after.dayType ? CHANGED : ''}`}>
                {dayTypeText(r.after.dayType)}
              </td>
              <td className={`px-3 py-2.5 ${r.before.status !== r.after.status ? CHANGED : ''}`}>
                {statusText(r.after.status)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const flagTable = (flags: RecomputeFlag[]) => (
    <Card className="overflow-hidden border-amber-200 dark:border-amber-500/30">
      <div className="border-b border-amber-200 bg-amber-50/70 px-4 py-3 text-sm font-semibold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
        {t('reviewTitle', { count: flags.length })}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t('colEmployee')}</th>
              <th className="px-3 py-2 font-medium">{t('colDate')}</th>
              <th className="px-3 py-2 font-medium">{t('colClock')}</th>
              <th className="px-3 py-2 font-medium">{t('colWhy')}</th>
              <th className="px-3 py-2 font-medium">{t('colWhatHappens')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {flags.map((f) => (
              <tr key={`${f.employmentId}-${f.date}`}>
                <td className="px-3 py-2.5 font-medium">
                  {f.employeeCode ? <span className="mr-1.5 text-muted-foreground">{f.employeeCode}</span> : null}
                  {f.name}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">{f.date}</td>
                <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                  {f.checkInAt ? f.checkInAt.slice(0, 5) : '—'} → {f.checkOutAt ? f.checkOutAt.slice(0, 5) : '—'}
                </td>
                <td className="px-3 py-2.5">{reasonText(f.reason)}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{t('whatUntouched')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );

  const batchNotice = (r: RecomputeResult, applied: boolean) =>
    r.batchWarnings.length === 0 ? null : (
      <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
        <p className="font-semibold">{applied ? t('batchAppliedTitle') : t('batchTitle', { count: r.batchWarnings.length })}</p>
        <ul className="mt-1.5 space-y-1">
          {r.batchWarnings.map((b) => (
            <li key={b.batchId}>
              <span className="font-medium">{b.payPeriod}</span> · {companyName(r.companyId)} ·{' '}
              {t('batchCovers', { count: b.employmentIds.length })}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-amber-700/80 dark:text-amber-300/70">{t('batchNote')}</p>
      </div>
    );

  const shown = applied ?? preview;

  return (
    <div className="space-y-6">
      {/* ── Scope ─────────────────────────────────────────────────────────────────────────────── */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('company')} required requiredAriaLabel={t('required')} className="min-w-[14rem] flex-1">
            <select
              className={inputCls}
              value={companyId}
              onChange={(e) => {
                onScopeChange(setCompanyId)(e.target.value);
                setDepartmentId('');
                setEmploymentId('');
              }}
            >
              <option value="">{t('chooseCompany')}</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('department')} className="min-w-[12rem] flex-1">
            <select
              className={inputCls}
              value={departmentId}
              disabled={companyId === ''}
              onChange={(e) => {
                onScopeChange(setDepartmentId)(e.target.value);
                setEmploymentId('');
              }}
            >
              <option value="">{t('allDepartments')}</option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('employee')} className="min-w-[12rem] flex-1">
            <select
              className={inputCls}
              value={employmentId}
              disabled={companyId === ''}
              onChange={(e) => onScopeChange(setEmploymentId)(e.target.value)}
            >
              <option value="">{t('allEmployees')}</option>
              {empOptions.map((e) => (
                <option key={e.employmentId} value={e.employmentId}>
                  {e.employeeCode ? `${e.employeeCode} · ${e.name}` : e.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('dateFrom')} className="w-40">
            <input type="date" className={inputCls} value={from} onChange={(e) => onScopeChange(setFrom)(e.target.value)} />
          </Field>
          <Field label={t('dateTo')} className="w-40">
            <input type="date" className={inputCls} value={to} onChange={(e) => onScopeChange(setTo)(e.target.value)} />
          </Field>
          <Button onClick={runPreview} disabled={pending || !canPreview}>
            {pending && phase !== 'done' ? t('previewing') : t('preview')}
          </Button>
        </div>
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">{t('scopeHint')}</p>
      </Card>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400">
          {error}
        </div>
      )}

      {/* ── Preview ───────────────────────────────────────────────────────────────────────────── */}
      {preview && !applied && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{companyName(preview.companyId)}</span> · {preview.from} →{' '}
            {preview.to} · {t('summaryChecked', { count: preview.checked })} ·{' '}
            <span className="font-medium text-foreground">{t('summaryWouldChange', { count: preview.updated })}</span> ·{' '}
            {t('summaryUnchanged', { count: preview.unchanged })} · {t('summaryNeedReview', { count: preview.flagged })}.{' '}
            {t('nothingSaved')}
          </p>

          {preview.updated === 0 ? (
            <Card className="px-4 py-8 text-center text-sm text-muted-foreground">
              {preview.checked === 0 ? t('noDaysInRange') : t('nothingWouldChange')}
            </Card>
          ) : (
            <Card className="overflow-hidden">{dayTable(preview.rows)}</Card>
          )}
          {preview.updated > 0 && <p className="text-xs italic text-muted-foreground">{t('tableNote')}</p>}

          {preview.flags.length > 0 && flagTable(preview.flags)}
          {batchNotice(preview, false)}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">{t('clockNote')}</p>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={reset} disabled={pending}>
                {t('cancel')}
              </Button>
              <Button onClick={runApply} disabled={pending || preview.updated === 0}>
                {pending ? t('applying') : t('apply', { count: preview.updated })}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Result ────────────────────────────────────────────────────────────────────────────── */}
      {applied && (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm font-medium text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            {t('finished')} — {new Date(applied.ranAt).toLocaleString('en-GB')}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('statChecked')} value={applied.checked} />
            <Stat label={t('statUpdated')} value={applied.updated} />
            <Stat label={t('statUnchanged')} value={applied.unchanged} />
            <Stat label={t('statNeedReview')} value={applied.flagged} amber />
          </div>
          {batchNotice(applied, true)}
          {applied.rows.length > 0 && <Card className="overflow-hidden">{dayTable(applied.rows)}</Card>}
          {applied.flags.length > 0 && flagTable(applied.flags)}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                reset();
              }}
            >
              {t('runAnother')}
            </Button>
          </div>
        </div>
      )}

      {/* ── Permanent history ─────────────────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">{t('recentTitle')}</div>
        {recentRuns.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t('noRuns')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colWhen')}</th>
                  <th className="px-3 py-2 font-medium">{t('colRunBy')}</th>
                  <th className="px-3 py-2 font-medium">{t('colScope')}</th>
                  <th className="px-3 py-2 font-medium">{t('colDates')}</th>
                  <th className="px-3 py-2 font-medium">{t('colResult')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('colAction')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentRuns.map((run) => (
                  <Fragment key={run.runId}>
                    <tr>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                        {new Date(run.occurredAt).toLocaleString('en-GB')}
                      </td>
                      <td className="px-3 py-2.5">{run.actorName ?? t('runByUnknown')}</td>
                      <td className="px-3 py-2.5">
                        {companyName(run.companyId)}
                        {run.departmentId && (
                          <span className="text-muted-foreground">
                            {' · '}
                            {departments.find((d) => d.id === run.departmentId)?.name ?? run.departmentId}
                          </span>
                        )}
                        {run.employmentIds && run.employmentIds.length > 0 && (
                          <span className="text-muted-foreground">
                            {' · '}
                            {t('scopeEmployees', { count: run.employmentIds.length })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground">
                        {run.from} → {run.to}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {t('summaryChecked', { count: run.checked })} ·{' '}
                        <span className="font-medium text-foreground">{t('summaryUpdated', { count: run.updated })}</span> ·{' '}
                        {t('summaryUnchanged', { count: run.unchanged })} · {t('summaryNeedReview', { count: run.flagged })}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          className="text-sm text-primary hover:underline"
                          onClick={() => setOpenRunId(openRunId === run.runId ? null : run.runId)}
                        >
                          {openRunId === run.runId ? t('close') : t('open')}
                        </button>
                      </td>
                    </tr>
                    {openRunId === run.runId && (
                      <tr>
                        <td colSpan={6} className="bg-muted/30 p-3">
                          {run.rows.length > 0 ? (
                            <Card className="overflow-hidden">{dayTable(run.rows)}</Card>
                          ) : (
                            <p className="py-4 text-center text-sm text-muted-foreground">{t('runNoChanges')}</p>
                          )}
                          {run.flags.length > 0 && <div className="mt-3">{flagTable(run.flags)}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t('recentNote')}</p>
      </Card>

      {shown === null && <p className="text-xs text-muted-foreground">{t('idleHint')}</p>}
    </div>
  );
}

function Stat({ label, value, amber }: { label: string; value: number; amber?: boolean }) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        amber && value > 0
          ? 'border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10'
          : 'border-border bg-card'
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
