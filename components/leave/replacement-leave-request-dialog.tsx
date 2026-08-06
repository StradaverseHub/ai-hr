'use client';

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { normalizeDayText } from '@/lib/day-format';

type Action = (fd: FormData) => void | Promise<void>;

/** Reuses the shape the Request Leave dialog is already handed, so the page maps its type list once. */
export type ReplacementLeaveTypeOption = { id: string; label: string };

type Row = { key: number; workedDate: string; days: string; fromTime: string; toTime: string };

const STD_DAY_MINUTES = 480;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * "+ Replacement Leave Request" — the employee's own claim for time already worked (296fc027 Step 2).
 *
 * IT SITS BESIDE "+ Request Leave" AND IS NOT THE SAME THING, which is the distinction the whole feature
 * turns on. Request Leave asks to TAKE time. This asks to be CREDITED for time already worked. They look
 * alike in the header row and are opposites underneath — different table, different service, and a credit
 * rather than a debit at the end of it (see migration 0381's header for why reusing `leave_request` would
 * have corrupted the balance check, the calendar and payroll at once).
 *
 * THE TOTAL IS COMPUTED HERE ONLY TO BE SHOWN. The employee needs to see what they are claiming before
 * they submit, so the running total at the bottom of the table updates as rows are added and removed. It
 * is NOT what gets banked: the server recomputes both totals from the posted rows (`totalsFor` in
 * core/replacement-request.ts) and stores its own figure. A client that lied about its total would change
 * nothing — this arithmetic is duplicated for the user's benefit, not trusted.
 *
 * UNIT IS PER REQUEST, not per row. Choosing Hour swaps every row to From/To time pickers and totals the
 * hours; choosing Day gives every row a number of days. A request that mixed the two would have no honest
 * figure to put at the bottom, which is the one number the employee is being asked to check.
 *
 * All copy comes from `useTranslations` INSIDE this client component — the house pattern for client
 * widgets, and the one that structurally cannot hit the server→client function-prop hazard, because no
 * translator ever crosses the boundary.
 */
export function ReplacementLeaveRequestDialog({
  types,
  submitAction,
  today,
  requiresFirstScheduleConsent,
}: {
  types: ReplacementLeaveTypeOption[];
  submitAction: Action;
  /** Today in the tenant's zone, resolved on the server — the max selectable worked date. */
  today: string;
  /**
   * The employee is within the First Schedule and their company allows banking with consent, so the
   * agreement checkbox is required. A plain boolean: the SERVER decides this and enforces it again on
   * submit (core/replacement-request.ts). Rendering it is how the agreement gets recorded, not how it
   * gets checked.
   */
  requiresFirstScheduleConsent?: boolean;
}) {
  const t = useTranslations('replacementRequest');
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<'day' | 'hour'>('day');
  const [rows, setRows] = useState<Row[]>([{ key: 1, workedDate: '', days: '1', fromTime: '', toTime: '' }]);

  const addRow = () =>
    setRows((r) => [...r, { key: (r[r.length - 1]?.key ?? 0) + 1, workedDate: '', days: '1', fromTime: '', toTime: '' }]);
  // Never remove the last row: an empty table has no "add" affordance attached to anything and reads as a
  // broken form. The server refuses a request with no dates anyway.
  const removeRow = (key: number) => setRows((r) => (r.length <= 1 ? r : r.filter((x) => x.key !== key)));
  const patch = (key: number, field: keyof Row, value: string) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, [field]: value } : x)));

  const total = useMemo(() => {
    let minutes = 0;
    for (const r of rows) {
      if (unit === 'hour') {
        if (!r.fromTime || !r.toTime) continue;
        const [fh, fm] = r.fromTime.split(':').map(Number);
        const [th, tm] = r.toTime.split(':').map(Number);
        const d = th * 60 + tm - (fh * 60 + fm);
        if (Number.isFinite(d) && d > 0) minutes += d;
      } else {
        const d = Number(r.days);
        if (Number.isFinite(d) && d > 0) minutes += d * STD_DAY_MINUTES;
      }
    }
    return { days: round2(minutes / STD_DAY_MINUTES), hours: round2(minutes / 60) };
  }, [rows, unit]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary} data-tour="replacement-leave-request">
          <Plus className="size-4" />
          {t('trigger')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold text-foreground">{t('title')}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">{t('description')}</Dialog.Description>

          <form action={submitAction} onSubmit={() => setOpen(false)} className="mt-4 space-y-4">
            <input type="hidden" name="unit" value={unit} />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('leaveType')}>
                <select name="leaveTypeId" className={inputCls}>
                  {types.map((ty) => (
                    <option key={ty.id} value={ty.id}>
                      {ty.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('unit')}>
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as 'day' | 'hour')}
                  className={inputCls}
                  aria-label={t('unit')}
                >
                  <option value="day">{t('unitDay')}</option>
                  <option value="hour">{t('unitHour')}</option>
                </select>
              </Field>
            </div>

            {/* ── The worked-date table: add and remove rows, running total at the bottom ─────────── */}
            <div className="rounded-lg border border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">{t('datesTitle')}</div>
              <div className="space-y-2 p-3">
                {rows.map((r) => (
                  <div key={r.key} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[10rem] flex-1">
                      <label className="mb-1 block text-[11px] text-muted-foreground">{t('workedDate')}</label>
                      <input
                        type="date"
                        name="workedDate"
                        required
                        max={today}
                        value={r.workedDate}
                        onChange={(e) => patch(r.key, 'workedDate', e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    {unit === 'hour' ? (
                      <>
                        <div className="min-w-[7rem]">
                          <label className="mb-1 block text-[11px] text-muted-foreground">{t('fromTime')}</label>
                          <input
                            type="time"
                            name="fromTime"
                            required
                            value={r.fromTime}
                            onChange={(e) => patch(r.key, 'fromTime', e.target.value)}
                            className={inputCls}
                          />
                        </div>
                        <div className="min-w-[7rem]">
                          <label className="mb-1 block text-[11px] text-muted-foreground">{t('toTime')}</label>
                          <input
                            type="time"
                            name="toTime"
                            required
                            value={r.toTime}
                            onChange={(e) => patch(r.key, 'toTime', e.target.value)}
                            className={inputCls}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="min-w-[7rem]">
                        <label className="mb-1 block text-[11px] text-muted-foreground">{t('days')}</label>
                        <input
                          type="number"
                          name="days"
                          required
                          min={0.5}
                          step={0.5}
                          value={r.days}
                          onChange={(e) => patch(r.key, 'days', e.target.value)}
                          // 4a1abc4a: tidy to 2dp on blur so the credit typed here and the credit later
                          // read off the Replacement Leave panel are written the same way. Only patches on
                          // a real change, and a blank/half-typed cell is left for the form to refuse.
                          onBlur={(e) => {
                            const next = normalizeDayText(e.currentTarget.value);
                            if (next !== e.currentTarget.value) patch(r.key, 'days', next);
                          }}
                          className={inputCls}
                        />
                      </div>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => removeRow(r.key)}
                      disabled={rows.length <= 1}
                      aria-label={t('removeRow')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button type="button" size="sm" variant="secondary" onClick={addRow}>
                  {t('addRow')}
                </Button>
              </div>
              <div className="flex items-center justify-between border-t border-border px-3 py-2 text-sm">
                <span className="text-muted-foreground">{t('total')}</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {unit === 'hour' ? t('totalHours', { hours: total.hours }) : t('totalDays', { days: total.days })}
                </span>
              </div>
            </div>

            <Field label={t('reason')}>
              <input name="reason" className={inputCls} />
            </Field>

            {/* The statutory-floor agreement. Rendered only when the server says this employee is within
                the First Schedule and their company allows banking — and enforced server-side regardless,
                so removing this checkbox in the browser refuses the submission rather than skipping it. */}
            {requiresFirstScheduleConsent && (
              <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
                <input type="checkbox" name="firstScheduleConsent" required className="mt-0.5 h-4 w-4" />
                <span className="text-foreground">{t('firstScheduleConsent')}</span>
              </label>
            )}

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {t('cancel')}
                </Button>
              </Dialog.Close>
              <button className={btnPrimary}>{t('submit')}</button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
