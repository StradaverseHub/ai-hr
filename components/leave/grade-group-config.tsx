'use client';

import { useTranslations } from 'next-intl';
import { Badge, Button, Field, btnPrimary, inputCls } from '@/components/ui';

/**
 * Grade Groups — name a set of job grades so a rule can cover several grades at once ("Grade 12–15").
 *
 * 6e9a126e RELEASE THREE — THIS PANEL IS A SURVIVOR, EXTRACTED ON PURPOSE. It was Panel B of the
 * two-panel workbench inside `components/benefit-scheme-config.tsx`, and that file is deleted with the
 * benefit-scheme layer. Grade groups are NOT part of that layer: 205 live approval rules scope by grade
 * group (`leave_approval_policy` names one), and `grade_group` / `grade_group_member` are deliberately
 * kept by the release-three migration for exactly that reason. Deleting the workbench without lifting
 * this out would have left those 205 rules pointing at groups nobody could create, rename or re-staff.
 *
 * WHAT DID CHANGE is what a group is FOR. It used to be one axis of a benefit scheme
 * (company × employment type × grade group ⇒ a set of entitlement days), so it selected an entitlement.
 * It no longer does: who receives which entitlement table is decided by `entitlement_eligibility_rule` on
 * Settings → Leave → Entitlements → Entitlement Tables. A grade group is now purely an approval-routing
 * scope. The panel's help text says so rather than leaving the old meaning implied.
 *
 * Nothing about STORAGE moved: same three server actions (create / update / delete), same FormData
 * contract — `name` plus a repeated `gradeIds` checkbox per member, and `id` on the two that need one —
 * and the same `admin.benefitScheme` message keys the workbench used, so no locale gains or loses a
 * string. The tick-box membership editor is the assignment path (b1b81a08 removed the grade-card drag
 * shortcut when grade MASTER data moved to Settings → System Labels → Organisation Labels).
 */
export type GradeGroupRow = { id: string; name: string; gradeIds: string[]; archived: boolean };
export type GradeGroupGradeOption = { id: string; name: string };

export function GradeGroupConfig({
  gradeGroups,
  grades,
  actions,
}: {
  gradeGroups: GradeGroupRow[];
  /** The ACTIVE job grades a group may contain. Archived grades are not offered as NEW members; a group
   *  that already holds one keeps it — this form only posts the boxes it renders, so a member it cannot
   *  show would be dropped on save. The page therefore passes the same active-only list it always did. */
  grades: GradeGroupGradeOption[];
  actions: {
    createGradeGroup: (fd: FormData) => void | Promise<void>;
    updateGradeGroup: (fd: FormData) => void | Promise<void>;
    deleteGradeGroup: (fd: FormData) => void | Promise<void>;
  };
}) {
  const t = useTranslations('admin.benefitScheme');

  return (
    <div className="space-y-3 p-3" data-tour="grade-groups">
      <p className="text-xs text-muted-foreground">{t('groupsHelp')}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {gradeGroups.length === 0 && (
          <li className="px-3 py-4 text-center text-sm text-muted-foreground">{t('noGroups')}</li>
        )}
        {gradeGroups.map((g) => (
          <li key={g.id} className="px-3 py-2.5">
            <details>
              <summary className="flex cursor-pointer items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {g.name}
                  {g.archived && <Badge variant="warning">{t('archived')}</Badge>}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t('memberCount', { count: g.gradeIds.length })}
                  </span>
                </span>
              </summary>
              <div className="mt-3">
                <form action={actions.updateGradeGroup} className="space-y-3">
                  <input type="hidden" name="id" value={g.id} />
                  <Field label={t('groupNameLabel')}>
                    <input name="name" defaultValue={g.name} required className={inputCls} />
                  </Field>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {grades.map((gr) => (
                        <label
                          key={gr.id}
                          className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs"
                        >
                          <input
                            type="checkbox"
                            name="gradeIds"
                            value={gr.id}
                            defaultChecked={g.gradeIds.includes(gr.id)}
                            className="size-3.5 rounded"
                          />
                          {gr.name}
                        </label>
                      ))}
                      {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                      {t('save')}
                    </Button>
                    {/* 9054e31c: Delete shares the Save row — a second submit button posting
                        deleteGradeGroup via formAction (same pattern as the holidays page and the TP1
                        form). The action reads only the hidden id; the extra name/gradeIds fields are
                        ignored. formNoValidate so a cleared required name input cannot block Delete. */}
                    <Button type="submit" variant="ghost" size="sm" formAction={actions.deleteGradeGroup} formNoValidate>
                      {t('delete')}
                    </Button>
                  </div>
                </form>
              </div>
            </details>
          </li>
        ))}
      </ul>
      <form
        action={actions.createGradeGroup}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-dashed border-border p-3"
      >
        <Field label={t('groupNameLabel')}>
          <input name="name" required placeholder={t('groupNamePlaceholder')} className={`${inputCls} w-56`} />
        </Field>
        <div className="min-w-0">
          <span className="text-xs font-medium text-muted-foreground">{t('membersLabel')}</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {grades.map((gr) => (
              <label key={gr.id} className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs">
                <input type="checkbox" name="gradeIds" value={gr.id} className="size-3.5 rounded" />
                {gr.name}
              </label>
            ))}
            {grades.length === 0 && <span className="text-xs text-muted-foreground">{t('noGrades')}</span>}
          </div>
        </div>
        <button className={btnPrimary}>{t('addGroup')}</button>
      </form>
    </div>
  );
}
