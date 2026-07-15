'use client';

/**
 * Employee dashboard customize island (feedback 7d9d145d → add/remove/shortcut in 578a2fcf).
 *
 * The server pre-renders each information card into `blocks[cardKey]` (plain server JSX) and passes the
 * HR-configured card catalog in `cards`; this client island decides WHICH cards are shown and in what
 * ORDER — it reads no data of its own, so the server/RSC boundary stays clean (the page RENDERS this
 * component; it never calls a function out of a 'use client' module).
 *
 * Normal mode: render the employee's selected cards in their saved order + a "Customize Dashboard" button.
 * Customize mode (feedback dashgrid): a @dnd-kit 2-D grid — the first row is the employee's draggable
 *   widget grid (max 4 across on desktop, extra cards wrap); a fixed second row pins the shortcut/action
 *   cards + Planned Absences so the everyday actions always have a home. The live render IS the preview, plus
 *   • Add Card — a menu of employee-selectable cards not currently shown.
 *   • Remove (×) on each optional card; mandatory cards refuse removal with a shake + the message
 *     "This dashboard card is mandatory and cannot be removed."
 *   • Save Changes — gated behind the confirmation dialog (feedback 31b46dcc); Cancel reverts; Reset to
 *     Default clears the saved layout back to the HR default.
 *
 * Action / Shortcut cards (cardType 'action' | 'shortcut') that have no bespoke server node render as a
 * clickable ShortcutCard linking straight to their configured destination (leave / claims / payslip / ...).
 */

import { type ReactNode, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, GripVertical, Pin, Plus, X } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { MAX_FIRST_ROW, partitionDashboardRows, type DashboardLayout } from '@/lib/dashboard-layout';

/** One HR-configured card the employee may show / add / reorder. */
export type CustomizerCard = {
  key: string;
  label: string;
  cardType: 'information' | 'action' | 'shortcut';
  href: string | null;
  mandatory: boolean;
  defaultDisplay: boolean;
  employeeSelectable: boolean;
};

/** A shortcut/action card with no bespoke server node — a clickable jump to its configured destination. */
function ShortcutCard({ label, href, badge }: { label: string; href: string; badge: string }) {
  return (
    <Link href={href} className="block">
      <Card className="flex items-center justify-between gap-3 p-5 transition-colors hover:border-foreground/20">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-primary/80">{badge}</div>
          <div className="mt-1 truncate text-lg font-semibold tracking-tight">{label}</div>
        </div>
        <ArrowUpRight className="size-5 shrink-0 text-muted-foreground" />
      </Card>
    </Link>
  );
}

/** Draggable wrapper around one dashboard card (only mounted in customize mode). */
function SortableCard({
  id,
  label,
  mandatory,
  shaking,
  mandatoryMessage,
  onRemove,
  children,
}: {
  id: string;
  label: string;
  mandatory: boolean;
  shaking: boolean;
  mandatoryMessage: string;
  onRemove: (id: string) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const t = useTranslations('dashboard');
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-card-key={id}
      className={`relative rounded-2xl border-2 border-dashed border-primary/30 p-2 ${
        isDragging ? 'opacity-80 shadow-lg' : ''
      } ${shaking ? 'animate-shake border-destructive/60' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          aria-label={label}
          className="grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-primary/40"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => onRemove(id)}
          aria-label={t('removeCardAria', { card: label })}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-destructive/40"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* The card preview is inert while customizing so drags don't trigger inner links/controls. */}
      <div className="pointer-events-none select-none">{children}</div>
      {shaking && (
        <p role="alert" className="mt-2 px-1 text-xs font-medium text-destructive">
          {mandatoryMessage}
        </p>
      )}
      {mandatory && !shaking && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">{t('mandatoryCardHint')}</p>
      )}
    </div>
  );
}

/** A card pinned to the fixed second row (customize mode): shown inert, no grip / no remove. */
function FixedCard({ label, children }: { label: string; children: ReactNode }) {
  const t = useTranslations('dashboard');
  return (
    <div className="relative rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-muted/20 p-2">
      <div className="mb-2 flex items-center gap-2">
        <Pin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('pinnedBadge')}
        </span>
      </div>
      <div className="pointer-events-none select-none">{children}</div>
    </div>
  );
}

export function DashboardCustomizer({
  cards,
  blocks,
  layout,
  saveAction,
  resetAction,
}: {
  /** Every ACTIVE HR-configured card, in display order (the add menu + labels come from here). */
  cards: CustomizerCard[];
  /** Pre-rendered server node per cardKey for information cards that have one. */
  blocks: Record<string, ReactNode>;
  /** The caller's saved, already-normalised layout ({ selected, order }). */
  layout: DashboardLayout;
  saveAction: (layout: { selected: string[]; order: string[] }) => Promise<void>;
  resetAction: () => Promise<void>;
}) {
  const t = useTranslations('dashboard');
  const byKey = useMemo(() => new Map(cards.map((c) => [c.key, c])), [cards]);
  // The HR default (Reset target): every mandatory or default-display card, in display order.
  const defaultVisible = useMemo(
    () => cards.filter((c) => c.mandatory || c.defaultDisplay).map((c) => c.key),
    [cards],
  );

  // `baseline` = last saved visible set (Cancel reverts here); `visible` = the working/preview set.
  const [baseline, setBaseline] = useState<string[]>(layout.selected);
  const [visible, setVisible] = useState<string[]>(layout.selected);
  const [customizing, setCustomizing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [shakeKey, setShakeKey] = useState<string | null>(null);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const addable = cards.filter((c) => c.employeeSelectable && !visible.includes(c.key));

  // Row assignment (feedback dashgrid) is DERIVED from the card config, never persisted: shortcut/action
  // cards + Planned Absences are pinned to the fixed second row; everything else selected is a draggable
  // first-row widget. See lib/dashboard-layout.partitionDashboardRows / the design-tension note there.
  const isPinned = (key: string): boolean => {
    const c = byKey.get(key);
    if (!c) return false;
    return c.cardType === 'shortcut' || c.cardType === 'action' || key === 'plannedAbsences';
  };
  const pinnedKeys = useMemo(() => new Set(visible.filter(isPinned)), [visible, byKey]);
  const { row1: sortableKeys, row2: fixedKeys } = partitionDashboardRows(
    { selected: visible, order: visible },
    pinnedKeys,
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setVisible((cur) => {
      // 2-D grid reorder: dnd-kit's rectSortingStrategy maps the grid geometry onto the flat first-row
      // order, so a straight arrayMove over the (non-pinned) row-1 keys is the correct L/R + up/down move.
      const row1 = cur.filter((k) => !isPinned(k));
      const row2 = cur.filter((k) => isPinned(k));
      const from = row1.indexOf(active.id as string);
      const to = row1.indexOf(over.id as string);
      if (from < 0 || to < 0) return cur; // over a pinned/absent target → spring back (no-op)
      const nextRow1 = arrayMove(row1, from, to);
      // Max-4 first row is enforced by the MAX_FIRST_ROW-column grid (extra cards wrap below); a reorder
      // never changes the count, so this stays within the cap. Rebuild visible as row1-then-fixed.
      return [...nextRow1, ...row2];
    });
  };

  const triggerShake = (id: string) => {
    setShakeKey(id);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShakeKey(null), 600);
  };

  const removeCard = (id: string) => {
    const card = byKey.get(id);
    if (card?.mandatory) {
      // Mandatory cards can't be removed → shake + message, card stays.
      triggerShake(id);
      return;
    }
    setVisible((cur) => cur.filter((k) => k !== id));
  };

  const addCard = (id: string) => {
    setVisible((cur) => (cur.includes(id) ? cur : [...cur, id]));
    setAddOpen(false);
  };

  const enterCustomize = () => {
    setVisible(baseline);
    setCustomizing(true);
  };
  const cancel = () => {
    setVisible(baseline);
    setShakeKey(null);
    setAddOpen(false);
    setCustomizing(false);
  };
  const save = () => {
    const next = visible;
    startTransition(async () => {
      await saveAction({ selected: next, order: next });
      setBaseline(next);
      setCustomizing(false);
      setAddOpen(false);
    });
  };
  const reset = () => {
    startTransition(async () => {
      await resetAction();
      setVisible(defaultVisible);
      setBaseline(defaultVisible);
      setCustomizing(false);
      setAddOpen(false);
    });
  };

  /** Resolve the render node for a card: bespoke server block, else a generic shortcut link, else null. */
  const nodeFor = (key: string): ReactNode => {
    if (blocks[key] !== undefined) return blocks[key];
    const card = byKey.get(key);
    if (card && card.href) return <ShortcutCard label={card.label} href={card.href} badge={t('shortcutBadge')} />;
    return null;
  };

  const labelFor = (key: string) => byKey.get(key)?.label ?? key;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {customizing ? (
          <>
            <p className="text-sm text-muted-foreground">{t('customizeHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              {/* Add Card — employee-selectable cards not currently shown. */}
              <div className="relative">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAddOpen((o) => !o)}
                  disabled={pending || addable.length === 0}
                  aria-haspopup="menu"
                  aria-expanded={addOpen}
                >
                  <Plus className="mr-1 size-4" />
                  {t('addCard')}
                </Button>
                {addOpen && addable.length > 0 && (
                  <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                  >
                    {addable.map((c) => (
                      <button
                        key={c.key}
                        type="button"
                        role="menuitem"
                        onClick={() => addCard(c.key)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span className="truncate">{c.label}</span>
                        {(c.cardType === 'shortcut' || c.cardType === 'action') && (
                          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary/80">
                            {t('shortcutBadge')}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
                {t('resetToDefault')}
              </Button>
              <Button variant="outline" size="sm" onClick={cancel} disabled={pending}>
                {t('cancel')}
              </Button>
              {/* Save is gated behind a confirmation dialog (feedback 31b46dcc). */}
              <AlertDialog.Root>
                <AlertDialog.Trigger asChild>
                  <Button size="sm" disabled={pending}>
                    {t('saveChanges')}
                  </Button>
                </AlertDialog.Trigger>
                <AlertDialog.Portal>
                  <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
                  <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
                    <AlertDialog.Title className="text-base font-semibold">
                      {t('saveConfirmTitle')}
                    </AlertDialog.Title>
                    <div className="mt-5 flex justify-end gap-2">
                      <AlertDialog.Cancel asChild>
                        <Button type="button" variant="outline" size="sm" onClick={cancel}>
                          {t('saveConfirmDiscard')}
                        </Button>
                      </AlertDialog.Cancel>
                      <AlertDialog.Action asChild>
                        <Button type="button" size="sm" onClick={save}>
                          {t('saveConfirmConfirm')}
                        </Button>
                      </AlertDialog.Action>
                    </div>
                  </AlertDialog.Content>
                </AlertDialog.Portal>
              </AlertDialog.Root>
            </div>
          </>
        ) : (
          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={enterCustomize}>
              {t('customizeDashboard')}
            </Button>
          </div>
        )}
      </div>

      {customizing ? (
        <div className="space-y-6">
          {/* Row 1 — the draggable widget grid (max MAX_FIRST_ROW=4 across on desktop; extra cards wrap). */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={sortableKeys} strategy={rectSortingStrategy}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {sortableKeys.map((key) => (
                  <SortableCard
                    key={key}
                    id={key}
                    label={labelFor(key)}
                    mandatory={byKey.get(key)?.mandatory ?? false}
                    shaking={shakeKey === key}
                    mandatoryMessage={t('mandatoryCardMessage')}
                    onRemove={removeCard}
                  >
                    {nodeFor(key)}
                  </SortableCard>
                ))}
                {sortableKeys.length === 0 && (
                  <p className="rounded-2xl border-2 border-dashed border-border p-8 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
                    {t('emptyDashboardHint')}
                  </p>
                )}
              </div>
            </SortableContext>
          </DndContext>
          {/* Row 2 — the fixed row of pinned shortcut/action cards + Planned Absences (not draggable). */}
          {fixedKeys.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('pinnedRowHint')}</p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {fixedKeys.map((key) => (
                  <FixedCard key={key} label={labelFor(key)}>
                    {nodeFor(key)}
                  </FixedCard>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Row 1 — the employee's arranged widget grid. */}
          {sortableKeys.length > 0 && (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {sortableKeys.map((key) => (
                <div key={key}>{nodeFor(key)}</div>
              ))}
            </div>
          )}
          {/* Row 2 — the fixed pinned row. */}
          {fixedKeys.length > 0 && (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {fixedKeys.map((key) => (
                <div key={key}>{nodeFor(key)}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
