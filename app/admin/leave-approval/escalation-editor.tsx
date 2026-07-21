'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

export type EscalationLabels = {
  title: string;
  hint: string;
  enable: string;
  escalateAfter: string;
  workingDaysUnit: string;
  level: string;
  nextLevel: string;
  specificRole: string;
  role: string;
  /** Static line naming the notification bell as the delivery channel — deliberately NOT a method
   *  picker with one greyed-out option (it would say nothing this line does not). */
  notifyNote: string;
  save: string;
  reason: string;
  reasonPlaceholder: string;
  /** LEVEL_KINDS value → display label, reusing the chain editor's level labels. */
  roleLabels: Record<string, string>;
};

/** R51 722904dc — per-company Approval Escalation Settings (below the chain rules on the Approval
 *  Workflow tab). Its own form + server action, deliberately NOT folded into the rule-matrix editor:
 *  coupling two independent forms gains nothing. Follows editor.tsx's idioms — controlled enable
 *  checkbox driving `disabled` on the dependent fields, hidden fields carrying state into the
 *  server-action post, and the 4ec5a940 optional reason input. */
export function LeaveEscalationEditor({
  companyId,
  action,
  initial,
  labels,
}: {
  companyId: string;
  action: (fd: FormData) => void | Promise<void>;
  initial: {
    enabled: boolean;
    escalateAfterDays: number | null;
    target: 'next_level' | 'specific_role';
    targetRole: string | null;
  };
  labels: EscalationLabels;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [target, setTarget] = useState<'next_level' | 'specific_role'>(initial.target);
  const roleKinds = Object.keys(labels.roleLabels);

  return (
    <form action={action} className="space-y-4 border-t border-border p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="enabled" value={enabled ? '1' : '0'} />
      <input type="hidden" name="target" value={target} />

      <div>
        <h3 className="text-sm font-medium">{labels.title}</h3>
        <p className="text-xs text-muted-foreground">{labels.hint}</p>
      </div>

      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border"
        />
        <span className="font-medium">{labels.enable}</span>
      </label>

      <label className="block text-xs">
        <span className="mb-1 block font-medium text-muted-foreground">{labels.escalateAfter}</span>
        <span className="flex items-center gap-2">
          <input
            name="escalateAfterDays"
            type="number"
            min={1}
            max={90}
            step={1}
            defaultValue={initial.escalateAfterDays ?? ''}
            disabled={!enabled}
            className="w-24 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
          />
          <span className="text-muted-foreground">{labels.workingDaysUnit}</span>
        </span>
      </label>

      <fieldset className="space-y-1.5 text-sm" disabled={!enabled}>
        <legend className="mb-1 block text-xs font-medium text-muted-foreground">{labels.level}</legend>
        <label className={`flex items-center gap-2 ${enabled ? '' : 'opacity-50'}`}>
          <input
            type="radio"
            name="targetRadio"
            checked={target === 'next_level'}
            onChange={() => setTarget('next_level')}
            className="h-4 w-4 border-border"
          />
          <span>{labels.nextLevel}</span>
        </label>
        <label className={`flex items-center gap-2 ${enabled ? '' : 'opacity-50'}`}>
          <input
            type="radio"
            name="targetRadio"
            checked={target === 'specific_role'}
            onChange={() => setTarget('specific_role')}
            className="h-4 w-4 border-border"
          />
          <span>{labels.specificRole}</span>
        </label>
      </fieldset>

      <label className="block text-xs">
        <span className="mb-1 block font-medium text-muted-foreground">{labels.role}</span>
        <select
          name="targetRole"
          defaultValue={initial.targetRole ?? roleKinds[0] ?? ''}
          disabled={!enabled || target !== 'specific_role'}
          className="w-56 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm disabled:opacity-50"
        >
          {roleKinds.map((k) => (
            <option key={k} value={k}>
              {labels.roleLabels[k]}
            </option>
          ))}
        </select>
      </label>

      <p className="text-xs text-muted-foreground">{labels.notifyNote}</p>

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
