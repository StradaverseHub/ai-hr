import { getTranslations } from 'next-intl/server';
import { requireAdmin } from '@/lib/authz';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import Link from '@/components/intent-link';
import { listMovementEventTypesForSettings } from '@/core/movement-type';
import { paginateRows, parsePageQuery } from '@/lib/pagination';
import { Pager } from '@/components/pager';
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
import { deleteMovementEventTypeAction, setMovementEventTypeActiveAction } from './actions';
import { DeleteExplanation } from './delete-explanation';
import { MovementSettingsTabs } from './movement-settings-tabs';

const PAGE = '/admin/settings/movement';

/**
 * Movement Settings — the movement event type catalogue (476f23ed, redesigned by 1b87e8a0, re-laid by
 * 1d58019a).
 *
 * 1d58019a (Step 1, ADR-0165) — WHAT CHANGED ON THIS SCREEN, AND ONLY THAT:
 *   • FULL WIDTH (pageWideCls) and TWO TABS: Event Types (this page) and Termination Reasons
 *     (./reasons/page.tsx). Each tab is a real sub-route, the house tab idiom.
 *   • Two new columns. CLASSIFICATION is DERIVED from the behaviour — Termination for the termination
 *     behaviour, Non-Termination for everything else — and is read-only in this step; it has no column of
 *     its own in the database, so it cannot disagree with what the type does. DESCRIPTION is the optional
 *     note the configuration page edits (movement_event_type.description, migration 0721). The old "What It
 *     Does" column moved onto the configuration page with the picker it describes.
 *   • DELETE ON EVERY ROW. A deletable row (one of the organisation's own that nothing has recorded) keeps
 *     the ordinary confirm-and-delete. A built-in or in-use row opens delete-explanation.tsx: why it cannot
 *     be deleted, with Switch Off offered instead. The button used to be missing on those rows, and nobody
 *     was told why. The service refusals stay authoritative either way.
 *   • ADD AND EDIT ARE PAGES, NOT A MODAL: /types/new and /types/[code] (event-type-config-page.tsx). The
 *     reporter asked for a dedicated configuration page organised in cards; the modal that 1b87e8a0's
 *     re-build introduced is retired, and so are its `?new=`/`?edit=` predecessors — still no second
 *     source of truth for "is the form open".
 *
 * WHAT STAYS (each line was a decision once — see git history for the full notes):
 *   • The toolbar, search, sort and status filter come from components/settings-list.tsx, the shared
 *     System Settings idiom (test/settings-list-idiom.test.ts).
 *   • PAGED SINCE 9da61c86, REVERSING the note that once stood here. It read:
 *     "NO PAGINATION, deliberately. A tenant has a handful of event types; searching finds one faster than paging." The
 *     premise is still true, but a control that appears only once a list grows is a surprise, not a
 *     framework (fc776376). The contract is lib/pagination + components/Pager, never a hand-rolled sixth.
 *   • Created, not Last Updated: there is no updated_at, and a built-in reads "Built-in" because it has no
 *     creation date (MovementEventTypeRow.createdAt).
 *   • Status defaults to ALL: switching a type back on is a main reason to open this screen.
 *   • THE PAGE STAYS A SERVER COMPONENT and hands client islands serialisable values only.
 *   • A built-in type's BEHAVIOUR is never editable; a custom type may only map onto a consequence-free
 *     behaviour (CONFIGURABLE_BEHAVIOUR_KINDS). The service refuses the rest independently of any screen.
 *
 * Viewing is admin-only in the service too (listMovementEventTypesForSettings), not only in requireAdmin().
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

  const rows = await listMovementEventTypesForSettings(s);

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

  /** 1d58019a — derived, never stored: see the header. */
  const isTermination = (r: { behaviourKind: string }) => r.behaviourKind === 'termination';
  const editHref = (code: string) => `${PAGE}/types/${encodeURIComponent(code)}`;

  return (
    <div className={pageWideCls}>
      <PageHeader title={t('title')} description={t('description')} />
      <MovementSettingsTabs active="types" labels={{ types: t('tabs.types'), reasons: t('tabs.reasons') }} />
      <ErrorBanner message={sp.error} />

      <Card className="overflow-hidden">
        <SettingsToolbar>
          <Link href={`${PAGE}/types/new`} className={btnPrimary}>
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
                <th className={thCls}>{t('columns.classification')}</th>
                <th className={thCls}>{t('columns.description')}</th>
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
                    <Badge variant={isTermination(r) ? 'danger' : 'accent'}>
                      {isTermination(r) ? t('classification.termination') : t('classification.nonTermination')}
                    </Badge>
                  </td>
                  <td className="max-w-xs px-3 py-2 text-xs text-muted-foreground">
                    {r.description ?? <span className="italic">{t('noDescription')}</span>}
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
                      {/* 1d58019a — Edit opens the type's own configuration page. */}
                      <Link href={editHref(r.code)} className={rowActionCls}>
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
                      {/* 1d58019a — Delete on EVERY row. Only a custom type nothing has recorded is actually
                          deletable; every other row's Delete explains why not and offers Switch Off. */}
                      {!r.builtIn && !r.inUse ? (
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
                      ) : (
                        <DeleteExplanation
                          target="type"
                          code={r.code}
                          triggerLabel={t('delete')}
                          title={t('deleteBlocked.title', { name: displayLabel(r) })}
                          paragraphs={[
                            r.inUse ? t('deleteBlocked.inUse') : t('deleteBlocked.builtIn'),
                            r.active ? t('deleteBlocked.switchOffInstead') : t('deleteBlocked.alreadyOff'),
                          ]}
                          closeLabel={t('close')}
                          switchOffLabel={r.active ? t('deactivate') : null}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
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
