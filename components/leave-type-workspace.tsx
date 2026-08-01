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
};

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
  // 1bd9a911 — the capped, scrollable desktop list. Kept so the highlighted row can be revealed inside it.
  const listRef = useRef<HTMLUListElement | null>(null);

  // Hash deep-link (#type-<id>): select the targeted type on mount and on later hashchange, replacing the
  // old per-row expand effect that lived in leave-type-panel.tsx. After a create, the action's redirect
  // lands here with the NEW id — `items` gains the type, idsKey changes, the effect re-runs, and the new
  // type is selected while the Add dialog closes (8cc268c4's "save selects the new type" promise).
  const idsKey = items.map((i) => i.id).join(',');
  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    const applyHash = () => {
      const m = window.location.hash.match(/^#type-(.+)$/);
      if (m && ids.includes(m[1])) {
        setSelected(m[1]);
        setAddOpen(false);
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [idsKey]);

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

  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row">
      {/* Mobile: the left panel collapses to a dropdown of the types + the Add button opening the dialog. */}
      <div className="flex items-center gap-2 md:hidden">
        <label className="min-w-0 flex-1">
          <span className="sr-only">{t('workspaceTypeListLabel')}</span>
          <select
            value={selected}
            onChange={(e) => select(e.target.value)}
            aria-label={t('workspaceTypeListLabel')}
            className={`${inputCls} w-full`}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          {t('addType')}
        </Button>
        {sharedGroups}
      </div>

      {/* Desktop: the internal left panel — type list + the Add Leave button at the bottom. */}
      <nav
        aria-label={t('workspaceTypeListLabel')}
        className="hidden w-56 shrink-0 flex-col gap-3 md:flex"
      >
        {/* 1bd9a911 — max-height (not a hard height) so a short list leaves no empty gap; pr-1 keeps the
            scrollbar clear of the type names. The Add Leave button below stays outside the scroll area. */}
        <ul ref={listRef} className="max-h-[28rem] space-y-1 overflow-y-auto pr-1">
          {items.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">{t('noLeaveTypes')}</li>
          )}
          {items.map((item) => {
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
