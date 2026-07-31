import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { CONFIGURABLE_BEHAVIOUR_KINDS, listMovementEventTypes } from '@/core/movement-type';
import {
  Badge,
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
  inputCls,
  tableWrapCls,
  tbodyCls,
  theadCls,
  thCls,
} from '@/components/ui';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  deleteMovementEventTypeAction,
  saveMovementEventTypeAction,
  setMovementEventTypeActiveAction,
} from './actions';

/**
 * 476f23ed — Movement Settings.
 *
 * ONE screen, one table: every movement event type the organisation can record, with the two things the
 * reporter asked to control (what it is CALLED, and whether it is OFFERED) editable in place, plus a form
 * to add one of their own.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE. A built-in type's BEHAVIOUR. Termination ends employment,
 * Confirmation completes probation, a join-date correction moves leave entitlement — those consequences
 * belong to the built-in kind, not to its name. So a built-in row offers Rename and Off/On and nothing
 * else, and a custom type may only be mapped onto one of the consequence-free behaviours
 * (CONFIGURABLE_BEHAVIOUR_KINDS). The service refuses the rest independently of this screen.
 *
 * WHY THERE IS NO DELETE ON A BUILT-IN, AND NO DELETE ON A TYPE IN USE. Employment History is a read-time
 * projection over the event ledger, and a movement records its type as a CODE. Removing a code that any
 * record references would leave those rows unlabelled for good. Switching a type off has the effect the
 * reporter wants — it stops appearing when HR creates a movement — without touching a single record.
 */
export default async function MovementSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; toast?: string }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('movementSettings');
  const tk = await getTranslations('people.detail.movement.eventType');
  const { error } = await searchParams;

  const rows = await listMovementEventTypes(s);

  /** The shipped translation for a built-in kind; the humanized code for anything else. */
  const shippedLabel = (code: string): string => {
    const key = code as 'transfer';
    const translated = tk.has(key) ? tk(key) : null;
    return translated ?? code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  };
  const displayLabel = (r: { code: string; label: string | null }) => r.label ?? shippedLabel(r.code);

  const builtIns = rows.filter((r) => r.builtIn);
  const custom = rows.filter((r) => !r.builtIn);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorBanner message={error} />

      <p className="rounded-[1.25rem] border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        {t('behaviourNotice')}
      </p>

      <Card className="overflow-hidden">
        <SectionHeader title={t('catalogTitle')} count={rows.length} />
        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>{t('columns.name')}</th>
                <th className={thCls}>{t('columns.behaviour')}</th>
                <th className={thCls}>{t('columns.status')}</th>
                <th className={thCls}>{t('columns.action')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {[...builtIns, ...custom].map((r) => (
                <tr key={r.code} className={r.active ? undefined : 'text-muted-foreground'}>
                  <td className="px-3 py-2">
                    {/* Rename in place — one field, one Save, no modal. The code below the field is what
                        the ledger stores and is never editable: it is the identity every recorded
                        movement of this type already points at. */}
                    <form action={saveMovementEventTypeAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="code" value={r.code} />
                      <input
                        name="label"
                        defaultValue={displayLabel(r)}
                        aria-label={t('columns.name')}
                        className={`${inputCls} w-56`}
                      />
                      <button className={btnPrimary}>{t('save')}</button>
                    </form>
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">{r.code}</div>
                  </td>
                  <td className="px-3 py-2">
                    {shippedLabel(r.behaviourKind)}
                    {r.builtIn && <div className="text-xs text-muted-foreground">{t('builtInBehaviour')}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={r.active ? 'success' : 'default'}>
                      {r.active ? t('status.active') : t('status.inactive')}
                    </Badge>
                    {r.inUse && <div className="mt-1 text-xs text-muted-foreground">{t('inUse')}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-3">
                      <form action={setMovementEventTypeActiveAction} className="inline-flex">
                        <input type="hidden" name="code" value={r.code} />
                        <input type="hidden" name="active" value={r.active ? 'false' : 'true'} />
                        <ConfirmSubmit
                          title={r.active ? t('deactivateConfirmTitle') : t('activateConfirmTitle')}
                          subtitle={displayLabel(r)}
                          description={r.active ? t('deactivateConfirmDescription') : t('activateConfirmDescription')}
                          confirmLabel={r.active ? t('deactivate') : t('activate')}
                          variant="ghost"
                          size="sm"
                          className="h-auto p-0 text-sm font-normal text-primary hover:bg-transparent hover:underline"
                        >
                          {r.active ? t('deactivate') : t('activate')}
                        </ConfirmSubmit>
                      </form>
                      {/* Delete exists only where it is honest: a custom type nothing has recorded yet. */}
                      {!r.builtIn && !r.inUse && (
                        <form action={deleteMovementEventTypeAction} className="inline-flex">
                          <input type="hidden" name="code" value={r.code} />
                          <ConfirmSubmit
                            title={t('deleteConfirmTitle')}
                            subtitle={displayLabel(r)}
                            description={t('deleteConfirmDescription')}
                            confirmLabel={t('delete')}
                            variant="ghost"
                            size="sm"
                            className="h-auto p-0 text-sm font-normal text-destructive hover:bg-transparent hover:underline"
                          >
                            {t('delete')}
                          </ConfirmSubmit>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <SectionHeader title={t('addTitle')} />
        <form action={saveMovementEventTypeAction} className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted-foreground">{t('addHint')}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('columns.name')}</span>
              <input name="label" required className={`${inputCls} w-64`} placeholder={t('addNamePlaceholder')} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{t('columns.behaviour')}</span>
              <select name="behaviourKind" required defaultValue="" className={`${inputCls} w-64`}>
                <option value="" disabled>
                  {t('addBehaviourPlaceholder')}
                </option>
                {CONFIGURABLE_BEHAVIOUR_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {shippedLabel(k)}
                  </option>
                ))}
              </select>
            </label>
            <button className={btnPrimary}>{t('add')}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
