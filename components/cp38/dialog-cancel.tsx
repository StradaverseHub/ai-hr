'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui';

/**
 * 038c304b rev 2 — Cancel beside Save in the employee Payroll tab's CP38 Add / Edit pop-up (the shared
 * components/family-form-dialog.tsx shell, whose Close (X) is already in its corner). It closes the pop-up and saves
 * nothing. It must be rendered inside that dialog: Dialog.Close reads the dialog it belongs to from React context, so
 * the server-rendered form can place it without the shell changing for the other Personnel sections.
 */
export function Cp38DialogCancel({ label }: { label: string }) {
  return (
    <Dialog.Close asChild>
      <Button type="button" variant="outline" data-cp38-cancel="">
        {label}
      </Button>
    </Dialog.Close>
  );
}
