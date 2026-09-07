import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { CONFIGURABLE_BEHAVIOUR_KINDS, listMovementEventTypes } from '@/core/movement-type';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
import {
  Badge,
  Card,
  ErrorBanner,
  PageHeader,
  SectionHeader,
  btnPrimary,
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
import { MovementTypeDialog, type MovementTypeDialogLabels } from './movement-type-dialog';
import { deleteMovementEventTypeAction, setMovementEventTypeActiveAction } from './actions';

const PAGE = '/admin/settings/movement';

/**
 * Movement Settings — the movement event type catalogue (476f23ed, redesigned by 1b87e8a0).
 *
 * WHAT 1b87e8a0 CHANGED, AND ONLY THAT. The screen was a card per event type with a rename box inside
 * each one and an Add card sitting in the list. It is now the row listing the reporter asked for, in the
 * shape /admin/pay-components and Employee ID already use: a toolbar of [Add · search · status filter],
 * the house table, and row actions on the right. The toolbar pieces come from components/settings-list
 * .tsx, which is the same module the relocated Hiring Defaults list uses — that shared import is what
 * makes "the standard" one thing instead of two, and test/settings-list-idiom.test.ts fails if either
 * screen drifts off it.
 *
 * ⚠️ THE RE-BUILD: ADD/EDIT IS A MODAL, NOT A PANEL UNDER THE LIST. The first build opened the form in
 * a card at the BOTTOM of the page via `?new=1` / `?edit=CODE`, copying the Employee ID Auto Running
 * Number screen for consistency. The reporter contested it — "not user-friendly … a poor user
 * experience" — and they were right: a form below the list means you lose your place in the list, and
 * on a catalogue whose rows you scan and switch on and off, your place IS the work. It is now
 * movement-type-dialog.tsx, a client island holding nothing but "is it open". Consequences worth
 * knowing before editing this file:
 *   • The list never moves. Opening Add or Edit is not a navigation, so scroll, search, sort and the
 *     status filter all stay exactly as they were, and Radix hands focus back to the row's own Edit
 *     button on close.
 *   • `?new=`/`?edit=` are GONE, not kept alongside. Two sources of truth for "is the form open" is
 *     precisely how the bottom panel would grow back.
 *   • THE PAGE STAYS A SERVER COMPONENT and passes the island serialisable values only — strings,
 *     booleans, and arrays of {value,label} computed HERE. Not a function, and not a function nested
 *     inside an object-literal prop either: that variant returned 500 on every request this week while
 *     tsc, the suite and the boundary guard all stayed green (test/server-client-boundary.test.ts is
 *     now depth-aware for it).
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
 * PAGED SINCE 9da61c86, REVERSING the note that stood here. It read: "NO PAGINATION, deliberately. A
 * tenant has a handful of event types; searching finds one faster than paging." The premise is still
 * true — this catalogue IS small — but the conclusion was the one fc776376 had already overturned for the
 * whole product: a control that appears only once a list grows is not a framework, it is a surprise, and
 * a reader who never sees the row count or the rows-per-page choice reports that paging does not exist.
 * The half of the note that was right is kept in full: the contract is lib/pagination + components/Pager,
 * never a hand-rolled sixth.
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
    page?: string;
    size?: string;
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

  // Filter and sort first, page second: a column header orders the whole catalogue, not one page of it.
  // The count beside the heading stays `visible.length`, the whole matching set — the pager says which
  // slice of it is on screen.
  const pq = parsePageQuery(sp);
  const { rows: pageRows, state: pgState } = paginateRows(visible, pq);

  /** Keep the whole view in the address when one control changes. Only the LIST's controls live in the
   *  address now — the Add/Edit dialog is client state and deliberately leaves no trace here. `page` is
   *  NOT carried: changing a filter or a sort re-orders the whole set, so page 4 of the old view is not
   *  page 4 of the new one. `size` IS carried, and the distinction is deliberate: the page is a position
   *  in a list the reader has just replaced, while rows-per-page is a preference about every list. */
  const href = (over: Partial<{ q: string; status: SettingsStatus; sort: string; dir: SortDir }>) => {
    const next = { q, status, sort, dir, ...over };
    const usp = new URLSearchParams();
    if (next.q) usp.set('q', next.q);
    if (next.status !== 'all') usp.set('status', next.status);
    if (next.sort !== 'catalog') usp.set('sort', next.sort);
    if (next.dir !== 'asc') usp.set('dir', next.dir);
    if (sp.size) usp.set('size', String(pq.size));
    const qs = usp.toString();
    return qs ? `${PAGE}?${qs}` : PAGE;
  };
  const sortHref = (col: 'name' | 'status' | 'created') =>
    href({ sort: col, dir: sort === col && dir === 'asc' ? 'desc' : 'asc' });

  /** The only behaviours a tenant may point one of its OWN types at — the consequence-free ones. Built
   *  in the server component and handed over as plain {value,label} rows: the island must never import
   *  core/movement-type (it pulls the pg driver through db/client) and must never be handed a
   *  translator. */
  const behaviourOptions = CONFIGURABLE_BEHAVIOUR_KINDS.map((k) => ({
    value: k as string,
    label: shippedLabel(k),
  }));
  /** Add and Edit differ only in their words; the dialog itself is one component. */
  const addLabels: MovementTypeDialogLabels = {
    title: t('addTitle'),
    hint: t('addHint'),
    name: t('columns.name'),
    namePlaceholder: t('addNamePlaceholder'),
    behaviour: t('columns.behaviour'),
    behaviourPlaceholder: t('addBehaviourPlaceholder'),
    builtInBehaviour: t('builtInBehaviour'),
    submit: t('add'),
    saving: t('saving'),
    cancel: t('cancel'),
    close: t('close'),
  };
  const editLabels: MovementTypeDialogLabels = {
    ...addLabels,
    title: t('editTitle'),
    hint: t('editHint'),
    submit: t('save'),
  };

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
          <MovementTypeDialog
            triggerLabel={t('createNew')}
            triggerClassName={btnPrimary}
            code={null}
            builtIn={false}
            initialLabel=""
            initialBehaviourKind=""
            behaviourLabel=""
            behaviourOptions={behaviourOptions}
            labels={addLabels}
          />
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
              {pageRows.map((r) => (
                <tr key={r.code}>
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
                      {/* Edit opens over the list. Closing it returns focus to THIS button, so the row
                          you were working on is still the row you are looking at. */}
                      <MovementTypeDialog
                        triggerLabel={t('edit')}
                        triggerClassName={rowActionCls}
                        code={r.code}
                        builtIn={r.builtIn}
                        initialLabel={displayLabel(r)}
                        initialBehaviourKind={r.behaviourKind}
                        behaviourLabel={shippedLabel(r.behaviourKind)}
                        behaviourOptions={behaviourOptions}
                        labels={editLabels}
                      />
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
        <Pager
          basePath={PAGE}
          params={{
            q: q || undefined,
            status: status === 'all' ? undefined : status,
            sort: sort === 'catalog' ? undefined : sort,
            dir: dir === 'asc' ? undefined : dir,
          }}
          state={pgState}
        />
      </Card>
    </div>
  );
}
