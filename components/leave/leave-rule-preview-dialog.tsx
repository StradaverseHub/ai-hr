'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Eye } from 'lucide-react';
import { Button } from '../ui';
import {
  LeaveRulePreview,
  type PreviewLeaveTypeOption,
  type PreviewCompanyOption,
  type PreviewGradeOption,
  type PreviewPolicyRow,
} from '../leave-rule-preview';

/**
 * Preview Scenario dialog (R61 · feedback d778d2d3). The "Preview a scenario" checker lost its
 * standalone section on the Entitlements page: this compact "Preview Scenario" button now sits in
 * the PageHeader actions cluster (next to + Import and Run Accrual) and opens the SAME
 * LeaveRulePreview — leave type / company / grade / service-years inputs feeding the exact shared
 * resolver — inside a pop-up. The component is wrapped unchanged: it is read-only, purely local
 * state, no <form> and no server action, so nothing about the portal affects it. Structure mirrors
 * leave-year-edit-dialog.tsx (Dialog.Root + useState open, Radix portal).
 *
 * The trigger Button MUST be type="button" — the header cluster may sit inside other layouts and a
 * default-type button could submit an enclosing form.
 */
export function LeaveRulePreviewDialog({
  leaveTypes,
  companies,
  grades,
  policies,
}: {
  leaveTypes: PreviewLeaveTypeOption[];
  companies: PreviewCompanyOption[];
  grades: PreviewGradeOption[];
  policies: PreviewPolicyRow[];
}) {
  const t = useTranslations('admin.leave');
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" className="gap-1.5">
          <Eye className="size-3.5" />
          {t('previewScenarioAction')}
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-lg">
          <Dialog.Title className="text-base font-semibold">{t('previewTitle')}</Dialog.Title>
          <div className="mt-3">
            <LeaveRulePreview
              leaveTypes={leaveTypes}
              companies={companies}
              grades={grades}
              policies={policies}
            />
          </div>
          <div className="flex justify-end pt-3">
            <Dialog.Close asChild>
              <Button type="button" size="sm" variant="outline">
                {t('close')}
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
