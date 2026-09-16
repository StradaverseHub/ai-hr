'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { StepListEditor, type StepListLabels } from './step-list-editor';

/** r293 — intersect the shared step-editor bag rather than re-listing its fields (see RuleBuilderLabels). */
type Labels = StepListLabels & {
  save: string;
  // 4ec5a940 — optional "why the change was made" note surfaced in the audit trail.
  reason: string;
  reasonPlaceholder: string;
};

/** ADR-0039 2B-2 — the per-company approval chain editor. Levels are an ordered list the admin builds;
 *  the order IS the approval sequence. Submitted as a CSV in a hidden field (parsed server-side). The
 *  ordered-step UI (with 6fadb036 drag-and-drop) lives in the shared StepListEditor.
 *
 *  r79 0322 — the "Require multi-step approval" checkbox is GONE. The chain's own LENGTH is the answer:
 *  one level is single-approver, two or more is a chain (core/leave.ts isMultiStepChain). A checkbox that
 *  could disagree with the chain beside it was the whole defect. */
export function LeaveApprovalEditor({
  companyId,
  action,
  initialLevels,
  labels,
}: {
  companyId: string;
  action: (fd: FormData) => void | Promise<void>;
  initialLevels: string[];
  labels: Labels;
}) {
  const [levels, setLevels] = useState<string[]>(initialLevels);

  return (
    <form action={action} className="space-y-4 p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="levels" value={levels.join(',')} />

      <StepListEditor levels={levels} setLevels={setLevels} labels={labels} />

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
