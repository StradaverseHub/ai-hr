'use client';

import { Fragment, useState } from 'react';
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
 * Grade Management for Leave Entitlement (feedback 728a7db6). Renders the grade master as the reporter's
 * Code | Name | Rank | Status | Action table with a full action menu (Edit / Archive↔Unarchive / Delete)
 * per row, plus the "add grade" form. Edit expands an inline row-form (Code + Name + Rank all editable);
 * Delete is a confirm dialog that is DISABLED when the grade is in use (historical records preserved). The
 * grade catalog itself is presentation only — every mutation goes through the passed server actions, which
 * append the DomainEvents. (substrate: this component is a client view, the events live in core/admin.ts.)
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

  return (
    <div>
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
            {grades.map((g) => {
              const editing = editingId === g.id;
              return (
                <Fragment key={g.id}>
                  <tr className={`border-b border-border ${g.archived ? 'opacity-60' : ''}`}>
                    <td className="px-4 py-2.5">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {g.code}
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
                          <form action={actions.archive}>
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="archived" value="false" />
                            <Button type="submit" variant="ghost" size="sm">
                              {t('unarchive')}
                            </Button>
                          </form>
                        ) : (
                          <form action={actions.archive}>
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="archived" value="true" />
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
                        <form action={actions.delete}>
                          <input type="hidden" name="id" value={g.id} />
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
                          onSubmit={() => setEditingId(null)}
                        >
                          <input type="hidden" name="id" value={g.id} />
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

      <form action={actions.create} className="flex flex-wrap items-end gap-2 border-t border-border p-4">
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
