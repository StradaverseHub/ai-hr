'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { btnPrimary } from '../ui';
import { Combobox } from '../ui/combobox';
import type { ExtendedHoursTiers } from '@/lib/extended-hours';
import { LeaveCreditRequestTable, type LeaveCreditDayFacts, type LeaveCreditLeaveTypeView } from './leave-credit-request-table';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * What the server answers once HR picks an employee. Declared STRUCTURALLY rather than imported from the
 * leave engine: a client widget importing a core leave module is pack drift (test/leave-pack-drift), and only
 * the shape crosses the boundary. Mirrors core/toil.ts `LeaveCreditGrantContext`.
 */
export type LeaveCreditGrantContextView = {
  tiers: ExtendedHoursTiers;
  ordinaryDayAllowed: boolean;
  policyEnabled: boolean;
  firstSchedule: boolean;
  allowFirstSchedule: boolean;
  ownRecord: boolean;
};

/**
 * r406 952129bb · + ADD LEAVE CREDIT — THE EMPLOYEE'S LEAVE CREDIT FORM, PLUS AN EMPLOYEE PICKER.
 *
 * It replaces components/leave/leave-credit-add-dialog.tsx (one date, a typed number of days, a typed expiry
 * and a Remarks box), which worked the credit out a different way from the employee's form — the same day
 * worked could be credited differently depending on who entered it. The body here IS
 * `LeaveCreditRequestTable`, the component My Leave mounts, in its HR mode: the same rows, Day Type from the
 * roster, Start/End time, Eligible hours, Credit, "+ Add date", the day-by-day details, Reason and the total.
 * A change to that form now reaches this one because there is only one.
 *
 * WHAT HR MODE ADDS: the Employee box (the rows stay closed until it is filled, and the table is REMOUNTED
 * per employee so no fact, row or credit from one person is ever shown against another), that employee's own
 * company tiers fetched after the pick, ⚠️ a per-row note when the date already has overtime recorded (it will
 * not also be paid once credited), "Add credit" for "Send to manager", and the shell's refusals: HR's own
 * record, the company policy switched off, and a First-Schedule employee whose company does not allow it.
 *
 * RETIRED, NOT DELETED (CLAUDE.md §8): the old dialog's `admin.leaveCredit.add.*` keys this form does not render
 * — `description`, `leaveType`, `dateWorked`, `credit`, `expiry`, `expiryHint`, `remarks`, `remarksPlaceholder`,
 * `reason`, `reasonPlaceholder`, `checking`, `dayKind`, `workingDay`, `extendedShort`, `extendedEarned` — stay in
 * all six catalogues. `leaveTypeValue` is still read by the page as the fallback leave-type name.
 *
 * NOT THE CONTROL. `grantLeaveCreditRows` re-derives every row and refuses everything shown here; this only
 * stops HR filling in a form the save would refuse. Copy comes from `useTranslations` inside this client
 * component; every prop is serialisable except the server actions (test/server-client-boundary.test.ts).
 */
export function LeaveCreditGrantDialog({
  employees,
  today,
  replacementType,
  submitAction,
  contextAction,
  dayFactsAction,
}: {
  employees: { id: string; label: string }[];
  /** Today in the tenant's zone: the latest selectable date worked. */
  today: string;
  replacementType: LeaveCreditLeaveTypeView;
  submitAction: Action;
  contextAction: (employmentId: string) => Promise<LeaveCreditGrantContextView | null>;
  dayFactsAction: (workedDate: string, employmentId?: string) => Promise<LeaveCreditDayFacts | null>;
}) {
  const t = useTranslations('admin.leaveCredit');
  const [open, setOpen] = useState(false);
  const [employmentId, setEmploymentId] = useState('');
  const [context, setContext] = useState<LeaveCreditGrantContextView | null>(null);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    const mine = ++req.current;
    setContext(null);
    if (!employmentId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void contextAction(employmentId)
      .then((c) => {
        if (mine === req.current) setContext(c);
      })
      .catch(() => {
        if (mine === req.current) setContext(null);
      })
      .finally(() => {
        if (mine === req.current) setLoading(false);
      });
  }, [employmentId, contextAction]);

  // The rows open only once the employee's own context has arrived: their tiers decide every credit shown.
  const subject = employmentId !== '' && context != null ? employmentId : '';
  const fsBlocked = context != null && context.firstSchedule && !context.allowFirstSchedule;
  const refusal =
    context == null
      ? null
      : context.ownRecord
        ? t('add.ownRecord')
        : !context.policyEnabled
          ? t('add.policyOff')
          : fsBlocked
            ? t('add.firstScheduleBlocked')
            : null;

  const picker = (
    <div className="mt-3 max-w-md space-y-1" data-testid="leave-credit-employee-picker">
      <span className="block text-xs font-medium text-muted-foreground">{t('add.employee')}</span>
      <Combobox
        value={employmentId}
        options={employees.map((e) => ({ value: e.id, label: e.label }))}
        placeholder={t('add.employeePlaceholder')}
        searchPlaceholder={t('add.search')}
        noResultsLabel={t('add.noResults')}
        legacySuffix=""
        onValueChange={setEmploymentId}
      />
      {loading && <p className="text-xs text-muted-foreground">{t('add.checkingEmployee')}</p>}
      {refusal && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="leave-credit-grant-refusal">
          {refusal}
        </p>
      )}
      {context != null && context.firstSchedule && context.allowFirstSchedule && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {t('add.firstScheduleConsent')}
        </p>
      )}
    </div>
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className={btnPrimary} data-testid="leave-credit-add">
          {t('addButton')}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          data-testid="leave-credit-grant-dialog"
          className="fixed left-1/2 top-[5vh] z-50 max-h-[90vh] w-[90vw] max-w-[1080px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        >
          <LeaveCreditRequestTable
            // A new employee is a new form: no row, fact or credit carries across people.
            key={subject || 'none'}
            dialog
            header={
              <>
                <div className="flex items-start justify-between gap-3">
                  <Dialog.Title className="text-base font-semibold text-foreground">{t('add.title')}</Dialog.Title>
                  <Dialog.Close asChild>
                    <button type="button" aria-label={t('add.cancel')} className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-lg">
                      ×
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="mt-2 text-xs text-muted-foreground" data-testid="leave-credit-dialog-description">
                  {t('add.descriptionRows')}
                </Dialog.Description>
                {picker}
              </>
            }
            cancel={
              <Dialog.Close asChild>
                <button type="button" className="min-h-11 rounded-md border border-border px-3 text-sm">
                  {t('add.cancel')}
                </button>
              </Dialog.Close>
            }
            replacementType={replacementType}
            submitAction={submitAction}
            today={today}
            requiresFirstScheduleConsent={context != null && context.firstSchedule && context.allowFirstSchedule}
            dayFactsAction={dayFactsAction}
            tiers={context?.tiers ?? null}
            ordinaryDayAllowed={context?.ordinaryDayAllowed ?? false}
            onSubmitted={() => setOpen(false)}
            hr={{
              employmentId: subject,
              help: t('add.help'),
              submitLabel: t('add.submit'),
              consentLabel: t('add.firstScheduleConsentLabel'),
              pickEmployeeFirst: t('add.pickEmployeeFirst'),
              alreadyCredited: t('add.alreadyCredited'),
              overtimeNote: (minutes) => t('add.overtime', { hours: Math.round((minutes / 60) * 100) / 100 }),
              blocked: refusal != null,
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
