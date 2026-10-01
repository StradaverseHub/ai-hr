'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { btnPrimary } from '../ui';
import type { ExtendedHoursTiers } from '@/lib/extended-hours';
import { LeaveCreditRequestTable, type LeaveCreditDayFacts } from './leave-credit-request-table';

type Action = (fd: FormData) => void | Promise<void>;

/**
 * 2a237f5f — ONE type, not a list, and the singular is the fix.
 *
 * This used to be `ReplacementLeaveTypeOption[]`, mapped from every leave type the employee was eligible
 * for and rendered as a `<select>`. There is no list to offer: a Leave Credit is always Replacement Leave
 * (see the leave-type field the table draws). Taking the plural away is what makes "no other type can be
 * offered" a property of the component rather than a promise about its caller — with no array in hand it has
 * nothing else it could draw.
 *
 * `name`, not `label`: it is the TENANT's own name for their replacement type, resolved from their
 * catalogue and localized by the page's `listLeaveTypes(locale)` read — not a translated constant, so a
 * customer whose type is called "Off in Lieu" reads "Off in Lieu".
 */
export type ReplacementLeaveTypeView = { id: string; name: string };

/**
 * "+ Leave Credit request" — the employee's own claim for time already worked. THE ONLY EMPLOYEE ENTRY
 * POINT, and since r343's fix pass it is a SHELL: the trigger, the dialog frame and the two sentences that
 * say what a Leave Credit is. Everything inside it is `LeaveCreditRequestTable`.
 *
 * ── ⚠️ r343 FIX PASS — WHAT THIS FILE USED TO BE, AND WHY IT IS NOT THAT ANY MORE ───────────────────────
 * This was r336's TWO-SECTION form: Section A for a rest day / off day / public holiday that was worked,
 * Section B for extended hours past the shift end of an ordinary working day, each with its own rows, its
 * own "+ Add date" and its own total, and with the day type READ-ONLY beside each date. The reporter's
 * contest on cbfa8b0b reverses that design in as many words — "Do not create separate sections/screens for
 * these day types. All four types must be submitted from the same screen and displayed in the same request
 * table" — and makes the day type a four-option INPUT.
 *
 * r343's first cut built the single table as a NEW screen at `/leave/credit` and left this dialog mounted on
 * My Absence. That shipped two ways to ask for the same credit, and the prominent one was the design the
 * reporter had just rejected: the employee would have found the OLD form (CLAUDE.md §1 — duplicate concepts
 * and competing surfaces). So the BODY of this dialog is now the single table and the TRIGGER is untouched:
 * the button the employee already knows, in the place they already know, opening the form they asked for.
 *
 * ── ONE COMPONENT, TWO ENTRY POINTS, AND NOT ONE LINE OF IT COPIED ──────────────────────────────────────
 * `/leave/credit` renders the SAME `LeaveCreditRequestTable` — the same file, imported, never a second copy
 * — and adds beneath it the list of requests already submitted, which is the other half of the contest ("…
 * and displayed in the same request table") and does not belong inside a dialog. Submitting from here
 * redirects to that screen with the toast, so the employee lands where their new request is listed. There is
 * one form component, one service (`submitLeaveCreditRequest`) and one set of posted field names; a change
 * to the form cannot land on one surface and miss the other.
 *
 * WHY THE SHELL IS STILL A DIALOG. The trigger sits in the My Absence header beside "+ Request Leave", and
 * that pairing is r296's: one asks to TAKE time, the other to be CREDITED for time worked. Turning the
 * button into a link would have moved the employee off the page they were reading to find out whether the
 * claim is even worth making.
 *
 * All copy comes from `useTranslations` INSIDE this client component — the house pattern for client widgets,
 * and the one that structurally cannot hit the server→client function-prop hazard, because no translator
 * ever crosses the boundary.
 */
export function ReplacementLeaveRequestDialog({
  replacementType,
  submitAction,
  today,
  requiresFirstScheduleConsent,
  dayFactsAction,
  tiers,
  ordinaryDayAllowed,
}: {
  /**
   * 2a237f5f — the tenant's Replacement Leave type, already resolved by the page. Required and singular:
   * the page renders no dialog at all when the tenant has none, so there is no "nothing selected" state.
   */
  replacementType: ReplacementLeaveTypeView;
  submitAction: Action;
  /**
   * r343 — resolves one date's ROSTER kind and its two Attendance times, for the signed-in employee. It
   * answers for every row, not only the ordinary-day ones: the roster kind is what the chosen Day Type is
   * adjudicated against, and that adjudication is the contest's new validation.
   */
  dayFactsAction: (workedDate: string) => Promise<LeaveCreditDayFacts | null>;
  /**
   * The company's tier figures. NULL when extended hours are not switched on — which is every company at
   * release. The Day Type dropdown still offers all four options then (r343 fix pass); what null changes is
   * that an Ordinary Day row says it cannot earn a credit and blocks the submit.
   */
  /** r358 — the ladder applies to every day type; the switch below governs the ordinary one only. */
  tiers: ExtendedHoursTiers | null;
  ordinaryDayAllowed: boolean;
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
        <Dialog.Content
          data-testid="leave-credit-request-dialog"
          className="fixed left-1/2 top-[5vh] z-50 max-h-[90vh] w-[90vw] max-w-[1080px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        >
            <LeaveCreditRequestTable
              dialog
              header={<><div className="flex items-start justify-between gap-3"><Dialog.Title className="text-base font-semibold text-foreground">{t('title')}</Dialog.Title><Dialog.Close asChild><button type="button" aria-label={t('cancel')} className="flex size-11 shrink-0 items-center justify-center rounded-md border border-border text-lg">×</button></Dialog.Close></div><Dialog.Description className="mt-2 text-xs text-muted-foreground" data-testid="leave-credit-dialog-description">{t('description')}</Dialog.Description></>}
              cancel={<Dialog.Close asChild><button type="button" className="min-h-11 rounded-md border border-border px-3 text-sm">{t('cancel')}</button></Dialog.Close>}
              replacementType={replacementType}
              submitAction={submitAction}
              today={today}
              requiresFirstScheduleConsent={requiresFirstScheduleConsent}
              dayFactsAction={dayFactsAction}
              tiers={tiers}
              ordinaryDayAllowed={ordinaryDayAllowed}
              // The dialog closes as the submission leaves; the action redirects to /leave/credit, where the
              // new request is listed. A modal still standing over that navigation is the defect.
              onSubmitted={() => setOpen(false)}
            />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
