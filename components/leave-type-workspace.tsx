'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { LEAVE_COLORS, LEAVE_ICONS, isLeaveColorToken, isLeaveIconKey } from '@/lib/leave-visual';
import { Button, inputCls } from './ui';

/** One row of the internal left panel — the identity + visual config the list entry renders. */
export type LeaveTypeWorkspaceItem = {
  id: string;
  name: string;
  code: string;
  archived: boolean;
  /** Visual config (639fdf77): colour token + icon key for the list entry's dot/icon. null = default. */
  color: string | null;
  icon: string | null;
  /**
   * r224 — "this leave type's entitlement tables reach nobody", as a SHORT TRANSLATED STRING prepared by
   * the server page, or null when there is nothing to say.
   *
   * ⚠️ IT IS A STRING, NOT A BOOLEAN, and that is the boundary rule rather than a style choice: this is a
   * client component and the page that mounts it is a server one, so a flag would force this file to own a
   * second copy of the wording and a `useTranslations` for a namespace it otherwise never reads. Only plain
   * data crosses (test/server-client-boundary.test.ts).
   *
   * WHY IT IS ON THE LIST AT ALL. The finding itself has been derived since r209 and rendered inside each
   * type's own Entitlement step — which is precisely the reporter's complaint: nine of eleven leave types
   * were reaching nobody and you had to open each one, on the right step, to find out. The list is the one
   * surface where every type is visible at once, so this is where "which of these is not working" belongs.
   */
  alert?: string | null;
};

/**
 * a3411394 — which rows the type rail lists.
 *
 * PRESENTATION ONLY, and that is the whole design of this item. `items` already carried `archived` per row
 * (it is what drew the dimming), so the three views and their counts are read off the SAME array the page
 * sends: no new prop, no second query, no server change. The page keeps deciding the ORDER, `panels` keeps
 * holding every type whether it is drawn in the rail or not, and archive / unarchive are untouched.
 */
type LeaveTypeFilter = 'active' | 'archived' | 'all';

const matchesFilter = (item: LeaveTypeWorkspaceItem, filter: LeaveTypeFilter) =>
  filter === 'all' ? true : filter === 'archived' ? item.archived : !item.archived;

/**
 * Dialog-close wrapper for the Add Leave Type form's Cancel button (8cc268c4). Exported so the SERVER-rendered
 * addForm slot (app/admin/leave/entitlements/page.tsx) can place a Cancel button beside its Save button —
 * Radix context resolves at runtime because the slot mounts inside this workspace's Dialog.Content.
 */
export function AddLeaveTypeCancel({ children }: { children: ReactNode }) {
  return (
    <Dialog.Close asChild>
      <Button type="button" variant="outline">
        {children}
      </Button>
    </Dialog.Close>
  );
}

/**
 * Leave Type configuration workspace (feedback c979aa8b): an internal LEFT PANEL listing every leave type
 * (colour dot / icon + name, selected one highlighted via the sidebar's aria-current + accent pattern,
 * components/sidebar.tsx) beside a RIGHT workspace showing the selected type's step-flow configuration
 * panel.
 *
 * Add Leave Type pop-up (feedback 8cc268c4): the + Add Leave button no longer swaps the right pane to the
 * create form (the old ADD-sentinel selection) — it opens a modal Dialog titled "Add Leave Type" OVER the
 * current view, so the admin never loses their place in the type they were configuring. The dialog body is
 * the SAME server-rendered create form passed in via `addForm` (self-contained form + server action — no
 * hidden-input bridging); Cancel (AddLeaveTypeCancel above) closes without saving, Save posts
 * createLeaveTypeAction whose redirect carries #type-<new id> — the hash effect below then selects the new
 * type AND closes the dialog.
 *
 * `panels` is a server-rendered slot map (id → that type's <LeaveTypePanel>, actions bound server-side) —
 * only the SELECTED panel mounts, so switching types is pure client state: no page reload, no nested tabs.
 *
 * Selection state + URL: the hash `#type-<id>` stays the deep-link contract (feedback 097de541 — the Leave
 * Types tab's Edit links, and the stay-on-save redirect's anchor, app/admin/actions.ts) — the workspace
 * selects the targeted type on mount and on hashchange, and writes the hash back via history.replaceState
 * on selection so the current choice survives the stay-on-save redirect. Default selection: first type.
 *
 * Mobile: the left panel collapses to a dropdown (a <select> of the types) beside an Add button opening the
 * same dialog.
 *
 * List display (feedback 1bd9a911): `items` arrives already ordered by the server page (active types first,
 * then archived, each A–Z) — this component does not re-sort. The desktop list is capped to a fixed height
 * with its own scrollbar so a long type list scrolls inside the panel instead of stretching the page, and
 * the selected row is scrolled into view within that panel (deep link / just-added type).
 *
 * Archived types (feedback a3411394): the rail carries a three-way filter — Active (the default), Archived
 * and All, each with its count — and an archived row now says the word rather than only looking faded. The
 * report was "the archived record is not appearing in the archived list"; the row was rendered all along
 * (server-ordered last, `opacity-60`), and it was the archived LIST that did not exist — no filter, no
 * section, no count, and the word "Archived" nowhere on the screen. With nineteen types the faded row sat
 * below the fold of the capped panel above.
 *
 * ⚠️ DEFAULTING TO ACTIVE IS A BEHAVIOUR CHANGE, deliberately: an archived type is no longer in the rail at
 * all under the opening view, where before it could be found by scrolling to the bottom. It is now reached
 * by asking for it. Nothing else moves — this is presentation over the array the page already sends.
 */
export function LeaveTypeWorkspace({
  items,
  panels,
  addForm,
  sharedGroups,
}: {
  items: LeaveTypeWorkspaceItem[];
  panels: Record<string, ReactNode>;
  addForm: ReactNode;
  /** r88 1ef1cf95 — the Shared Leave Group manager, mounted BESIDE Add Leave Type because that is the level
   *  a group is now defined at: a group names leave types, not a benefit scheme. A slot rather than a direct
   *  import so this workspace keeps knowing nothing about server actions. Optional: hosts that render the
   *  workspace without the manager (none today) simply omit it. */
  sharedGroups?: ReactNode;
}) {
  const t = useTranslations('admin.leave');
  const [selected, setSelected] = useState<string>(items[0]?.id ?? '');
  // 8cc268c4 — the Add Leave Type dialog. Controlled state so BOTH triggers (desktop panel-bottom button +
  // mobile button beside the dropdown) open the one dialog, and the hash effect can close it after a save.
  const [addOpen, setAddOpen] = useState(false);
  // a3411394 — the rail's Active / Archived / All view. 'active' is the default so the screen opens the way
  // it does today for anyone who never archives anything.
  const [filter, setFilter] = useState<LeaveTypeFilter>('active');
  // 1bd9a911 — the capped, scrollable desktop list. Kept so the highlighted row can be revealed inside it.
  const listRef = useRef<HTMLUListElement | null>(null);

  // Hash deep-link (#type-<id>): select the targeted type on mount and on later hashchange, replacing the
  // old per-row expand effect that lived in leave-type-panel.tsx. After a create, the action's redirect
  // lands here with the NEW id — `items` gains the type, idsKey changes, the effect re-runs, and the new
  // type is selected while the Add dialog closes (8cc268c4's "save selects the new type" promise).
  const idsKey = items.map((i) => i.id).join(',');
  // a3411394 — the same list, narrowed to the archived ids, so the effect below can tell whether the type a
  // deep link just selected is one the default view hides. A second derived key rather than a richer one:
  // `idsKey` is a dependency of an effect that has worked since c979aa8b, and changing its SHAPE to carry a
  // flag would change when that effect re-runs for reasons that have nothing to do with this item.
  const archivedKey = items.filter((i) => i.archived).map((i) => i.id).join(',');
  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    const archivedIds = archivedKey === '' ? [] : archivedKey.split(',');
    const applyHash = () => {
      const m = window.location.hash.match(/^#type-(.+)$/);
      if (m && ids.includes(m[1])) {
        setSelected(m[1]);
        setAddOpen(false);
        // a3411394 — a #type-<id> deep link can target an ARCHIVED type: the Leave Types tab's Edit links
        // and every stay-on-save redirect (okEntitlements / failEntitlements) carry one. Under the default
        // Active view that row is filtered out, so the screen would show the type's panel beside a rail
        // with nothing selected in it. Widen to ALL rather than to Archived: the reader arrived at one
        // type, not at a tour of the archive, and All keeps its neighbours in view.
        if (archivedIds.includes(m[1])) setFilter('all');
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [idsKey, archivedKey]);

  // 1bd9a911 — keep the selected type visible inside the capped list: a type reached via the #type-<id> deep
  // link or created just now can sit below the panel's fold. block:'nearest' scrolls the list container the
  // minimum amount and is a no-op when the row is already visible, so ordinary clicks never jump.
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const select = (next: string) => {
    setSelected(next);
    // Keep the URL's #type-<id> in sync (replaceState — no navigation, no history spam) so reloads and the
    // stay-on-save redirect land back on the same type.
    try {
      const url = new URL(window.location.href);
      url.hash = `type-${next}`;
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* URL/history unavailable ⇒ selection still works, just not deep-linkable */
    }
  };

  // a3411394 — the three counts and the visible rows, all read off the one `items` array in the order the
  // server already put it in. Nothing is re-sorted here (the header above says so, and it stays true).
  const counts: Record<LeaveTypeFilter, number> = {
    active: items.filter((i) => !i.archived).length,
    archived: items.filter((i) => i.archived).length,
    all: items.length,
  };
  const visibleItems = items.filter((i) => matchesFilter(i, filter));

  const chooseFilter = (next: LeaveTypeFilter) => {
    setFilter(next);
    // Keep the rail and the workspace pane in step. A view that hides the SELECTED type would leave the
    // list with no aria-current row beside a panel for a type the reader cannot see — and on mobile that is
    // worse than cosmetic, because a <select> whose `value` matches none of its options paints its FIRST
    // option while state still says otherwise. Moving the selection to the first visible type is also what
    // makes Archived answer the question it was clicked to ask: the Unarchive button lives INSIDE the
    // panel, so the archived type has to be selected for it to be on screen at all. An empty view moves
    // nothing — there is nothing to move to, and the panel already open beats a blank pane.
    const nextVisible = items.filter((i) => matchesFilter(i, next));
    if (nextVisible.length > 0 && !nextVisible.some((i) => i.id === selected)) select(nextVisible[0].id);
  };

  const filterButton = (key: LeaveTypeFilter, label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => chooseFilter(key)}
      aria-pressed={filter === key}
      className={cn(
        'flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
        filter === key
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {/* NOT truncated, and the group wraps instead: a filter chip reading "Archiv…" in a locale with a
          longer word for it is the same defect this item is about — a state the reader cannot read. */}
      <span>{label}</span>
      {/* The count is the half that answers "is there anything in there?" without a click — an Archived (0)
          is a complete answer, and it is the answer the reporter could not get at all. */}
      <span className="inline-flex min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-semibold tabular-nums leading-4">
        {counts[key]}
      </span>
    </button>
  );

  /* Rendered in BOTH the mobile block and the desktop rail, from one piece of state: the dropdown and the
     list show the same rows, so a phone and a laptop cannot disagree about which types exist. */
  const typeFilter = (
    <div
      role="group"
      aria-label={t('workspaceFilterLabel')}
      className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1"
    >
      {filterButton('active', t('workspaceFilterActive'))}
      {filterButton('archived', t('workspaceFilterArchived'))}
      {filterButton('all', t('workspaceFilterAll'))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row">
      {/* Mobile: the left panel collapses to a dropdown of the types + the Add button opening the dialog. */}
      <div className="flex flex-col gap-2 md:hidden">
        {typeFilter}
        <div className="flex items-center gap-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">{t('workspaceTypeListLabel')}</span>
            <select
              value={selected}
              onChange={(e) => select(e.target.value)}
              aria-label={t('workspaceTypeListLabel')}
              className={`${inputCls} w-full`}
            >
              {visibleItems.map((item) => (
                /* The mobile control is a native <select>, which can hold no badge — the alert, and now the
                   archived state (a3411394), ride in the option text so the dropdown says the same thing the
                   desktop list does. `opacity-60` cannot cross into an <option> at all, so on a phone this is
                   not a second cue: without it the dropdown says NOTHING about an archived type. */
                <option key={item.id} value={item.id}>
                  {[item.name, item.archived ? t('archivedBadge') : null, item.alert]
                    .filter(Boolean)
                    .join(' — ')}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            {t('addType')}
          </Button>
          {sharedGroups}
        </div>
      </div>

      {/* Desktop: the internal left panel — type list + the Add Leave button at the bottom. */}
      <nav
        aria-label={t('workspaceTypeListLabel')}
        className="hidden w-56 shrink-0 flex-col gap-3 md:flex"
      >
        {/* a3411394 — the filter sits ABOVE the capped list, outside its scroll area, so the counts stay
            readable however far down the list the reader has scrolled. */}
        {typeFilter}
        {/* 1bd9a911 — max-height (not a hard height) so a short list leaves no empty gap; pr-1 keeps the
            scrollbar clear of the type names. The Add Leave button below stays outside the scroll area. */}
        <ul ref={listRef} className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
          {visibleItems.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {/* TWO DIFFERENT EMPTINESSES. "No leave types." said to someone who has just clicked
                  Archived (0) is a claim about the catalogue answering a question about the view. */}
              {items.length === 0 ? t('noLeaveTypes') : t('workspaceFilterEmpty')}
            </li>
          )}
          {visibleItems.map((item) => {
            const active = selected === item.id;
            const Icon = item.icon && isLeaveIconKey(item.icon) ? LEAVE_ICONS[item.icon].Icon : null;
            const colorCls =
              item.color && isLeaveColorToken(item.color)
                ? `${LEAVE_COLORS[item.color].bg} ${LEAVE_COLORS[item.color].text}`
                : 'bg-muted text-muted-foreground';
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => select(item.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    item.archived && 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full',
                      colorCls,
                    )}
                    aria-hidden
                  >
                    {Icon ? (
                      <Icon className="size-3.5" aria-hidden />
                    ) : (
                      <span className="size-2 rounded-full bg-current opacity-70" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  {/* a3411394 — the state, in words, on the row. The dimming stays (it is still a useful
                      secondary cue) but it was the ONLY cue, and "a little lighter than the rest" is not
                      something a reader can look for. Same message key and same treatment as the panel
                      header's badge (leave-type-tabs.tsx), so the rail and the open type say one word. */}
                  {item.archived ? (
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('archivedBadge')}
                    </span>
                  ) : null}
                  {/* r224 — the flag, on the row. Amber rather than red: the leave type is misconfigured,
                      not broken, and red is already spoken for by the blocking findings inside the step. */}
                  {item.alert ? (
                    <span
                      className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
                      title={item.alert}
                    >
                      {item.alert}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        {/* r88 1ef1cf95 — Add Leave Type and Shared Leave Groups sit together at the foot of the type list:
            both are leave-TYPE-level structural actions, and a group is defined over these very types. */}
        <div className="mt-auto flex flex-col gap-2">
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setAddOpen(true)}>
            {t('addType')}
          </Button>
          {sharedGroups}
        </div>
      </nav>

      {/* Right workspace: the selected type's step-flow panel — never swapped for the add form (8cc268c4). */}
      <div className="min-w-0 flex-1 md:border-l md:border-border md:pl-4">
        {panels[selected] ?? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveTypes')}</p>
        )}
      </div>

      {/* 8cc268c4 — the Add Leave Type pop-up. Shell follows the house dialog pattern (family-form-dialog.tsx):
          overlay + centred scrollable Content; the body is the untouched server-rendered create form, which
          carries its own Cancel (AddLeaveTypeCancel) / Save footer. Radix provides the focus trap + Esc/overlay
          dismissal; a successful save is dismissed by the redirect's #type-<id> via the hash effect above. */}
      <Dialog.Root open={addOpen} onOpenChange={setAddOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-4rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg"
          >
            <div className="flex items-start justify-between gap-4">
              <Dialog.Title className="text-base font-semibold">{t('addTypeDialogTitle')}</Dialog.Title>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm" aria-label={t('cancel')}>
                  ✕
                </Button>
              </Dialog.Close>
            </div>
            <div className="mt-4">{addForm}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
