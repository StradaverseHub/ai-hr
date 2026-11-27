'use client';

/**
 * Board 2c1b2fba — THE SHAPE EVERY DRAFT REGISTER SHARES: one Add / Edit / View dialog and an inline
 * Delete confirmation, for the three lists this item put on the draft (emergency contacts, pay items,
 * qualifications). It is the Family tab's pattern (family-step.tsx) lifted out once, because three copies
 * of a dialog are three places for focus, close and read-only behaviour to drift.
 *
 * NOTHING HERE KNOWS A WORD OF ANY LANGUAGE: every caption arrives pre-translated from the register that
 * renders it, so each register keeps its own single translation namespace (the record's own strings).
 *
 * A draft's registers are CLIENT STATE until Save draft: removal is immediate and local, and View is the
 * SAME fields inside a disabled fieldset — the record's own "View can never drift from Edit" rule.
 */

import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui';

export type RegisterEditing<T> = { at: number | null; draft: T; readOnly: boolean };

export function RegisterDialog<T>({
  editing,
  title,
  closeLabel,
  cancelLabel,
  commitLabel,
  onClose,
  onCommit,
  children,
}: {
  editing: RegisterEditing<T> | null;
  title: string;
  closeLabel: string;
  cancelLabel: string;
  commitLabel: string;
  onClose: () => void;
  onCommit: () => void;
  /** The entry's fields. Rendered inside a fieldset that is disabled when the dialog is a View. */
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="sm" aria-label={closeLabel}>
                ✕
              </Button>
            </Dialog.Close>
          </div>
          {editing && (
            <div className="mt-4 space-y-4">
              <fieldset disabled={editing.readOnly} className="min-w-0 border-0 p-0">
                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">{children}</div>
              </fieldset>
              {!editing.readOnly && (
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={onClose}>
                    {cancelLabel}
                  </Button>
                  <Button type="button" onClick={onCommit}>
                    {commitLabel}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** View / Edit / Delete for one row; Delete asks inline (a modal over a modal-less list would be heavier
 *  than what it guards — the Family tab's reasoning). */
export function RegisterRowActions({
  labels,
  onView,
  onEdit,
  onDelete,
}: {
  labels: { view: string; edit: string; delete: string; confirm: string; yes: string; no: string };
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center justify-end gap-2">
      <Button type="button" size="sm" variant="outline" onClick={onView}>
        {labels.view}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={onEdit}>
        {labels.edit}
      </Button>
      {confirming ? (
        <span className="inline-flex items-center gap-2 text-xs">
          {labels.confirm}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            {labels.yes}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
            {labels.no}
          </Button>
        </span>
      ) : (
        <Button type="button" size="sm" variant="destructive" onClick={() => setConfirming(true)}>
          {labels.delete}
        </Button>
      )}
    </div>
  );
}

/** A UI-only row key, the family member rule (`key` never reaches a writer). */
export const newRowKey = (n: number) => `${Date.now()}-${n}`;
