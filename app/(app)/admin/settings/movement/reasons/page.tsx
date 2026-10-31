import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { listTerminationReasons, type TerminationReasonRow } from '@/core/termination-reason-catalog';
import { TERMINATION_REASON_CATEGORIES } from '@/core/termination-reason';
import {
  Badge,
  Card,
  ErrorBanner,
  PageHeader,
  btnPrimary,
  pageWideCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { SettingsToolbar, rowActionCls, rowActionMutedCls, rowActionsCls } from '@/components/settings-list';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { deleteTerminationReasonAction, setTerminationReasonActiveAction } from '../actions';
import { DeleteExplanation } from '../delete-explanation';
import { MovementSettingsTabs } from '../movement-settings-tabs';
import { ReasonDialog, type ReasonDialogLabels } from '../reason-dialog';

/**
 * 1d58019a — Movement Settings › Termination Reasons (Step 1, ADR-0165).
 *
 * The exit reasons the Termination event offers stop being a fixed list nobody can change. The thirteen
 * shipped reasons (core/termination-reason.ts) are the starting list, grouped under the same three FIXED
 * groups — Voluntary Termination, Involuntary Termination, Other — and HR can add a reason inside a group,
 * rename any reason, switch one off, and delete one of its own that nothing has recorded. Every rule is the
 * service's (core/termination-reason-catalog.ts); this page mirrors it.
 *
 * WHY THE GROUPS ARE FIXED: they feed the Terminations and Turnover reports, and the turnover classification
 * of an exit is derived from them (a built-in reason keeps its finer shipped mapping). A new group would
 * quietly drop those exits from both reports, so it is its own request, not a button here.
 *
 * WHY NO SEARCH OR PAGER: the list is grouped. Paging would split a group across pages and a search box
 * would hide the group headings that are the point of the layout; the catalogue is a few dozen rows at most.
 *
 * TWO NAMESPACES (movementSettings + people.detail.movement for the shipped reason and group names), so
 * i18n-coverage Check C skips this file; test/movement-settings.test.ts's key list is what pins the keys.
 */
export default async function TerminationReasonsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('movementSettings');
  const tm = await getTranslations('people.detail.movement');
  const sp = await searchParams;

  const rows = await listTerminationReasons(s);

  const groupLabel = (c: string) =>
    tm(`terminationReasonCategory.${c}` as 'terminationReasonCategory.voluntary');
  /** The tenant's own name wins; a built-in it never renamed keeps the shipped six-locale label. */
  const displayLabel = (r: TerminationReasonRow) => {
    if (r.label) return r.label;
    const key = `terminationReason.${r.code}` as 'terminationReason.resignation';
    return tm.has(key) ? tm(key) : r.code;
  };
  const createdLabel = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('en-GB', { timeZone: HR_LOCAL_TZ, day: '2-digit', month: 'short', year: 'numeric' }).format(d)
      : null;

  const groupOptions = TERMINATION_REASON_CATEGORIES.map((c) => ({ value: c as string, label: groupLabel(c) }));
  const dialogBase: ReasonDialogLabels = {
    title: t('reasons.addTitle'),
    hint: t('reasons.addHint'),
    name: t('columns.name'),
    namePlaceholder: t('reasons.namePlaceholder'),
    group: t('columns.group'),
    groupPlaceholder: t('reasons.groupPlaceholder'),
    groupFixed: t('reasons.groupFixed'),
    submit: t('reasons.add'),
    saving: t('saving'),
    cancel: t('cancel'),
    close: t('close'),
  };
  const renameLabels: ReasonDialogLabels = {
    ...dialogBase,
    title: t('reasons.renameTitle'),
    hint: t('reasons.renameHint'),
    submit: t('save'),
  };

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />
      <MovementSettingsTabs active="reasons" labels={{ types: t('tabs.types'), reasons: t('tabs.reasons') }} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SettingsToolbar>
          <ReasonDialog
            triggerLabel={t('reasons.createNew')}
            triggerClassName={btnPrimary}
            code={null}
            initialLabel=""
            groupLabel=""
            groupOptions={groupOptions}
            labels={dialogBase}
          />
          <p className="text-xs text-muted-foreground">{t('reasons.notice')}</p>
        </SettingsToolbar>

        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>{t('columns.name')}</th>
                <th className={thCls}>{t('columns.status')}</th>
                <th className={thCls}>{t('columns.created')}</th>
                <th className={thCls}>{t('columns.action')}</th>
              </tr>
            </thead>
            {TERMINATION_REASON_CATEGORIES.map((category) => {
              const inGroup = rows.filter((r) => r.category === category);
              return (
                <tbody key={category} className={tbodyCls}>
                  <tr className="bg-muted/30">
                    <th colSpan={4} scope="colgroup" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide">
                      {groupLabel(category)}
                    </th>
                  </tr>
                  {inGroup.map((r) => (
                    <tr key={r.code}>
                      <td className="px-3 py-2">
                        <div className={r.active ? 'font-medium' : 'font-medium text-muted-foreground'}>
                          {displayLabel(r)}
                        </div>
                        {/* The code history records. Never editable. */}
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{r.code}</div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={r.active ? 'success' : 'default'}>
                          {r.active ? t('status.active') : t('status.inactive')}
                        </Badge>
                        {r.inUse && <div className="mt-1 text-xs text-muted-foreground">{t('reasons.inUse')}</div>}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{createdLabel(r.createdAt) ?? t('builtIn')}</td>
                      <td className="px-3 py-2">
                        <div className={rowActionsCls}>
                          <ReasonDialog
                            triggerLabel={t('reasons.rename')}
                            triggerClassName={rowActionCls}
                            code={r.code}
                            initialLabel={displayLabel(r)}
                            groupLabel={groupLabel(r.category)}
                            groupOptions={groupOptions}
                            labels={renameLabels}
                          />
                          <form action={setTerminationReasonActiveAction} className="inline-flex">
                            <input type="hidden" name="code" value={r.code} />
                            <input type="hidden" name="active" value={r.active ? 'false' : 'true'} />
                            <ConfirmSubmit
                              title={r.active ? t('reasons.deactivateConfirmTitle') : t('reasons.activateConfirmTitle')}
                              subtitle={displayLabel(r)}
                              description={
                                r.active ? t('reasons.deactivateConfirmDescription') : t('reasons.activateConfirmDescription')
                              }
                              confirmLabel={r.active ? t('deactivate') : t('activate')}
                              variant="ghost"
                              size="sm"
                              className={`h-auto p-0 font-normal hover:bg-transparent ${rowActionMutedCls}`}
                            >
                              {r.active ? t('deactivate') : t('activate')}
                            </ConfirmSubmit>
                          </form>
                          {!r.builtIn && !r.inUse ? (
                            <form action={deleteTerminationReasonAction} className="inline-flex">
                              <input type="hidden" name="code" value={r.code} />
                              <ConfirmSubmit
                                title={t('reasons.deleteConfirmTitle')}
                                subtitle={displayLabel(r)}
                                description={t('reasons.deleteConfirmDescription')}
                                confirmLabel={t('delete')}
                                variant="ghost"
                                size="sm"
                                className="h-auto p-0 text-xs font-medium text-destructive hover:bg-transparent hover:underline"
                              >
                                {t('delete')}
                              </ConfirmSubmit>
                            </form>
                          ) : (
                            <DeleteExplanation
                              target="reason"
                              code={r.code}
                              triggerLabel={t('delete')}
                              title={t('deleteBlocked.title', { name: displayLabel(r) })}
                              paragraphs={[
                                r.inUse ? t('reasons.deleteBlocked.inUse') : t('reasons.deleteBlocked.builtIn'),
                                r.active ? t('reasons.deleteBlocked.switchOffInstead') : t('reasons.deleteBlocked.alreadyOff'),
                              ]}
                              closeLabel={t('close')}
                              switchOffLabel={r.active ? t('deactivate') : null}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {inGroup.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">
                        {t('reasons.emptyGroup')}
                      </td>
                    </tr>
                  )}
                </tbody>
              );
            })}
          </table>
        </div>
      </Card>
    </div>
  );
}
