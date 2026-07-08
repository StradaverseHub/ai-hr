'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { StepListEditor } from './step-list-editor';

type Labels = {
  enable: string;
  enableHint: string;
  chain: string;
  empty: string;
  manager: string;
  departmentHead: string;
  businessUnitHead: string;
  hr: string;
  hrManager: string;
  payroll: string;
  customRole: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  dragToReorder: string;
  save: string;
  // 4ec5a940 — optional "why the change was made" note surfaced in the audit trail.
  reason: string;
  reasonPlaceholder: string;
};

/** ADR-0039 2B-2 — the per-company approval chain editor. Levels are an ordered list the admin builds;
 *  the order IS the approval sequence. Submitted as a CSV in a hidden field (parsed server-side). The
 *  ordered-step UI (with 6fadb036 drag-and-drop) lives in the shared StepListEditor. */
export function LeaveApprovalEditor({
  companyId,
  action,
  initialEnabled,
  initialLevels,
  labels,
}: {
  companyId: string;
  action: (fd: FormData) => void | Promise<void>;
  initialEnabled: boolean;
  initialLevels: string[];
  labels: Labels;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [levels, setLevels] = useState<string[]>(initialLevels);

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="enabled" value={enabled ? '1' : '0'} />
      <input type="hidden" name="levels" value={levels.join(',')} />

      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span>
          <span className="font-medium">{labels.enable}</span>
          <span className="block text-xs text-muted-foreground">{labels.enableHint}</span>
        </span>
      </label>

      <StepListEditor levels={levels} setLevels={setLevels} labels={labels} disabled={!enabled} />

      {/* 4ec5a940 — optional "why the change was made" note; recorded on the audit event. */}
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-muted-foreground">{labels.reason}</span>
        <input
          name="reason"
          type="text"
          maxLength={500}
          placeholder={labels.reasonPlaceholder}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm"
        />
      </label>

      <Button type="submit" size="sm">
        {labels.save}
      </Button>
    </form>
  );
}
