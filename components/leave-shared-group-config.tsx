'use client';

import { ActionButton } from '@/components/ui/action-button';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Card, Field, SectionHeader, btnPrimary, inputCls } from '@/components/ui';
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
 * WHERE IT LIVES AND WHY (50d9b809). On its OWN PAGE — Leave Settings › Shared Leave Groups
 * (`app/admin/leave-config/shared-groups/page.tsx`), rendered INLINE: the list of groups, an Edit that opens
 * that group's form in place under its row, and a Create section. Until 50d9b809 this whole editor sat
 * inside a Radix Dialog behind a "Shared leave groups" button on the Entitlements screen; the reporter found
 * a pop-up inside another settings page hard to find and cramped to work in. The Dialog shell is gone and
 * NOTHING inside it changed: the same fields with the same names, the same ChipMultiSelect, the same
 * placement select, the same ConfirmSubmit on Delete, posting the same three server actions.
 *
 * WHERE IT LIVED BEFORE THAT. Beside Add Leave Type, in the leave-type workspace's left panel — because that
 * is the level the group is defined AT. Until r88 it was created INSIDE a Benefit Scheme: you picked a scheme
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

/** Desktop column template shared by the list's header row and every group row, so they cannot drift. */
const ROW_GRID = 'sm:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_6rem_7rem_minmax(0,1fr)_auto]';

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
  // The ONE group whose form is open in place, or none. Not in the URL: Edit is a disclosure on this page,
  // not a destination. The page keys this component on the group data, so a save that changed a group
  // remounts it with every form closed and every default re-read; a refusal leaves the data unchanged, so
  // the form the admin was filling in stays open under the error banner.
  const [editingId, setEditingId] = useState<string | null>(null);
  const typeOptions = leaveTypes.map((lt) => ({ value: lt.id, label: lt.name }));
  const nameById = new Map(leaveTypes.map((lt) => [lt.id, lt.name]));
  const membersOf = (g: SharedGroup) => g.leaveTypeIds.map((id) => nameById.get(id) ?? '—').join(', ');
  const editing = groups.find((g) => g.id === editingId) ?? null;

  // The tick list is shared by the create and the edit form, so its translated copy is built once.
  const chipCopy = {
    options: typeOptions,
    addPlaceholder: t('membersPlaceholder'),
    removeLabelFor: (label: string) => t('memberRemove', { type: label }),
    label: t('membersLabel'),
    selectAllLabel: t('membersSelectAll'),
    clearAllLabel: t('membersClearAll'),
    countLabelFor: (count: number) => t('membersCount', { count }),
  };

  /** A cell's label: the column heading on a phone (where the row stacks), screen-reader only on desktop
   *  (where the header row above says it). The header row itself is aria-hidden, so each value is named
   *  exactly once for assistive technology at every width. */
  const cellLabel = (text: string) => (
    <span className="block text-xs text-muted-foreground sm:sr-only">{text}</span>
  );

  return (
    <div className="space-y-6">
      {/* ── Existing groups ──────────────────────────────────────────────────────────────────────── */}
      <Card data-testid="shared-group-list">
        <SectionHeader title={t('listTitle')} count={groups.length} />
        {groups.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            <li
              aria-hidden="true"
              className={`hidden gap-3 bg-muted/50 px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground sm:grid ${ROW_GRID}`}
            >
              <span>{t('nameLabel')}</span>
              <span>{t('membersLabel')}</span>
              <span className="text-right">{t('totalLimitLabel')}</span>
              <span className="text-right">{t('maxPerApplicationLabel')}</span>
              <span>{t('placementLabel')}</span>
              <span />
            </li>
            {groups.map((g) => {
              const open = g.id === editingId;
              return (
                <li key={g.id} className="px-4 py-3" data-testid="shared-group-row">
                  <div className={`grid gap-2 sm:items-start sm:gap-3 ${ROW_GRID}`}>
                    <div className="min-w-0">
                      {cellLabel(t('nameLabel'))}
                      <p className="break-words text-sm font-medium">{g.name}</p>
                    </div>
                    <div className="min-w-0">
                      {cellLabel(t('membersLabel'))}
                      <p className="break-words text-sm">{membersOf(g) || '—'}</p>
                    </div>
                    <div className="sm:text-right">
                      {cellLabel(t('totalLimitLabel'))}
                      <p className="text-sm tabular-nums">{g.totalLimitDays}</p>
                    </div>
                    <div className="sm:text-right">
                      {cellLabel(t('maxPerApplicationLabel'))}
                      <p className="text-sm tabular-nums">
                        {g.maxDaysPerApplication ?? (
                          <span className="text-muted-foreground">{t('maxPerApplicationBlank')}</span>
                        )}
                      </p>
                    </div>
                    <div className="min-w-0">
                      {cellLabel(t('placementLabel'))}
                      <p className="text-sm">{t(`placementOption.${g.essPlacement}`)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-expanded={open}
                        aria-controls={`shared-group-edit-${g.id}`}
                        onClick={() => setEditingId(open ? null : g.id)}
                      >
                        {open ? t('close') : t('edit')}
                      </Button>
                      {/* Delete is its own form: a <form> may not nest inside another. */}
                      <form action={actions.remove}>
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
                    </div>
                  </div>
                  {open && editing && (
                    <form
                      id={`shared-group-edit-${g.id}`}
                      action={actions.update}
                      aria-label={t('editTitle', { name: editing.name })}
                      className="mt-3 space-y-3 rounded-md border border-border bg-card p-4"
                    >
                      <p className="text-sm font-semibold">{t('editTitle', { name: editing.name })}</p>
                      <input type="hidden" name="id" value={editing.id} />
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label={t('nameLabel')} required requiredAriaLabel={t('required')}>
                          <input name="name" defaultValue={editing.name} required className={inputCls} />
                        </Field>
                        <Field label={t('totalLimitLabel')} required requiredAriaLabel={t('required')}>
                          <input
                            name="totalLimitDays"
                            type="number"
                            step="0.5"
                            min="0.5"
                            defaultValue={editing.totalLimitDays}
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
                            defaultValue={editing.maxDaysPerApplication ?? ''}
                            placeholder={t('maxPerApplicationBlank')}
                            className={inputCls}
                          />
                        </Field>
                      </div>
                      {/* Emits one hidden input per ticked id under this name — see ChipMultiSelect's form
                          contract. The action reads formData.getAll('leaveTypeIds'). */}
                      <ChipMultiSelect name="leaveTypeIds" defaultSelected={editing.leaveTypeIds} {...chipCopy} />
                      {/* 46afcc48 — where the employee sees this GROUP. Independent of every member type's
                          own placement, which stays on the leave type where it already is. */}
                      <div className="sm:max-w-sm">
                        <Field label={t('placementLabel')}>
                          <select name="essPlacement" defaultValue={editing.essPlacement} className={inputCls}>
                            {ESS_PLACEMENTS.map((pl) => (
                              <option key={pl} value={pl}>
                                {t(`placementOption.${pl}`)}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <p className="text-xs text-muted-foreground">{t('placementHelp')}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <ActionButton type="submit" className={btnPrimary}>
                          {t('save')}
                        </ActionButton>
                        <Button type="button" variant="outline" onClick={() => setEditingId(null)}>
                          {t('cancel')}
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ── Create ────────────────────────────────────────────────────────────────────────────────── */}
      <Card id="new-shared-group" data-testid="shared-group-create" className="scroll-mt-6">
        <SectionHeader title={t('createTitle')} subtitle={t('createHint')} />
        <form action={actions.create} className="space-y-3 px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('nameLabel')} required requiredAriaLabel={t('required')}>
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
          </div>
          <ChipMultiSelect name="leaveTypeIds" {...chipCopy} />
          {/* A NEW group starts Hidden too, and for the same reason an existing one does: a shared
              balance appears on employees' screens because someone chose it, never as a side effect
              of creating the configuration. */}
          <div className="sm:max-w-sm">
            <Field label={t('placementLabel')}>
              <select name="essPlacement" defaultValue={SHARED_GROUP_DEFAULT_PLACEMENT} className={inputCls}>
                {ESS_PLACEMENTS.map((pl) => (
                  <option key={pl} value={pl}>
                    {t(`placementOption.${pl}`)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('placementHelp')}</p>
          <div className="flex">
            <ActionButton type="submit" className={btnPrimary}>
              {t('create')}
            </ActionButton>
          </div>
        </form>
      </Card>
    </div>
  );
}
