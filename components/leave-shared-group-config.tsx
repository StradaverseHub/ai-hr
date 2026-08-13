'use client';

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, btnPrimary, inputCls } from '@/components/ui';
import { ChipMultiSelect } from '@/components/ui/chip-multi-select';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { ESS_PLACEMENTS, SHARED_GROUP_DEFAULT_PLACEMENT, type EssPlacement } from '@/lib/leave-groups';

/**
 * SHARED LEAVE GROUPS — the LEAVE TYPE level configuration surface (r88, feedback 1ef1cf95).
 *
 * A shared leave group is several leave types drawing on ONE pooled allowance: a name, a shared annual
 * limit, an optional maximum per application, and a tick list of the member leave types. "Special Leave,
 * 10 days shared, at most 3 days per application, covering these seven types" is the whole idea.
 *
 * WHERE IT LIVES AND WHY. Beside Add Leave Type, in the leave-type workspace's left panel — because that is
 * the level the group is defined AT. Until r88 it was created INSIDE a Benefit Scheme: you picked a scheme
 * first, and the same shared rule had to be recreated in every scheme it applied to. The reporter rejected
 * improving that selector ("I don't want to improve the existing Benefit Scheme selector") and asked for
 * this shape instead. There is deliberately no scheme picker on this screen — a group is tenant-wide.
 *
 * ONE GROUP PER LEAVE TYPE. The database enforces it (unique on (tenant, leave_type), migration 0342); the
 * core layer turns a clash into a named sentence — "Marriage Leave is already in Special Leave" — rather
 * than silently moving the type or surfacing a constraint violation. This component does not re-implement
 * that check: it posts, and renders whatever the action says. Duplicating the rule here is how the screen
 * and the engine start disagreeing.
 *
 * PRESENTATION ONLY. Every write goes to the same three server actions the page binds; nothing about the
 * ENFORCEMENT moved — the group's two rules are still applied at apply time and again at approval
 * (enforceSharedLeaveGroupLimit, core/leave.ts). This screen only says what the group IS.
 *
 * FORM SHAPE NOTE: `maxDaysPerApplication` is NOT tri-state. The update action reads it from the posted form
 * every time, so the edit form must always carry the input (an empty box is the real answer "no cap", which
 * is why the action maps '' to null rather than to Number('') === 0). Dropping the field from a form would
 * silently clear the cap on every save. `essPlacement` (46afcc48) follows the same absolute-set rule and is
 * a <select> for the same reason the placement control on the leave type is: it always submits a value, so
 * there is no "unticked box reads as true" hazard to fall into (trap 17), and Hidden is a REAL choice the
 * admin can make rather than the absence of one.
 *
 * WHERE THE GROUP IS DRAWN (46afcc48) is a property OF THE GROUP and is independent of every member type's
 * own placement. Showing the group Primary while every member is Hidden is a supported, sensible setup —
 * the pot at the top, the six types it covers not listed individually — and it changes neither the pot's
 * figure nor what may be applied for.
 */
export type SharedGroup = {
  id: string;
  name: string;
  totalLimitDays: number;
  /** null = no per-application cap. */
  maxDaysPerApplication: number | null;
  /** 46afcc48 — 'primary' | 'secondary' | 'hidden'. Existing groups read 'hidden' (the column DEFAULT). */
  essPlacement: EssPlacement;
  leaveTypeIds: string[];
};

type SharedGroupActions = {
  create: (fd: FormData) => void | Promise<void>;
  update: (fd: FormData) => void | Promise<void>;
  remove: (fd: FormData) => void | Promise<void>;
};

export function LeaveSharedGroupConfig({
  groups,
  leaveTypes,
  actions,
}: {
  groups: SharedGroup[];
  leaveTypes: { id: string; name: string }[];
  actions: SharedGroupActions;
}) {
  const t = useTranslations('admin.leave.sharedGroup');
  const [open, setOpen] = useState(false);
  const typeOptions = leaveTypes.map((lt) => ({ value: lt.id, label: lt.name }));
  const nameById = new Map(leaveTypes.map((lt) => [lt.id, lt.name]));

  // The tick list is shared by the create and every edit form, so its translated copy is built once.
  const chipCopy = {
    options: typeOptions,
    addPlaceholder: t('membersPlaceholder'),
    removeLabelFor: (label: string) => t('memberRemove', { type: label }),
    label: t('membersLabel'),
    selectAllLabel: t('membersSelectAll'),
    clearAllLabel: t('membersClearAll'),
    countLabelFor: (count: number) => t('membersCount', { count }),
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
        {t('manage')}
        {groups.length > 0 && (
          <Badge className="ml-2">{groups.length}</Badge>
        )}
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-base font-semibold">{t('title')}</Dialog.Title>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm" aria-label={t('close')}>
                  ✕
                </Button>
              </Dialog.Close>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t('help')}</p>

            {/* ── Existing groups ─────────────────────────────────────────────────────────────────── */}
            <div className="mt-5 space-y-4">
              {groups.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
              {groups.map((g) => (
                <div key={g.id} className="rounded-md border border-border p-3">
                  <form action={actions.update} className="space-y-3">
                    <input type="hidden" name="id" value={g.id} />
                    <div className="grid gap-3 sm:grid-cols-3">
                      <Field label={t('nameLabel')} className="sm:col-span-3" required requiredAriaLabel={t('required')}>
                        <input name="name" defaultValue={g.name} required className={inputCls} />
                      </Field>
                      <Field label={t('totalLimitLabel')} required requiredAriaLabel={t('required')}>
                        <input
                          name="totalLimitDays"
                          type="number"
                          step="0.5"
                          min="0.5"
                          defaultValue={g.totalLimitDays}
                          required
                          className={inputCls}
                        />
                      </Field>
                      <Field label={t('maxPerApplicationLabel')}>
                        <input
                          name="maxDaysPerApplication"
                          type="number"
                          step="0.5"
                          min="0.5"
                          defaultValue={g.maxDaysPerApplication ?? ''}
                          placeholder={t('maxPerApplicationBlank')}
                          className={inputCls}
                        />
                      </Field>
                      {/* 46afcc48 — where the employee sees this GROUP. Independent of every member type's
                          own placement, which stays on the leave type where it already is. */}
                      <Field label={t('placementLabel')}>
                        <select name="essPlacement" defaultValue={g.essPlacement} className={inputCls}>
                          {ESS_PLACEMENTS.map((pl) => (
                            <option key={pl} value={pl}>
                              {t(`placementOption.${pl}`)}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('placementHelp')}</p>
                    {/* Emits one hidden input per ticked id under this name — see ChipMultiSelect's form
                        contract. The action reads formData.getAll('leaveTypeIds'). */}
                    <ChipMultiSelect name="leaveTypeIds" defaultSelected={g.leaveTypeIds} {...chipCopy} />
                    <div className="flex items-center justify-end gap-2">
                      <button type="submit" className={btnPrimary}>
                        {t('save')}
                      </button>
                    </div>
                  </form>
                  {/* Delete is its own form: a <form> may not nest inside another. */}
                  <form action={actions.remove} className="mt-2 flex justify-end">
                    <input type="hidden" name="id" value={g.id} />
                    <ConfirmSubmit
                      variant="ghost"
                      size="sm"
                      title={t('deleteConfirmTitle')}
                      subtitle={g.name}
                      description={t('deleteConfirmDescription')}
                      confirmLabel={t('delete')}
                    >
                      {t('delete')}
                    </ConfirmSubmit>
                  </form>
                  {g.leaveTypeIds.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('membersSummary', {
                        types: g.leaveTypeIds.map((id) => nameById.get(id) ?? '—').join(', '),
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* ── Create ──────────────────────────────────────────────────────────────────────────── */}
            <form action={actions.create} className="mt-6 space-y-3 rounded-md border border-dashed border-border p-3">
              <p className="text-sm font-medium">{t('createTitle')}</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t('nameLabel')} className="sm:col-span-3" required requiredAriaLabel={t('required')}>
                  <input name="name" required placeholder={t('namePlaceholder')} className={inputCls} />
                </Field>
                <Field label={t('totalLimitLabel')} required requiredAriaLabel={t('required')}>
                  <input name="totalLimitDays" type="number" step="0.5" min="0.5" required className={inputCls} />
                </Field>
                <Field label={t('maxPerApplicationLabel')}>
                  <input
                    name="maxDaysPerApplication"
                    type="number"
                    step="0.5"
                    min="0.5"
                    placeholder={t('maxPerApplicationBlank')}
                    className={inputCls}
                  />
                </Field>
                {/* A NEW group starts Hidden too, and for the same reason an existing one does: a shared
                    balance appears on employees' screens because someone chose it, never as a side effect
                    of creating the configuration. */}
                <Field label={t('placementLabel')}>
                  <select
                    name="essPlacement"
                    defaultValue={SHARED_GROUP_DEFAULT_PLACEMENT}
                    className={inputCls}
                  >
                    {ESS_PLACEMENTS.map((pl) => (
                      <option key={pl} value={pl}>
                        {t(`placementOption.${pl}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">{t('placementHelp')}</p>
              <ChipMultiSelect name="leaveTypeIds" {...chipCopy} />
              <p className="text-xs text-muted-foreground">{t('createHint')}</p>
              <div className="flex justify-end">
                <button type="submit" className={btnPrimary}>
                  {t('create')}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
