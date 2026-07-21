'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DELEGATION_SCOPE,
  DELEGATION_SCOPE_GROUPS,
  taskLabelKey,
  type DelegationTaskType,
} from '@/lib/delegation-scope';
import { inputCls } from '@/components/ui';

/**
 * R44 delegation (Phase 2) — progressive module→task scope picker + required reason. Shared by the command
 * bar quick modal and the /delegations forms. Submits plain form fields (no JS needed server-side):
 *   • `scopeModule` (0..n) — a checked module
 *   • `scopeTask`   (0..n) — a checked task (its module is implied by the task id, moduleOfTask)
 *   • `scopeGroup`  (0..n) — a checked expandable GROUP (R51 20f09fc3). Transient: the server expands a
 *                    group to its leaf tasks at save time (expandScopeTasks); group ids are never stored.
 *   • `reason`      — required free text
 * The server action reconstructs scope rows: a checked module with no checked task = the WHOLE module; with
 * checked tasks = those tasks; ZERO modules checked = whole-scope (all approvals). Checking a module reveals
 * its tasks; unchecking hides + unmounts them (so they don't submit). A checked group reveals its sub-tasks
 * (unticked — expand-then-choose, per the reporter's sketch); a bare group covers ALL its sub-tasks.
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
  // Edit reconstruction: a group renders open+checked when any of its LEAVES is stored (only leaves are
  // ever stored, so this is the complete rule — no stored-group case exists).
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const open = new Set<string>();
    for (const groups of Object.values(DELEGATION_SCOPE_GROUPS)) {
      for (const g of groups ?? []) {
        if (g.leaves.some((leaf) => defaultTasks.has(leaf))) open.add(g.id);
      }
    }
    return open;
  });

  const toggleModule = (module: string, checked: boolean) => {
    setOpenModules((prev) => {
      const next = new Set(prev);
      if (checked) next.add(module);
      else next.delete(module);
      return next;
    });
  };

  const toggleGroup = (groupId: string, checked: boolean) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (checked) next.add(groupId);
      else next.delete(groupId);
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
                    {(DELEGATION_SCOPE_GROUPS[module] ?? []).map((group) => {
                      const groupOpen = openGroups.has(group.id);
                      return (
                        <div key={group.id}>
                          <label className="flex items-center gap-2 text-sm text-muted-foreground">
                            <input
                              type="checkbox"
                              name="scopeGroup"
                              value={group.id}
                              checked={groupOpen}
                              onChange={(e) => toggleGroup(group.id, e.target.checked)}
                              className="size-4 rounded border-input"
                            />
                            {t(`groupLabel.${group.labelKey}`)}
                          </label>
                          {groupOpen ? (
                            <div className="ml-6 mt-1.5 flex flex-col gap-1.5">
                              {group.leaves.map((task) => (
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
