import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { requireAdmin } from '@/lib/authz';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
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
import {
  SettingsSearch,
  SettingsStatusFilter,
  SettingsToolbar,
  SortHeader,
  parseSettingsStatus,
  parseSortDir,
  rowActionCls,
  rowActionMutedCls,
  rowActionsCls,
  type SettingsStatus,
  type SortDir,
} from '@/components/settings-list';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import {
  deleteMovementEventTypeAction,
  saveMovementEventTypeAction,
  setMovementEventTypeActiveAction,
} from './actions';

const PAGE = '/admin/settings/movement';

/**
 * Movement Settings — the movement event type catalogue (476f23ed, redesigned by 1b87e8a0).
 *
 * WHAT 1b87e8a0 CHANGED, AND ONLY THAT. The screen was a card per event type with a rename box inside
 * each one and an Add card sitting in the list. It is now the row listing the reporter asked for, in the
 * shape /admin/pay-components and Employee ID already use: a toolbar of [Add · search · status filter],
 * the house table, row actions on the right, and ONE maintenance panel driven by `?new=1` / `?edit=CODE`.
 * The toolbar pieces come from components/settings-list.tsx, which is the same module the relocated
 * Hiring Defaults list uses — that shared import is what makes "the standard" one thing instead of two,
 * and test/settings-list-idiom.test.ts fails if either screen drifts off it.
 *
 * NOT THE SAME SHAPE AS HIRING DEFAULTS, on purpose. That screen is per-company and needs a list of
 * companies plus a page per company; this one is a flat catalogue and must not grow a list it does not
 * need. Shared conventions, different screens — say so in the release note so the next request does not
 * read the difference as drift.
 *
 * TWO OF THE REPORTER'S FIVE COLUMNS HAVE NOTHING BEHIND THEM, disclosed rather than faked:
 *   • Description — movement_event_type holds a code, a behaviour kind and a display label, and nothing
 *     descriptive. `label` IS the Event Type column and `code` is the ledger identity; repurposing either
 *     would put the same value in two columns.
 *   • Last Updated — there is no updated_at. Created ships instead (see MovementEventTypeRow.createdAt),
 *     and it reads "Built-in" for a shipped type, which has no creation date and whose overlay row's
 *     created_at is the date of a rename, not of a creation. Adding updated_at is a migration plus a
 *     write-path change and was raised to the reporter as its own request.
 *
 * NO PAGINATION, deliberately. A tenant has a handful of event types; searching finds one faster than
 * paging, and the shared contract for paging is lib/pagination + components/Pager (test/pagination
 * .test.ts pins the converted surfaces) — never a hand-rolled sixth.
 *
 * STATUS DEFAULTS TO ALL, not to Active like the other catalogues. Switching a type back ON is a main
 * reason to open this screen; an Active default would hide exactly the rows you came for.
 *
 * WHAT IS STILL NOT EDITABLE HERE. A built-in type's BEHAVIOUR. Termination ends employment, Confirmation
 * completes probation, a join-date correction moves leave entitlement — those consequences belong to the
 * built-in kind, not to its name. So a built-in offers Rename and Off/On and nothing else, and a custom
 * type may only be mapped onto a consequence-free behaviour (CONFIGURABLE_BEHAVIOUR_KINDS). The service
 * refuses the rest independently of this screen. And there is no Delete on a built-in or on a type in
 * use: Employment History is a read-time projection over the event ledger and a movement records its
 * type as a CODE, so removing a referenced code would leave those rows unlabelled for good.
 */
export default async function MovementSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    toast?: string;
    q?: string;
    status?: string;
    sort?: string;
    dir?: string;
    edit?: string;
    new?: string;
  }>;
}) {
  const s = await requireAdmin();
  const t = await getTranslations('movementSettings');
  const tk = await getTranslations('people.detail.movement.eventType');
  const sp = await searchParams;

  const rows = await listMovementEventTypes(s);

  /** The shipped translation for a built-in kind; the humanized code for anything else. */
  const shippedLabel = (code: string): string => {
    const key = code as 'transfer';
    const translated = tk.has(key) ? tk(key) : null;
    return translated ?? code.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  };
  const displayLabel = (r: { code: string; label: string | null }) => r.label ?? shippedLabel(r.code);

  /** The date the organisation added a type of its own, in the tenant's calendar — NEVER the host's:
   *  a UTC-derived date is yesterday's between 00:00 and 08:00 MYT. Built-ins have no date at all. */
  const createdLabel = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('en-GB', {
          timeZone: HR_LOCAL_TZ,
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }).format(d)
      : null;

  const q = (sp.q ?? '').trim();
  const status: SettingsStatus = parseSettingsStatus(sp.status, 'all');
  const sort =
    sp.sort === 'name' || sp.sort === 'status' || sp.sort === 'created' ? sp.sort : 'catalog';
  const dir: SortDir = parseSortDir(sp.dir);

  const needle = q.toLowerCase();
  const visible = rows
    .filter((r) => {
      const okQ = !needle || [displayLabel(r), r.code].some((v) => v.toLowerCase().includes(needle));
      const okStatus = status === 'all' || (status === 'inactive' ? !r.active : r.active);
      return okQ && okStatus;
    })
    .sort((a, b) => {
      if (sort === 'catalog') {
        // The catalogue's own order: built-ins first, in the order the New Event form has always
        // offered them, then the organisation's own types by sort order.
        const by = Number(a.builtIn ? 0 : 1) - Number(b.builtIn ? 0 : 1) || a.sortOrder - b.sortOrder;
        return dir === 'desc' ? -by : by;
      }
      const by =
        sort === 'name'
          ? displayLabel(a).localeCompare(displayLabel(b))
          : sort === 'status'
            ? Number(!a.active) - Number(!b.active) || displayLabel(a).localeCompare(displayLabel(b))
            : // Created: built-ins carry no date and stay together at the top of an ascending sort.
              (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
      return dir === 'desc' ? -by : by;
    });

  /** Keep the whole view in the address when one control changes. */
  const href = (over: Partial<{ q: string; status: SettingsStatus; sort: string; dir: SortDir; edit: string; new: string }>) => {
    const next = { q, status, sort, dir, edit: undefined as string | undefined, new: undefined as string | undefined, ...over };
    const usp = new URLSearchParams();
    if (next.q) usp.set('q', next.q);
    if (next.status !== 'all') usp.set('status', next.status);
    if (next.sort !== 'catalog') usp.set('sort', next.sort);
    if (next.dir !== 'asc') usp.set('dir', next.dir);
    if (next.edit) usp.set('edit', next.edit);
    if (next.new) usp.set('new', next.new);
    const qs = usp.toString();
    return qs ? `${PAGE}?${qs}` : PAGE;
  };
  const sortHref = (col: 'name' | 'status' | 'created') =>
    href({ sort: col, dir: sort === col && dir === 'asc' ? 'desc' : 'asc' });

  const editing = sp.edit ? (rows.find((r) => r.code === sp.edit) ?? null) : null;
  const showPanel = Boolean(editing || sp.new);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ErrorBanner message={sp.error} />

      <p className="rounded-[1.25rem] border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        {t('behaviourNotice')}
      </p>

      <Card className="overflow-hidden">
        <SectionHeader title={t('catalogTitle')} count={visible.length} />

        <SettingsToolbar>
          <Link href={href({ new: '1' })} className={btnPrimary}>
            {t('createNew')}
          </Link>
          <SettingsSearch
            action={PAGE}
            value={q}
            placeholder={t('searchPlaceholder')}
            hidden={{
              status: status === 'all' ? undefined : status,
              sort: sort === 'catalog' ? undefined : sort,
              dir: dir === 'asc' ? undefined : dir,
            }}
          />
          <SettingsStatusFilter
            current={status}
            options={[
              { value: 'active', href: href({ status: 'active' }), label: t('status.active') },
              { value: 'inactive', href: href({ status: 'inactive' }), label: t('status.inactive') },
              { value: 'all', href: href({ status: 'all' }), label: t('status.all') },
            ]}
          />
        </SettingsToolbar>

        <div className={tableWrapCls}>
          <table className="w-full text-sm">
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>
                  <SortHeader label={t('columns.name')} href={sortHref('name')} active={sort === 'name'} dir={dir} />
                </th>
                <th className={thCls}>{t('columns.behaviour')}</th>
                <th className={thCls}>
                  <SortHeader label={t('columns.status')} href={sortHref('status')} active={sort === 'status'} dir={dir} />
                </th>
                <th className={thCls}>
                  <SortHeader label={t('columns.created')} href={sortHref('created')} active={sort === 'created'} dir={dir} />
                </th>
                <th className={thCls}>{t('columns.action')}</th>
              </tr>
            </thead>
            <tbody className={tbodyCls}>
              {visible.map((r) => (
                <tr key={r.code} className={editing?.code === r.code ? 'bg-primary/5' : undefined}>
                  <td className="px-3 py-2">
                    <div className={r.active ? 'font-medium' : 'font-medium text-muted-foreground'}>
                      {displayLabel(r)}
                    </div>
                    {/* The code the ledger stores. Never editable: it is the identity every recorded
                        movement of this type already points at. */}
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{r.code}</div>
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
                  <td className="px-3 py-2 text-muted-foreground">
                    {createdLabel(r.createdAt) ?? t('builtIn')}
                  </td>
                  <td className="px-3 py-2">
                    <div className={rowActionsCls}>
                      <Link href={href({ edit: r.code })} className={rowActionCls}>
                        {t('edit')}
                      </Link>
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
                          className={`h-auto p-0 font-normal hover:bg-transparent ${rowActionMutedCls}`}
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
                            className="h-auto p-0 text-xs font-medium text-destructive hover:bg-transparent hover:underline"
                          >
                            {t('delete')}
                          </ConfirmSubmit>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                    {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ONE maintenance panel for both Add and Edit, keyed off the address (the Employee ID mechanism):
          no client state to persist, and a link is enough to open or close it. */}
      {showPanel && (
        <Card className="overflow-hidden">
          <SectionHeader title={editing ? t('editTitle') : t('addTitle')} />
          <form action={saveMovementEventTypeAction} className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">{editing ? t('editHint') : t('addHint')}</p>
            {editing && <input type="hidden" name="code" value={editing.code} />}
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('columns.name')}</span>
                <input
                  name="label"
                  required
                  defaultValue={editing ? displayLabel(editing) : ''}
                  className={`${inputCls} w-64`}
                  placeholder={t('addNamePlaceholder')}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t('columns.behaviour')}</span>
                {/* EXACTLY ONE behaviour picker on this page, and it is never offered for a built-in:
                    a built-in keeps its built-in meaning, so the field is read-only there. The service
                    refuses a re-point independently, but an affordance that cannot work is a bug. */}
                {editing?.builtIn ? (
                  <input
                    className={`${inputCls} w-64`}
                    value={shippedLabel(editing.behaviourKind)}
                    readOnly
                    disabled
                  />
                ) : (
                  <select
                    name="behaviourKind"
                    required
                    defaultValue={editing?.behaviourKind ?? ''}
                    className={`${inputCls} w-64`}
                  >
                    <option value="" disabled>
                      {t('addBehaviourPlaceholder')}
                    </option>
                    {CONFIGURABLE_BEHAVIOUR_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {shippedLabel(k)}
                      </option>
                    ))}
                  </select>
                )}
                {editing?.builtIn && (
                  <span className="text-xs text-muted-foreground">{t('builtInBehaviour')}</span>
                )}
              </label>
            </div>
            <div className="flex items-center gap-3">
              <button className={btnPrimary}>{editing ? t('save') : t('add')}</button>
              <Link href={href({})} className="text-sm font-medium text-muted-foreground hover:text-foreground">
                {t('cancel')}
              </Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
