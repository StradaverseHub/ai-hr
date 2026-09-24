'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Button, Field, btnPrimary, inputCls } from '../ui';
import { Combobox } from '../ui/combobox';
import { normalizeDayText } from '@/lib/day-format';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * The preview the server answers for one employee and date. Declared here STRUCTURALLY rather than imported
 * from the leave engine: a client widget importing a core leave module is pack drift (test/leave-pack-drift),
 * and only the shape crosses the boundary anyway. Mirrors core/toil.ts `LeaveCreditPreview`.
 */
export type LeaveCreditPreviewView = {
  workedDayKind: 'workday' | 'rest_day' | 'off_day' | 'holiday';
  eligibleDay: boolean;
  /** r334 · the company's "Extended hours on working day" switch. */
  extendedHoursEnabled: boolean;
  /** r334 · counted minutes past the scheduled shift end; null when the question does not apply. */
  extendedHoursMinutes: number | null;
  /** r334 · the tier those minutes earn. Non-null ⇒ the credit field below is PINNED to it. */
  extendedHoursDays: number | null;
  overtimeMinutes: number;
  defaultExpiresOn: string | null;
  policyEnabled: boolean;
  firstSchedule: boolean;
  allowFirstSchedule: boolean;
  alreadyCredited: boolean;
};

/**
 * 3fb1a611 (r299) · + ADD LEAVE CREDIT — the approved mockup's second panel, as a dialog off the page header.
 *
 * WHAT IT MUST SAY BEFORE SAVE, which is the whole reason it is a client island rather than a plain form:
 *   · the KIND of the date worked for THIS employee (rest day / off day / public holiday), and a refusal when
 *     it is an ordinary working day — the same rule the service enforces;
 *   · ⚠️ MONEY — that overtime is already recorded on the date and will not ALSO be paid once credited
 *     (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS). The plan promises the form tells HR this before save;
 *   · the statutory floor: a First-Schedule employee needs their recorded agreement (a checkbox), or is
 *     refused outright when their company does not allow it.
 * The expiry date is pre-filled from the company's rule the first time an answer arrives and never
 * overwritten once HR has typed one.
 *
 * NOT THE CONTROL. Every one of these is re-checked by `grantLeaveCredit`; the preview only stops HR filling
 * in a form the save would refuse. The leave type is fixed: a Leave Credit is always Replacement Leave.
 *
 * Copy comes from `useTranslations` inside this component and every prop is serialisable — no translator or
 * server closure crosses the boundary except the two server actions (test/server-client-boundary.test.ts).
 */
export function LeaveCreditAddDialog({
  employees,
  today,
  submitAction,
  previewAction,
}: {
  employees: { id: string; label: string }[];
  /** Today in the tenant's zone: the latest selectable date worked. */
  today: string;
  submitAction: Action;
  previewAction: (p: { employmentId: string; workedDate: string }) => Promise<LeaveCreditPreviewView | null>;
}) {
  const t = useTranslations('admin.leaveCredit');
  const [open, setOpen] = useState(false);
  const [employmentId, setEmploymentId] = useState('');
  const [workedDate, setWorkedDate] = useState('');
  const [days, setDays] = useState('1');
  const [expiresOn, setExpiresOn] = useState('');
  const expiryTouched = useRef(false);
  const [preview, setPreview] = useState<LeaveCreditPreviewView | null>(null);
  const [checking, startCheck] = useTransition();
  const req = useRef(0);

  useEffect(() => {
    if (!employmentId || !workedDate) {
      setPreview(null);
      return;
    }
    const mine = ++req.current;
    startCheck(async () => {
      const r = await previewAction({ employmentId, workedDate });
      if (mine !== req.current) return; // a newer employee/date was picked meanwhile
      setPreview(r);
      if (r?.defaultExpiresOn && !expiryTouched.current) setExpiresOn(r.defaultExpiresOn);
      // r334 · an ordinary working day's credit is NOT HR's to choose: `grantLeaveCredit` refuses anything
      // but the tier the day's extended hours earned, so the field is set to it and made read-only below.
      // Overwrites whatever is in the box, including a figure HR typed for a previous date — that figure is
      // meaningless for this one, and leaving it would submit a value the save is guaranteed to reject.
      if (r?.extendedHoursDays != null) setDays(String(r.extendedHoursDays));
    });
  }, [employmentId, workedDate, previewAction]);

  const kindLabel: Record<LeaveCreditPreviewView['workedDayKind'], string> = {
    workday: t('dayKind.workday'),
    rest_day: t('dayKind.restDay'),
    off_day: t('dayKind.offDay'),
    holiday: t('dayKind.holiday'),
  };
  const pinnedDays = preview?.extendedHoursDays ?? null;
  const fsBlocked = preview != null && preview.firstSchedule && !preview.allowFirstSchedule;
  const blocked =
    preview != null && (!preview.eligibleDay || preview.alreadyCredited || !preview.policyEnabled || fsBlocked);
  const hours = preview ? Math.round((preview.overtimeMinutes / 60) * 100) / 100 : 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary} data-testid="leave-credit-add">
          {t('addButton')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[95vw] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold text-foreground">{t('add.title')}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">{t('add.description')}</Dialog.Description>

          <form action={submitAction} onSubmit={() => setOpen(false)} className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('add.employee')}>
                <Combobox
                  name="employmentId"
                  value={employmentId}
                  options={employees.map((e) => ({ value: e.id, label: e.label }))}
                  placeholder={t('add.employeePlaceholder')}
                  searchPlaceholder={t('add.search')}
                  noResultsLabel={t('add.noResults')}
                  legacySuffix=""
                  onValueChange={setEmploymentId}
                />
              </Field>
              <Field label={t('add.leaveType')}>
                {/* Fixed on purpose: a Leave Credit is always Replacement Leave. Not posted — the service knows. */}
                <input value={t('add.leaveTypeValue')} readOnly disabled className={`${inputCls} bg-muted`} />
              </Field>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label={t('add.dateWorked')}>
                <input
                  type="date"
                  name="workedDate"
                  required
                  max={today}
                  value={workedDate}
                  onChange={(e) => setWorkedDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label={t('add.credit')}>
                {/* r334 · READ-ONLY on an ordinary working day, because the tier is measured rather than
                    chosen. `readOnly` (not `disabled`) is load-bearing: a disabled input posts NOTHING, and
                    `grantLeaveCredit` requires the amount — the form would fail its own validation instead
                    of submitting the figure it is showing. The server refuses a mismatch either way. */}
                <input
                  type="number"
                  name="days"
                  required
                  min={0.5}
                  max={366}
                  step={0.5}
                  value={days}
                  readOnly={pinnedDays != null}
                  onChange={(e) => setDays(e.target.value)}
                  onBlur={(e) => {
                    const next = normalizeDayText(e.currentTarget.value);
                    if (next !== e.currentTarget.value) setDays(next);
                  }}
                  className={pinnedDays != null ? `${inputCls} bg-muted` : inputCls}
                />
              </Field>
              <Field label={t('add.expiry')}>
                <input
                  type="date"
                  name="expiresOn"
                  min={workedDate || undefined}
                  value={expiresOn}
                  onChange={(e) => {
                    expiryTouched.current = true;
                    setExpiresOn(e.target.value);
                  }}
                  className={inputCls}
                />
              </Field>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">{t('add.expiryHint')}</p>

            {checking && !preview && <p className="text-xs text-muted-foreground">{t('add.checking')}</p>}
            {preview && (
              <div className="space-y-2" data-testid="leave-credit-preview">
                {preview.eligibleDay ? (
                  <p className="text-xs text-muted-foreground">
                    <span className="mr-1 inline-flex rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                      {kindLabel[preview.workedDayKind]}
                    </span>
                    {t('add.dayKind', { kind: kindLabel[preview.workedDayKind] })}
                  </p>
                ) : preview.workedDayKind === 'workday' && preview.extendedHoursEnabled ? (
                  /* r334 · the company DOES credit extended hours; this particular day simply did not run
                     long enough. A different sentence from "wrong kind of day", because the remedy is
                     different: there is nothing to fix on this form. */
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t('add.extendedShort', { minutes: preview.extendedHoursMinutes ?? 0 })}
                  </p>
                ) : (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t('add.workingDay')}
                  </p>
                )}
                {/* r334 · what the day earned and why, on the one screen that decides it. */}
                {preview.extendedHoursDays != null && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('add.extendedEarned', {
                      minutes: preview.extendedHoursMinutes ?? 0,
                      days: preview.extendedHoursDays,
                    })}
                  </p>
                )}
                {preview.alreadyCredited && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t('add.alreadyCredited')}
                  </p>
                )}
                {!preview.policyEnabled && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t('add.policyOff')}
                  </p>
                )}
                {preview.overtimeMinutes > 0 && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    {t('add.overtime', { hours })}
                  </p>
                )}
                {fsBlocked && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {t('add.firstScheduleBlocked')}
                  </p>
                )}
                {preview.firstSchedule && preview.allowFirstSchedule && (
                  <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-700 dark:bg-amber-950/40">
                    <p className="text-foreground">{t('add.firstScheduleConsent')}</p>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" name="firstScheduleConsent" value="1" required className="mt-0.5 h-4 w-4" />
                      <span className="font-medium text-foreground">{t('add.firstScheduleConsentLabel')}</span>
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('add.reason')}>
                <input name="reason" required maxLength={500} placeholder={t('add.reasonPlaceholder')} className={inputCls} />
              </Field>
              <Field label={t('add.remarks')}>
                <input name="remarks" maxLength={500} placeholder={t('add.remarksPlaceholder')} className={inputCls} />
              </Field>
            </div>

            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary">
                  {t('add.cancel')}
                </Button>
              </Dialog.Close>
              <button className={btnPrimary} disabled={blocked || !employmentId}>
                {t('add.submit')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
