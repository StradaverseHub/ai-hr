'use client';

import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '@/components/ui/button';
import { setMovementEventTypeActiveAction, setTerminationReasonActiveAction } from './actions';

/**
 * 1d58019a — Delete on a row that cannot be deleted EXPLAINS why, instead of being missing.
 *
 * Before this item the Delete button simply did not render on a built-in type or a type already used by
 * recorded movements, so nobody was told why it was absent. Now every row has Delete. For a row the service
 * would refuse (built-in, or referenced by history) it opens THIS dialog: the reason in plain words, and the
 * one thing that does work — Switch Off — as the primary action. A deletable row (one of the organisation's
 * own, never used) keeps the ordinary ConfirmSubmit delete on the page; this island never deletes anything.
 *
 * The page decides which rows get this; the service refusals in core/movement-type.ts and core/termination-
 * reason-catalog.ts stay authoritative either way.
 *
 * Shared by both tabs: `target` picks the switch-off action (event type or termination reason). The two
 * actions are imported here rather than passed in, because a server component may hand a client component
 * serialisable props only (test/server-client-boundary.test.ts). Every string arrives translated.
 *
 * Styled as the house confirmation dialog (components/ui/confirm-submit.tsx): the same Radix AlertDialog,
 * overlay and card. It is not that component because the explanation is two paragraphs and, for a row that
 * is already switched off, has no action to offer at all.
 */
export function DeleteExplanation({
  target,
  code,
  triggerLabel,
  title,
  paragraphs,
  closeLabel,
  switchOffLabel,
}: {
  target: 'type' | 'reason';
  code: string;
  triggerLabel: string;
  title: string;
  paragraphs: string[];
  closeLabel: string;
  /** null when the row is already switched off: the dialog then only explains. */
  switchOffLabel: string | null;
}) {
  const action = target === 'type' ? setMovementEventTypeActiveAction : setTerminationReasonActiveAction;
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs font-medium text-destructive hover:bg-transparent hover:underline"
        >
          {triggerLabel}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-1.5 space-y-2 text-sm text-muted-foreground">
              {paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </AlertDialog.Description>
          {/* The form lives INSIDE the portalled content, so it owns its own fields and submit button. */}
          <form action={action} className="mt-5 flex justify-end gap-2">
            <input type="hidden" name="code" value={code} />
            <input type="hidden" name="active" value="false" />
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="outline" size="sm">
                {closeLabel}
              </Button>
            </AlertDialog.Cancel>
            {switchOffLabel && (
              <Button type="submit" variant="default" size="sm">
                {switchOffLabel}
              </Button>
            )}
          </form>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
