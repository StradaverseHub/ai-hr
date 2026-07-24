'use client';

import { Fragment, useState, type FormEvent } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

export type GradeRow = {
  id: string;
  code: string;
  name: string;
  rank: number;
  archived: boolean;
  inUse: boolean;
};

type Action = (formData: FormData) => void | Promise<void>;

/**
 * 4e9a4d59 — stamp the workspace's LIVE selection anchor into a grade form's hidden `leaveTypeId` so the
 * server action can redirect HR back to the exact leave type panel they were configuring (grades are
 * tenant-global master data — this is a UI-return hint, never a persisted field).
 *
 * Read at SUBMIT time, not mount time: LeaveTypeWorkspace keeps `window.location.hash` in sync via
 * replaceState as HR switches type, and this catalog is ONE shared node rendered inside every panel, so a
 * mount-time read would go stale. An empty value (no type selected) degrades to the bare Entitlements route.
 */
function stampLeaveTypeAnchor(e: FormEvent<HTMLFormElement>): void {
  const field = e.currentTarget.elements.namedItem('leaveTypeId');
  if (field instanceof HTMLInputElement) field.value = window.location.hash.match(/^#type-(.+)$/)?.[1] ?? '';
}

/**
 * Grade Management for Leave Entitlement (feedback 728a7db6). Renders the grade master as the reporter's
 * Code | Name | Rank | Status | Action table with a full action menu (Edit / Archive↔Unarchive / Delete)
 * per row, plus the "add grade" form. Edit expands an inline row-form (Code + Name + Rank all editable);
 * Delete is a confirm dialog that is DISABLED when the grade is in use (historical records preserved). The
 * grade catalog itself is presentation only — every mutation goes through the passed server actions, which
 * append the DomainEvents. (substrate: this component is a client view, the events live in core/admin.ts.)
 *
 * Three-panel workbench (feedback 387792a4): the catalog is Panel A (Grade Master) of the Entitlement
 * step's grade workbench. Two additions, both presentation-side only:
 *  - a search input filtering the table by grade code or name (client state, no data change);
 *  - a drag handle per active grade (useDraggable, id `grade:<id>`) so a grade can be dragged into a
 *    grade-group drop zone in Panel B. The handle only STARTS the drag — the drop is handled by the
 *    hosting BenefitSchemeConfig's DndContext, which posts the SAME updateGradeGroup action the
 *    checkbox fallback uses. Rendered outside a DndContext the handle is inert, nothing else changes.
 */
export function GradeCatalog({
  grades,
  actions,
}: {
  grades: GradeRow[];
  actions: {
    create: Action;
    update: Action;
    archive: Action;
    delete: Action;
  };
}) {
  const t = useTranslations('admin.leave');
  const [editingId, setEditingId] = useState<string | null>(null);
  // 387792a4 — Panel A search: case-insensitive substring match on code or name. Display filter only.
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = q
    ? grades.filter((g) => g.code.toLowerCase().includes(q) || g.name.toLowerCase().includes(q))
    : grades;

  return (
    <div>
      <div className="px-4 pt-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('gradeSearchLabel')}
          placeholder={t('gradeSearchPlaceholder')}
          className={`${inputCls} w-full max-w-xs`}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t('gradeColCode')}</th>
              <th className="px-4 py-2 font-medium">{t('gradeColName')}</th>
              <th className="px-4 py-2 font-medium">{t('gradeColRank')}</th>
              <th className="px-4 py-2 font-medium">{t('gradeColStatus')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('gradeColAction')}</th>
            </tr>
          </thead>
          <tbody>
            {grades.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t('gradesEmpty')}
                </td>
              </tr>
            )}
            {grades.length > 0 && visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t('gradeSearchNoResults')}
                </td>
              </tr>
            )}
            {visible.map((g) => {
              const editing = editingId === g.id;
              return (
                <Fragment key={g.id}>
                  <tr className={`border-b border-border ${g.archived ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5">
                        {/* 387792a4 — active grades drag into a grade-group drop zone (Panel B). */}
                        {!g.archived && <GradeDragHandle gradeId={g.id} name={g.name} t={t} />}
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {g.code}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-foreground">{g.name}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{g.rank}</td>
                    <td className="px-4 py-2.5">
                      {g.archived ? (
                        <Badge variant="warning">{t('gradeStatusArchived')}</Badge>
                      ) : (
                        <Badge variant="success">{t('gradeStatusActive')}</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditingId(editing ? null : g.id)}
                        >
                          {editing ? t('cancel') : t('editGrade')}
                        </Button>
                        {g.archived ? (
                          <form action={actions.archive} onSubmit={stampLeaveTypeAnchor}>
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="archived" value="false" />
                            <input type="hidden" name="leaveTypeId" defaultValue="" />
                            <Button type="submit" variant="ghost" size="sm">
                              {t('unarchive')}
                            </Button>
                          </form>
                        ) : (
                          <form action={actions.archive} onSubmit={stampLeaveTypeAnchor}>
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="archived" value="true" />
                            <input type="hidden" name="leaveTypeId" defaultValue="" />
                            <ConfirmSubmit
                              size="sm"
                              variant="ghost"
                              title={t('archiveGradeConfirmTitle')}
                              description={t('archiveGradeConfirmDescription')}
                              confirmLabel={t('archiveConfirmLabel')}
                            >
                              {t('archive')}
                            </ConfirmSubmit>
                          </form>
                        )}
                        <form action={actions.delete} onSubmit={stampLeaveTypeAnchor}>
                          <input type="hidden" name="id" value={g.id} />
                          <input type="hidden" name="leaveTypeId" defaultValue="" />
                          <ConfirmSubmit
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            disabled={g.inUse}
                            title={t('deleteGradeConfirmTitle')}
                            description={
                              g.inUse ? t('gradeInUseCannotDelete') : t('deleteGradeConfirmDescription')
                            }
                            confirmLabel={t('deleteConfirmLabel')}
                          >
                            {t('deleteGrade')}
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </td>
                  </tr>
                  {editing && (
                    <tr className="border-b border-border bg-muted/30">
                      <td colSpan={5} className="px-4 py-3">
                        <form
                          action={actions.update}
                          className="flex flex-wrap items-end gap-2"
                          onSubmit={(e) => {
                            stampLeaveTypeAnchor(e);
                            setEditingId(null);
                          }}
                        >
                          <input type="hidden" name="id" value={g.id} />
                          <input type="hidden" name="leaveTypeId" defaultValue="" />
                          <Field label={t('gradeCodeLabel')}>
                            <input
                              name="code"
                              required
                              defaultValue={g.code}
                              className={`${inputCls} w-28 uppercase`}
                            />
                          </Field>
                          <Field label={t('gradeNameLabel')}>
                            <input name="name" required defaultValue={g.name} className={inputCls} />
                          </Field>
                          <Field label={t('gradeRankLabel')}>
                            <input
                              name="rank"
                              type="number"
                              min="0"
                              defaultValue={g.rank}
                              className={`${inputCls} w-20`}
                            />
                          </Field>
                          <Button type="submit" size="sm">
                            {t('save')}
                          </Button>
                        </form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <form
        action={actions.create}
        className="flex flex-wrap items-end gap-2 border-t border-border p-4"
        onSubmit={stampLeaveTypeAnchor}
      >
        <input type="hidden" name="leaveTypeId" defaultValue="" />
        <Field label={t('gradeCodeLabel')}>
          <input name="code" required placeholder="EXEC" className={`${inputCls} w-28 uppercase`} />
        </Field>
        <Field label={t('gradeNameLabel')}>
          <input name="name" required placeholder={t('gradeNamePlaceholder')} className={inputCls} />
        </Field>
        <Field label={t('gradeRankLabel')}>
          <input name="rank" type="number" min="0" defaultValue="0" className={`${inputCls} w-20`} />
        </Field>
        <Button type="submit" size="sm">
          {t('addGrade')}
        </Button>
      </form>
    </div>
  );
}

/** 387792a4 — the Panel A drag handle: starts a `grade:<id>` drag the workbench's DndContext resolves onto
 *  a grade-group drop zone. Keyboard/AT users keep the checkbox fallback in Panel B (the accessible path). */
function GradeDragHandle({
  gradeId,
  name,
  t,
}: {
  gradeId: string;
  name: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `grade:${gradeId}` });
  return (
    <button
      type="button"
      ref={setNodeRef}
      aria-label={t('gradeDragAria', { name })}
      className={`grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-primary/40 ${
        isDragging ? 'opacity-50' : ''
      }`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}
