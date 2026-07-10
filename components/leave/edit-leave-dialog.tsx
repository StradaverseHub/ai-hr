'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { Button, Field, inputCls } from '../ui';

type Action = (fd: FormData) => void | Promise<void>;

const ALL_DURATIONS = ['full_day', 'half_day_am', 'half_day_pm', 'hourly'] as const;
type Duration = (typeof ALL_DURATIONS)[number];

export type EditLeaveTypeOption = { id: string; label: string; durations: string[] | null; code?: string };

/**
 * Edit-by-status self-service (item c9a19e34) — an employee edits their OWN PENDING leave in place. Opens a
 * dialog prefilled with the request's current details (leave type, duration, dates, times, reason, remark) and
 * posts `submitAction` (myEditLeave / editLeaveAction) with the same field names the apply form uses, plus a
 * hidden leaveRequestId. Available ONLY for pending rows (the parent gates this) — the service also re-asserts
 * status='pending' + subject-only. Mirrors LeaveDurationFields' duration/date reactivity (half/hourly force a
 * single day; hourly reveals the From/To window) but as a self-contained, prefilled form so the shared apply
 * component stays untouched.
 */
export function EditLeaveDialog({
  leaveRequestId,
  types,
  current,
  submitAction,
}: {
  leaveRequestId: string;
  types: EditLeaveTypeOption[];
  current: {
    leaveTypeId: string;
    durationType: Duration;
    startDate: string;
    endDate: string;
    fromTime?: string | null;
    toTime?: string | null;
    reason?: string | null;
    employeeRemark?: string | null;
  };
  submitAction: Action;
}) {
  const t = useTranslations('leave');
  const [open, setOpen] = useState(false);
  const [typeId, setTypeId] = useState(current.leaveTypeId);
  const [duration, setDuration] = useState<Duration>(current.durationType ?? 'full_day');
  const [start, setStart] = useState(current.startDate);
  const [end, setEnd] = useState(current.endDate);
  const [fromTime, setFromTime] = useState((current.fromTime ?? '').slice(0, 5));
  const [toTime, setToTime] = useState((current.toTime ?? '').slice(0, 5));

  const selected = types.find((x) => x.id === typeId);
  const allowed = new Set<Duration>(['full_day', ...((selected?.durations ?? []) as Duration[])]);
  const effectiveDuration: Duration = allowed.has(duration) ? duration : 'full_day';

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" size="sm" variant="outline" className="gap-1.5">
          <Pencil className="size-3.5" />
          {t('editButton')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('editDialogTitle')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-foreground">
            {t('editDialogDescription')}
          </Dialog.Description>
          <form action={submitAction} className="mt-4 space-y-3" onSubmit={() => setOpen(false)}>
            <input type="hidden" name="leaveRequestId" value={leaveRequestId} />

            <Field label={t('fieldLeaveType')}>
              <select
                name="leaveTypeId"
                required
                value={typeId}
                onChange={(e) => {
                  setTypeId(e.target.value);
                  setDuration('full_day');
                }}
                className={inputCls}
              >
                {types.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t('fieldDurationType')}>
              <select
                name="durationType"
                value={effectiveDuration}
                onChange={(e) => setDuration(e.target.value as Duration)}
                className={inputCls}
              >
                {ALL_DURATIONS.map((d) => (
                  <option key={d} value={d} disabled={!allowed.has(d)}>
                    {t(`duration.${d}`)}
                  </option>
                ))}
              </select>
            </Field>

            {effectiveDuration === 'hourly' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('fieldFromTime')}>
                  <input
                    name="fromTime"
                    type="time"
                    step="900"
                    required
                    value={fromTime}
                    onChange={(e) => setFromTime(e.target.value)}
                    className={inputCls}
                  />
                </Field>
                <Field label={t('fieldToTime')}>
                  <input
                    name="toTime"
                    type="time"
                    step="900"
                    required
                    value={toTime}
                    onChange={(e) => setToTime(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label={t('fieldStartDate')}>
                <input
                  name="startDate"
                  type="date"
                  required
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className={inputCls}
                />
              </Field>
              {effectiveDuration === 'full_day' ? (
                <Field label={t('fieldEndDate')}>
                  <input
                    name="endDate"
                    type="date"
                    required
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    className={inputCls}
                  />
                </Field>
              ) : (
                // Half/hourly is single-day: force end = start, no visible End-date field.
                <input type="hidden" name="endDate" value={start} readOnly />
              )}
            </div>

            <Field label={t('fieldReason')}>
              <input name="reason" defaultValue={current.reason ?? ''} className={inputCls} placeholder={t('reasonPlaceholder')} />
            </Field>
            <Field label={t('employeeRemarkLabel')}>
              <textarea name="employeeRemark" rows={2} defaultValue={current.employeeRemark ?? ''} className={inputCls} />
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <Dialog.Close asChild>
                <Button type="button" size="sm" variant="outline">
                  {t('cancelDialogDismiss')}
                </Button>
              </Dialog.Close>
              <Button type="submit" size="sm">
                {t('editSaveLabel')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
