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
 * WHAT A GROUP IS FOR, IN THREE STAGES — the middle one is why this header used to say something else.
 *   1. It was one axis of a benefit scheme (company × employment type × grade group ⇒ a set of entitlement
 *      days), so it SELECTED an entitlement.
 *   2. 6e9a126e release three deleted that layer, and who receives which entitlement table became
 *      `entitlement_eligibility_rule`'s job — whose criteria carried individual `gradeIds`, never a GROUP.
 *      A grade group was then purely an approval-routing scope, and this header said exactly that.
 *   3. 9a65f808 (r197) put a Grade Group picker on Employee Eligibility. Picking a group there fills in its
 *      member grades, so the STORED axis is still `gradeIds` and stage 2's sentence about storage is still
 *      true — but "a grade group has nothing to do with entitlement" is NOT, and the panel's help text and
 *      this header both stop saying it. A group is now the shared vocabulary of BOTH sides: approval
 *      routing scopes by it, and entitlement eligibility is written in it.
 *
 * That third stage is why the editor lives on Settings → System Labels → Organisation now, beside Job
 * Grades, rather than on either consumer's own screen (it was on Settings → Leave → Entitlements, then on
 * Settings → Leave → Approval under f12d77e5). Master data maintained inside one of its two consumers is
 * master data the other consumer's admins cannot find.
 *
 * Nothing about STORAGE has moved at any stage: same three server actions (create / update / delete), same
 * FormData contract — `name` plus a repeated `gradeIds` checkbox per member, and `id` on the two that need
 * one — and the same `admin.benefitScheme` message keys the workbench used, so no locale gains or loses a
 * string. The tick-box membership editor is the assignment path (b1b81a08 removed the grade-card drag
 * shortcut when grade MASTER data moved to Settings → System Labels → Organisation Labels — which is the
 * screen this editor has now followed it onto).
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
