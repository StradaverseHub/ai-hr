'use client';

/**
 * Customize Columns — the Personnel listing's per-user column picker (feedback 579255c3, points 2 & 3).
 *
 * A CLIENT island with a strictly serialisable interface: it receives pre-translated `columns` (key +
 * label + whether the column can be switched off) and the caller's saved `selected` set, and it hands
 * back a `{ selected, order }` payload through the two SERVER ACTIONS passed in as props — the same
 * shape components/dashboard-customizer.tsx uses. NO closure over the server's translator crosses this
 * boundary; that class of prop 500s every request while tsc, the suite and `next build` all stay green
 * (test/server-client-boundary.test.ts exists because it once shipped).
 *
 * REORDERING IS NATIVE HTML5 DRAG (the app/admin/leave-approval/step-list-editor.tsx pattern) rather
 * than @dnd-kit: this is a one-dimensional list of sixteen rows, and the ↑ / ↓ buttons beside each row
 * are not a fallback but the accessible path — a drag handle alone is unusable by keyboard, and this is
 * a screen HR lives on all day.
 *
 * The panel is a DRAFT until Apply: ticking and dragging change local state only, so an interrupted
 * fiddle costs nothing and Apply is the single write. Apply persists per user (app_user.list_preferences
 * via the own-row seam) and refreshes the server-rendered table so the columns and the Export link that
 * follows them are rebuilt from the saved value, not guessed at on the client.
 */

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Columns3, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui';

export type EmployeeColumnChoice = {
  key: string;
  label: string;
  /** Full Name cannot be switched off — it carries the profile link. Rendered ticked and disabled. */
  mandatory?: boolean;
};

export type ColumnPickerLabels = {
  /** Trigger button + panel dialog label, e.g. "Customize Columns". */
  title: string;
  /** "Tick to show. Drag to reorder." */
  hint: string;
  apply: string;
  reset: string;
  moveUp: string;
  moveDown: string;
  /** Pre-resolved sentence naming the fields that do not exist yet (18103ba4's precedent). */
  unavailableNote: string;
};

export function ColumnPicker({
  columns,
  selected,
  labels,
  saveAction,
  resetAction,
}: {
  /** Every catalogue column, in the caller's saved ORDER (shown and hidden alike). */
  columns: EmployeeColumnChoice[];
  selected: string[];
  labels: ColumnPickerLabels;
  saveAction: (prefs: { selected: string[]; order: string[] }) => Promise<void>;
  resetAction: () => Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [order, setOrder] = useState<EmployeeColumnChoice[]>(columns);
  const [on, setOn] = useState<string[]>(selected);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Re-seed from the server whenever the saved value changes underneath us (an Apply elsewhere, a
  // reset, a fresh render). Without this the panel would keep showing the draft it was mounted with.
  useEffect(() => {
    setOrder(columns);
    setOn(selected);
    // The two arrays are rebuilt by the server on every render, so compare by VALUE, not identity.
  }, [columns.map((c) => c.key).join(','), selected.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const moveTo = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
  };

  const toggle = (key: string, mandatory?: boolean) => {
    if (mandatory) return;
    setOn((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };

  const apply = () => {
    const orderKeys = order.map((c) => c.key);
    // Hand back the selection IN THE PANEL'S ORDER: the server normaliser re-sorts anyway, and sending
    // a selection whose sequence disagrees with the order is how a table ends up in a third sequence.
    const selectedKeys = orderKeys.filter((k) => on.includes(k));
    startTransition(async () => {
      await saveAction({ selected: selectedKeys, order: orderKeys });
      setOpen(false);
      router.refresh();
    });
  };

  const reset = () => {
    startTransition(async () => {
      await resetAction();
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-tour="people-columns"
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground transition duration-150 ease-snappy hover:bg-muted active:scale-[0.98]"
      >
        <Columns3 className="size-4 text-muted-foreground" aria-hidden />
        {labels.title}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={labels.title}
            className="absolute right-0 z-50 mt-1 w-[min(20rem,90vw)] origin-top-right rounded-lg border border-border bg-popover text-popover-foreground shadow-lg transition duration-150 ease-snappy starting:scale-95 starting:opacity-0"
          >
            <p className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">{labels.hint}</p>
            <ul className="max-h-[50vh] overflow-y-auto py-1">
              {order.map((c, i) => (
                <li
                  key={c.key}
                  draggable
                  data-column={c.key}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null) moveTo(dragIndex, i);
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                  className={`flex cursor-grab items-center gap-2 px-3 py-1.5 text-sm active:cursor-grabbing ${
                    dragIndex === i ? 'opacity-50' : ''
                  }`}
                >
                  <GripVertical className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={on.includes(c.key)}
                      disabled={!!c.mandatory}
                      onChange={() => toggle(c.key, c.mandatory)}
                      className="size-4 shrink-0 rounded border-border text-primary focus:ring-primary disabled:opacity-50"
                    />
                    <span className={`truncate ${on.includes(c.key) ? '' : 'text-muted-foreground'}`}>
                      {c.label}
                    </span>
                  </label>
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      aria-label={`${labels.moveUp}: ${c.label}`}
                      disabled={i === 0}
                      onClick={() => moveTo(i, i - 1)}
                      className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`${labels.moveDown}: ${c.label}`}
                      disabled={i === order.length - 1}
                      onClick={() => moveTo(i, i + 1)}
                      className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                    >
                      ↓
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {/* 18103ba4's precedent: the fields that do not exist yet are NAMED here rather than silently
                left out of the list, so "where is Division?" is answered on the screen that asks it. */}
            <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {labels.unavailableNote}
            </p>
            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
              <button
                type="button"
                onClick={reset}
                disabled={pending}
                className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              >
                {labels.reset}
              </button>
              <Button type="button" size="sm" onClick={apply} disabled={pending}>
                {labels.apply}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
