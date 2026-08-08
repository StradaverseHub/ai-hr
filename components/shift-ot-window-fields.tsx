'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { inputCls } from '@/components/ui';

export type OtWindowRow = {
  label: string;
  startTime: string;
  endTime: string;
  endNextDay: boolean;
  minMinutes: string;
  maxMinutes: string;
  adjustAfterMinutes: string;
  adjustDeltaMinutes: string;
};

const blank = (): OtWindowRow => ({
  label: '',
  startTime: '17:00',
  endTime: '23:59',
  endNextDay: false,
  minMinutes: '',
  maxMinutes: '',
  adjustAfterMinutes: '',
  adjustDeltaMinutes: '',
});

/**
 * cf21e554 STAGE 2 — the shift's Overtime Schedule grid (table shift_ot_window, migration 0418).
 *
 * Overtime BY CLOCK TIME, which is how the reporter's reference screen states it: one window before the
 * shift (05:00–08:00) and one after it (17:00–23:59), each with its own shortest and longest length, and
 * the adjustment their shift name refers to ("WITH 0.5 OT HOUR ADJ" = once overtime reaches 1h30, deduct
 * 30 minutes). Rows post as one JSON `otWindows` field, the same shape the break rows use, because the tab
 * is edited as a grid and a per-row update path would need row identity this form does not have.
 *
 * A shift with NO rows here keeps today's behaviour exactly: workday overtime is the time worked past the
 * shift's end. The engine only switches to the windows when at least one exists.
 */
export function ShiftOtWindowFields({ defaultRows = [] }: { defaultRows?: OtWindowRow[] }) {
  const t = useTranslations('admin.attendancePolicy');
  const [rows, setRows] = useState<OtWindowRow[]>(defaultRows);

  const set = (i: number, patch: Partial<OtWindowRow>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  // Only rows with both clock faces are posted; a half-filled row is an in-progress edit, not an instruction.
  const posted = rows
    .filter((r) => r.startTime && r.endTime)
    .map((r) => ({
      label: r.label.trim() || null,
      startTime: r.startTime,
      endTime: r.endTime,
      endNextDay: r.endNextDay,
      minMinutes: r.minMinutes.trim() === '' ? null : Number(r.minMinutes),
      maxMinutes: r.maxMinutes.trim() === '' ? null : Number(r.maxMinutes),
      adjustAfterMinutes: r.adjustAfterMinutes.trim() === '' ? null : Number(r.adjustAfterMinutes),
      adjustDeltaMinutes: r.adjustDeltaMinutes.trim() === '' ? null : Number(r.adjustDeltaMinutes),
    }));

  return (
    <div className="w-full space-y-2">
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">{t('otWindowSeq')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowLabel')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowStart')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowEnd')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowNextDay')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowMin')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowMax')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowAdjustAfter')}</th>
                <th className="py-1 pr-2 font-medium">{t('otWindowAdjustDelta')}</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="py-1 pr-2 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="py-1 pr-2">
                    <input value={r.label} onChange={(e) => set(i, { label: e.target.value })} className={`${inputCls} w-28`} aria-label={t('otWindowLabel')} />
                  </td>
                  <td className="py-1 pr-2">
                    <input type="time" value={r.startTime} onChange={(e) => set(i, { startTime: e.target.value })} className={inputCls} aria-label={t('otWindowStart')} />
                  </td>
                  <td className="py-1 pr-2">
                    <input type="time" value={r.endTime} onChange={(e) => set(i, { endTime: e.target.value })} className={inputCls} aria-label={t('otWindowEnd')} />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="checkbox"
                      checked={r.endNextDay}
                      onChange={(e) => set(i, { endNextDay: e.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                      aria-label={t('otWindowNextDay')}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number"
                      min={0}
                      value={r.minMinutes}
                      onChange={(e) => set(i, { minMinutes: e.target.value })}
                      className={`${inputCls} w-20`}
                      aria-label={t('otWindowMin')}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number"
                      min={0}
                      value={r.maxMinutes}
                      onChange={(e) => set(i, { maxMinutes: e.target.value })}
                      className={`${inputCls} w-20`}
                      aria-label={t('otWindowMax')}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number"
                      min={0}
                      value={r.adjustAfterMinutes}
                      onChange={(e) => set(i, { adjustAfterMinutes: e.target.value })}
                      className={`${inputCls} w-24`}
                      aria-label={t('otWindowAdjustAfter')}
                    />
                  </td>
                  <td className="py-1 pr-2">
                    {/* SIGNED: −30 is the reporter's deduction, a positive value an uplift. */}
                    <input
                      type="number"
                      value={r.adjustDeltaMinutes}
                      onChange={(e) => set(i, { adjustDeltaMinutes: e.target.value })}
                      className={`${inputCls} w-24`}
                      aria-label={t('otWindowAdjustDelta')}
                    />
                  </td>
                  <td className="py-1">
                    <button
                      type="button"
                      onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                      className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
                      aria-label={t('otWindowRemove')}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        onClick={() => setRows((prev) => [...prev, blank()])}
        className="rounded-md border border-border px-2.5 py-1 text-sm text-foreground hover:bg-muted"
      >
        {t('otWindowAdd')}
      </button>
      {/* Always posted, including as an empty array — that is how the last window is deleted. */}
      <input type="hidden" name="otWindows" value={JSON.stringify(posted)} />
      <p className="text-xs text-muted-foreground">{t('otScheduleHint')}</p>
      <p className="text-xs text-muted-foreground">{t('otScheduleNotInRound')}</p>
    </div>
  );
}
