'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DELEGATION_SCOPE,
  taskLabelKey,
  type DelegationTaskType,
} from '@/lib/delegation-scope';
import { inputCls } from '@/components/ui';

/**
 * R44 delegation (Phase 2) — progressive module→task scope picker + required reason. Shared by the command
 * bar quick modal and the /delegations forms. Submits plain form fields (no JS needed server-side):
 *   • `scopeModule` (0..n) — a checked module
 *   • `scopeTask`   (0..n) — a checked task (its module is implied by the task id, moduleOfTask)
 *   • `reason`      — required free text
 * The server action reconstructs scope rows: a checked module with no checked task = the WHOLE module; with
 * checked tasks = those tasks; ZERO modules checked = whole-scope (all approvals). Checking a module reveals
 * its tasks; unchecking hides + unmounts them (so they don't submit).
 */
export function DelegationScopePicker({
  defaultReason = '',
  defaultScopes = [],
}: {
  defaultReason?: string;
  defaultScopes?: { module: string; taskType: string | null }[];
}) {
  const t = useTranslations('delegations');
  const [openModules, setOpenModules] = useState<Set<string>>(
    () => new Set(defaultScopes.map((s) => s.module)),
  );
  const defaultTasks = new Set(defaultScopes.filter((s) => s.taskType).map((s) => s.taskType as string));

  const toggleModule = (module: string, checked: boolean) => {
    setOpenModules((prev) => {
      const next = new Set(prev);
      if (checked) next.add(module);
      else next.delete(module);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">{t('scopeTitle')}</span>
        <p className="text-xs text-muted-foreground">{t('scopeHint')}</p>
        <div className="space-y-2 rounded-md border border-border p-3">
          {DELEGATION_SCOPE.map(({ module, tasks }) => {
            const open = openModules.has(module);
            return (
              <div key={module}>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    name="scopeModule"
                    value={module}
                    checked={open}
                    onChange={(e) => toggleModule(module, e.target.checked)}
                    className="size-4 rounded border-input"
                  />
                  {t(`moduleLabel.${module}`)}
                </label>
                {open ? (
                  <div className="ml-6 mt-1.5 flex flex-col gap-1.5">
                    {tasks.map((task: DelegationTaskType) => (
                      <label key={task} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          name="scopeTask"
                          value={task}
                          defaultChecked={defaultTasks.has(task)}
                          className="size-4 rounded border-input"
                        />
                        {t(`taskLabel.${taskLabelKey[task]}`)}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t('reason')} <span className="text-red-500">*</span>
        </span>
        <textarea
          name="reason"
          required
          rows={2}
          defaultValue={defaultReason}
          placeholder={t('reasonPlaceholder')}
          className={inputCls + ' h-auto py-2'}
        />
      </label>
    </div>
  );
}
