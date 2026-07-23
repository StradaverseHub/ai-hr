'use client';

import { useEffect, useState, type ReactNode } from 'react';
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

/** Sentinel selection value for the Add Leave form (leave-type ids are UUIDs, so no collision). */
const ADD = 'add';

/**
 * Leave Type configuration workspace (feedback c979aa8b): an internal LEFT PANEL listing every leave type
 * (colour dot / icon + name, selected one highlighted via the sidebar's aria-current + accent pattern,
 * components/sidebar.tsx) beside a RIGHT workspace showing the selected type's step-flow configuration
 * panel. The Add Leave button at the bottom of the panel swaps the workspace to the existing create form
 * (rendered server-side and passed in untouched via `addForm`, preserving its markup + tests).
 *
 * `panels` is a server-rendered slot map (id → that type's <LeaveTypePanel>, actions bound server-side) —
 * only the SELECTED panel mounts, so switching types is pure client state: no page reload, no nested tabs.
 *
 * Selection state + URL: the hash `#type-<id>` stays the deep-link contract (feedback 097de541 — the Leave
 * Types tab's Edit links, and the stay-on-save redirect's anchor, app/admin/actions.ts) — the workspace
 * selects the targeted type on mount and on hashchange, and writes the hash back via history.replaceState
 * on selection so the current choice survives the stay-on-save redirect. Default selection: first type.
 *
 * Mobile: the left panel collapses to a dropdown (a <select> of the types + the Add option).
 */
export function LeaveTypeWorkspace({
  items,
  panels,
  addForm,
}: {
  items: LeaveTypeWorkspaceItem[];
  panels: Record<string, ReactNode>;
  addForm: ReactNode;
}) {
  const t = useTranslations('admin.leave');
  const [selected, setSelected] = useState<string>(items[0]?.id ?? ADD);

  // Hash deep-link (#type-<id>): select the targeted type on mount and on later hashchange, replacing the
  // old per-row expand effect that lived in leave-type-panel.tsx.
  const idsKey = items.map((i) => i.id).join(',');
  useEffect(() => {
    const ids = idsKey === '' ? [] : idsKey.split(',');
    const applyHash = () => {
      const m = window.location.hash.match(/^#type-(.+)$/);
      if (m && ids.includes(m[1])) setSelected(m[1]);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [idsKey]);

  const select = (next: string) => {
    setSelected(next);
    // Keep the URL's #type-<id> in sync (replaceState — no navigation, no history spam) so reloads and the
    // stay-on-save redirect land back on the same type.
    try {
      const url = new URL(window.location.href);
      url.hash = next === ADD ? '' : `type-${next}`;
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* URL/history unavailable ⇒ selection still works, just not deep-linkable */
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 md:flex-row">
      {/* Mobile: the left panel collapses to a dropdown of the types + the Add option. */}
      <label className="md:hidden">
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
          <option value={ADD}>{t('addType')}</option>
        </select>
      </label>

      {/* Desktop: the internal left panel — type list + the Add Leave button at the bottom. */}
      <nav
        aria-label={t('workspaceTypeListLabel')}
        className="hidden w-56 shrink-0 flex-col gap-3 md:flex"
      >
        <ul className="space-y-1">
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
        <Button
          type="button"
          size="sm"
          variant={selected === ADD ? 'default' : 'outline'}
          className="mt-auto w-full"
          onClick={() => select(ADD)}
        >
          {t('addType')}
        </Button>
      </nav>

      {/* Right workspace: the selected type's step-flow panel, or the Add Leave form. */}
      <div className="min-w-0 flex-1 md:border-l md:border-border md:pl-4">
        {selected === ADD ? (
          addForm
        ) : (
          (panels[selected] ?? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('noLeaveTypes')}</p>
          ))
        )}
      </div>
    </div>
  );
}
