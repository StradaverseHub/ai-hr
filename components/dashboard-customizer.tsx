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
 * Customize mode (feedback dashgrid → 2806443b, Shortcuts row 3d2bc793): a @dnd-kit 2-D grid in FOUR areas
 *   — a draggable top row of up to 4 cards, the Shortcuts row, a fixed full-width row (FIXED_ROW_KEYS,
 *   EMPTY since a00c4f64 moved the Leave Calendar to its own screen, so that row renders nothing today),
 *   and a flexible area below it for every remaining selected card (also draggable — the top row and that
 *   area share one flat order; the 4-card slice decides which grid a card lands in).
 *   The live render IS the preview, plus
 *   • Add Card — a menu of employee-selectable cards not currently shown.
 *   • Remove (×) on each optional card; mandatory cards refuse removal with a shake + the message
 *     "This dashboard card is mandatory and cannot be removed."
 *   • Save Changes — gated behind the confirmation dialog (feedback 31b46dcc); Cancel reverts; Reset to
 *     Default clears the saved layout back to the HR default.
 *
 * Action / Shortcut cards (cardType 'action' | 'shortcut') that have no bespoke server node render as a
 * clickable ShortcutCard linking straight to their configured destination (leave / claims / payslip / ...).
 * Shortcut-typed cards additionally gather into their own SHORTCUTS row between the top row and the fixed
 * row (feedback 3d2bc793): up to MAX_SHORTCUTS of them, ordered by the employee, reorderable within that
 * row only. 'action' cards stay ordinary top-row cards — Pending Tasks renders a bespoke node.
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
import { toast } from 'sonner';
import { ArrowUpRight, GripVertical, Pin, Plus, X } from 'lucide-react';
import { useUiTheme } from '@/components/ui-theme-context';
import { Button, Card } from '@/components/ui';
import { SectionOrdinalProvider } from '@/components/monolith/section-ordinal';
import {
  MAX_SHORTCUTS,
  isFixedRowKey,
  partitionDashboardRows,
  type DashboardLayout,
} from '@/lib/dashboard-layout';

/**
 * Column classes derived from the ACTUAL number of cards in a row (feedback 84d1233d step 1), so two
 * cards share the full width instead of leaving half the row empty, removing a card closes the gap, and
 * a lone pinned card no longer squashes to a quarter. STATIC map — Tailwind cannot JIT a
 * runtime-interpolated class name. Capped at 4 across; the 3/4-column step is xl (1280px), not lg, so a
 * 1024px landscape tablet stays at 2-up instead of jumping straight to 4 across.
 */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
};
export function gridColsFor(count: number): string {
  return GRID_COLS[Math.min(Math.max(count, 1), 4)] ?? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4';
}

/**
 * r401 — Monolith (docs/design/monolith/reference/P-Dashboard.dc.html). Every class below is `monolith:`-scoped
 * and APPENDED, so Classic's markup paints exactly as before. The top row reads as the board's `.cells`: no gaps,
 * a hairline between neighbours, the first column flush left. Each cell carries a left hairline and 18px; the
 * grid is pulled 19px left and clipped there, so whichever cells start a line (4, 2 or 1 across) lose their
 * rule and padding to the clip — no per-breakpoint bookkeeping. The clip keeps 8px outside the other edges so
 * a focus outline is never cut.
 */
const MONO_ROW1 =
  'monolith:gap-x-0 monolith:gap-y-6 monolith:-ml-[19px] monolith:[clip-path:inset(-8px_-8px_-8px_11px)]';
const MONO_ROW1_CELL = 'monolith:border-l monolith:border-hairline monolith:pl-[18px]';
const MONO_ROWS = 'monolith:gap-8';
const MONO_DASHED = 'monolith:rounded-none monolith:border monolith:border-faint';

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
    <Link href={href} className="block h-full">
      <Card className="flex h-full items-center justify-between gap-3 p-5 transition-colors hover:border-foreground/20 monolith:px-0 monolith:pt-3 monolith:pb-3 monolith:hover:border-signal">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-primary/80 monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:tracking-[0.12em] monolith:text-mid">{badge}</div>
          <div className="mt-1 truncate text-lg font-semibold tracking-tight monolith:font-medium monolith:tracking-[-0.02em] monolith:text-ink">{label}</div>
        </div>
        <ArrowUpRight className="size-5 shrink-0 text-muted-foreground monolith:text-mid" />
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
      className={`relative h-full rounded-2xl border-2 border-dashed border-primary/30 p-2 ${
        isDragging ? 'opacity-80 shadow-lg' : ''
      } ${shaking ? 'animate-shake border-destructive/60' : ''} ${MONO_DASHED}${shaking ? ' monolith:border-signal' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        {/* The handle carries dnd-kit's KeyboardSensor activator as well as the pointer one, so this button
            IS the keyboard route: focus it, press Space, arrow to the new slot, Space again. Naming it
            "Reorder {card}" instead of just the card name is what makes that route findable by screen
            reader (feedback 3d2bc793). */}
        <button
          type="button"
          aria-label={t('reorderCardAria', { card: label })}
          className="grid size-7 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing focus:outline-none focus:ring-2 focus:ring-primary/40 monolith:rounded-none monolith:hover:bg-pressed monolith:focus:ring-0 monolith:focus-visible:outline-2"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <span className="text-xs font-medium text-muted-foreground monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em] monolith:text-mid">{label}</span>
        <button
          type="button"
          onClick={() => onRemove(id)}
          aria-label={t('removeCardAria', { card: label })}
          className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus:outline-none focus:ring-2 focus:ring-destructive/40 monolith:rounded-none monolith:hover:bg-pressed monolith:hover:text-signal-text monolith:focus:ring-0 monolith:focus-visible:outline-2"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* The card preview is inert while customizing so drags don't trigger inner links/controls. */}
      <div className="pointer-events-none select-none">{children}</div>
      {shaking && (
        <p role="alert" className="mt-2 px-1 text-xs font-medium text-destructive monolith:text-signal-text">
          {mandatoryMessage}
        </p>
      )}
      {mandatory && !shaking && (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground monolith:text-mid">{t('mandatoryCardHint')}</p>
      )}
    </div>
  );
}

/** A card pinned to the fixed second row (customize mode): shown inert, no grip / no remove. */
function FixedCard({ label, children }: { label: string; children: ReactNode }) {
  const t = useTranslations('dashboard');
  return (
    <div className={`relative h-full rounded-2xl border-2 border-dashed border-muted-foreground/25 bg-muted/20 p-2 ${MONO_DASHED} monolith:bg-transparent`}>
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
  sectionKeys,
}: {
  /** Every ACTIVE HR-configured card, in display order (the add menu + labels come from here). */
  cards: CustomizerCard[];
  /** Pre-rendered server node per cardKey for information cards that have one. */
  blocks: Record<string, ReactNode>;
  /** The caller's saved, already-normalised layout ({ selected, order }). */
  layout: DashboardLayout;
  saveAction: (layout: { selected: string[]; order: string[] }) => Promise<void>;
  resetAction: () => Promise<void>;
  /**
   * r401 — Monolith only: the cardKeys whose node is a numbered SECTION (`01 · Attendance`). Each such block
   * is told its place among the sections IN THE USER'S CURRENT ORDER (live while customizing), through
   * components/monolith/section-ordinal.tsx. Absent (Classic) → no provider is mounted and nothing changes.
   */
  sectionKeys?: string[];
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
  // The card whose × was clicked and is awaiting the remove-confirm dialog (feedback removeconfirm). null =
  // no pending removal. This guards ONLY the individual remove; it is unrelated to the Save-confirm dialog.
  const [pendingRemoveKey, setPendingRemoveKey] = useState<string | null>(null);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Row assignment (feedback dashgrid → 2806443b, Shortcuts row 3d2bc793) is DERIVED, never persisted:
  // a card named by lib/dashboard-layout FIXED_ROW_KEYS is pinned to the full-width second row (that list
  // is empty since a00c4f64, so nothing pins today), and cards HR typed 'shortcut' gather into the
  // Shortcuts row. Everything else — including the 'action'
  // Pending Tasks card, which has a bespoke node and belongs in the top row — is an ordinary
  // draggable/removable card; a card HR marked mandatory still refuses removal with the shake.
  const isPinned = (key: string): boolean => isFixedRowKey(key);
  const isShortcut = (key: string): boolean => byKey.get(key)?.cardType === 'shortcut';
  const pinnedKeys = useMemo(() => new Set(visible.filter(isPinned)), [visible]);
  const shortcutKeys = useMemo(
    () => new Set(visible.filter((k) => byKey.get(k)?.cardType === 'shortcut')),
    [visible, byKey],
  );
  const {
    row1: row1Keys,
    shortcuts: shortcutRowKeys,
    row2: fixedKeys,
    row3: row3Keys,
  } = partitionDashboardRows({ selected: visible, order: visible }, pinnedKeys, shortcutKeys);
  // The flat draggable order shared by the top row and the third area — row membership re-derives from the
  // MAX_FIRST_ROW slice, so a drag between the two grids is just a move within this flat sequence.
  const sortableKeys = [...row1Keys, ...row3Keys];
  // r401 — the on-screen order of the numbered sections: top row, shortcuts, the fixed row, then the rest.
  const sectionOrdinal = useMemo(() => {
    if (!sectionKeys) return null;
    const isSection = new Set(sectionKeys);
    const out = new Map<string, number>();
    for (const k of [...row1Keys, ...shortcutRowKeys, ...fixedKeys, ...row3Keys]) if (isSection.has(k)) out.set(k, out.size + 1);
    return out;
  }, [sectionKeys, row1Keys, shortcutRowKeys, fixedKeys, row3Keys]);

  // At the cap, the Add menu still LISTS the remaining shortcuts but refuses them, with the reason spelled
  // out — a silently vanishing menu entry reads as a bug.
  const shortcutLimitReached = shortcutRowKeys.length >= MAX_SHORTCUTS;
  const addable = cards.filter((c) => c.employeeSelectable && !visible.includes(c.key));

  /**
   * Move `activeId` to `overId`'s slot WITHIN its own group (the Shortcuts row, or the top row + third
   * area), leaving every other card's position in `cur` untouched. Written as a slot rewrite rather than
   * filter-move-concat so a reorder inside one group can never renumber the other — the two groups render
   * as separate grids, and a drag that lands on the wrong group's card is a no-op spring-back.
   */
  const moveWithinGroup = (cur: string[], inGroup: (k: string) => boolean, activeId: string, overId: string) => {
    const slots: number[] = [];
    cur.forEach((k, i) => {
      if (inGroup(k)) slots.push(i);
    });
    const group = slots.map((i) => cur[i]);
    const from = group.indexOf(activeId);
    const to = group.indexOf(overId);
    if (from < 0 || to < 0) return cur;
    const moved = arrayMove(group, from, to);
    const next = [...cur];
    slots.forEach((slot, j) => {
      next[slot] = moved[j];
    });
    return next;
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    // 2-D grid reorder: dnd-kit's rectSortingStrategy maps the grid geometry onto the group's flat order,
    // so a straight arrayMove over it is the correct L/R + up/down move — including a drag between the top
    // row and the third area, which simply crosses the MAX_FIRST_ROW slice boundary.
    const shortcutDrag = isShortcut(activeId);
    if (shortcutDrag !== isShortcut(overId)) return; // across the two grids → spring back (no-op)
    setVisible((cur) =>
      moveWithinGroup(cur, shortcutDrag ? isShortcut : (k) => !isPinned(k) && !isShortcut(k), activeId, overId),
    );
  };

  const triggerShake = (id: string) => {
    setShakeKey(id);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => setShakeKey(null), 600);
  };

  // × click: mandatory cards shake + refuse (no dialog); optional cards open the remove-confirm dialog
  // instead of removing immediately, so an accidental click during rearranging can't drop a card.
  const requestRemove = (id: string) => {
    const card = byKey.get(id);
    if (card?.mandatory) {
      // Mandatory cards can't be removed → shake + message, card stays.
      triggerShake(id);
      return;
    }
    setPendingRemoveKey(id);
  };

  // Confirm in the dialog → actually drop the card from the working set (still not persisted until Save).
  const confirmRemove = () => {
    const id = pendingRemoveKey;
    if (!id) return;
    setVisible((cur) => cur.filter((k) => k !== id));
    setPendingRemoveKey(null);
    toast.success(t('removeConfirmToast', { card: labelFor(id) }));
  };

  // Cancel/close → leave `visible` untouched (a plain no-op close; NOT the Save-confirm cancel that reverts
  // the whole customize session).
  const cancelRemove = () => setPendingRemoveKey(null);

  const addCard = (id: string) => {
    if (isShortcut(id) && shortcutLimitReached) {
      toast.error(t('shortcutsLimitToast', { max: MAX_SHORTCUTS }));
      return;
    }
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

  /**
   * Shortcut destinations that should OPEN something on arrival rather than just land on the page.
   *
   * The Apply Leave shortcut is configured with href `/leave` (feedback a46fe0c0), so clicking it put the
   * employee on My Leave and left them to find "+ Leave Request" themselves — two clicks to do the thing
   * the shortcut is named after. Appending the marker makes the destination page open the existing dialog
   * on arrival.
   *
   * Keyed on the card KEY rather than by rewriting the stored href, deliberately: the href lives in
   * per-tenant `dashboard_card_config` rows, so editing it would mean a data migration for every tenant
   * and would silently diverge for any tenant that had customised it. Keying on the card's identity
   * applies the behaviour everywhere and stays correct if an administrator repoints the card.
   */
  const OPENS_ON_ARRIVAL: Record<string, string> = { applyLeave: 'apply=1' };

  /** Resolve the render node for a card: bespoke server block, else a generic shortcut link, else null. */
  const nodeFor = (key: string): ReactNode => {
    if (blocks[key] !== undefined) {
      const ordinal = sectionOrdinal?.get(key);
      return ordinal === undefined ? blocks[key] : <SectionOrdinalProvider value={ordinal}>{blocks[key]}</SectionOrdinalProvider>;
    }
    const card = byKey.get(key);
    if (card && card.href) {
      const marker = OPENS_ON_ARRIVAL[key];
      const href = marker ? `${card.href}${card.href.includes('?') ? '&' : '?'}${marker}` : card.href;
      return <ShortcutCard label={card.label} href={href} badge={t('shortcutBadge')} />;
    }
    return null;
  };

  const current = useUiTheme() === 'current';
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
                    className="absolute right-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg monolith:rounded-none monolith:border-ink"
                  >
                    {addable.map((c) => {
                      const blocked = c.cardType === 'shortcut' && shortcutLimitReached;
                      return (
                        <button
                          key={c.key}
                          type="button"
                          role="menuitem"
                          onClick={() => addCard(c.key)}
                          disabled={blocked}
                          title={blocked ? t('shortcutsLimitToast', { max: MAX_SHORTCUTS }) : undefined}
                          className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent monolith:rounded-none monolith:hover:bg-pressed"
                        >
                          <span className="truncate">{c.label}</span>
                          {(c.cardType === 'shortcut' || c.cardType === 'action') && (
                            <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-primary/80 monolith:font-mono monolith:tracking-[0.12em] monolith:text-mid">
                              {t('shortcutBadge')}
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {shortcutLimitReached && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        {t('shortcutsLimitHint', { max: MAX_SHORTCUTS })}
                      </p>
                    )}
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
          {/* One DndContext holding TWO sortable groups: the flat non-pinned, non-shortcut order (row 1 =
              first 4, row 3 = the rest) and the Shortcuts row. A drag between row 1 and row 3 is a plain
              move within the first group — the MAX_FIRST_ROW slice re-derives the grids — while shortcuts
              reorder only among themselves, so arranging them can never disturb the rest of the layout. */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={sortableKeys} strategy={rectSortingStrategy}>
              {/* Row 1 — the draggable top-row grid (up to 4 across on desktop). */}
              <div className={`grid gap-4 ${gridColsFor(row1Keys.length)}`}>
                {row1Keys.map((key) => (
                  <SortableCard
                    key={key}
                    id={key}
                    label={labelFor(key)}
                    mandatory={byKey.get(key)?.mandatory ?? false}
                    shaking={shakeKey === key}
                    mandatoryMessage={t('mandatoryCardMessage')}
                    onRemove={requestRemove}
                  >
                    {nodeFor(key)}
                  </SortableCard>
                ))}
                {row1Keys.length === 0 && shortcutRowKeys.length === 0 && (
                  <p className={`col-span-full rounded-2xl border-2 border-dashed border-border p-8 text-center text-sm text-muted-foreground ${MONO_DASHED} monolith:border-dashed monolith:text-mid`}>
                    {t('emptyDashboardHint')}
                  </p>
                )}
              </div>
              {/* Shortcuts — always shown while customizing (even empty) so the section is a findable place
                  to put shortcuts, which is the whole point of the request (feedback 3d2bc793). */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p className="text-xs font-semibold text-foreground">{t('shortcutsRowTitle')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('shortcutsRowHint', { max: MAX_SHORTCUTS })}
                  </p>
                </div>
                {shortcutRowKeys.length > 0 ? (
                  <SortableContext items={shortcutRowKeys} strategy={rectSortingStrategy}>
                    <div className={`grid gap-4 ${gridColsFor(shortcutRowKeys.length)}`}>
                      {shortcutRowKeys.map((key) => (
                        <SortableCard
                          key={key}
                          id={key}
                          label={labelFor(key)}
                          mandatory={byKey.get(key)?.mandatory ?? false}
                          shaking={shakeKey === key}
                          mandatoryMessage={t('mandatoryCardMessage')}
                          onRemove={requestRemove}
                        >
                          {nodeFor(key)}
                        </SortableCard>
                      ))}
                    </div>
                  </SortableContext>
                ) : (
                  <p className={`rounded-2xl border-2 border-dashed border-border p-6 text-center text-sm text-muted-foreground ${MONO_DASHED} monolith:border-dashed monolith:text-mid`}>
                    {t('shortcutsEmptyHint', { max: MAX_SHORTCUTS })}
                  </p>
                )}
              </div>
              {/* Row 2 — the fixed full-width row (not draggable, not removable). Empty today. */}
              {fixedKeys.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{t('pinnedRowHint')}</p>
                  <div className={`grid gap-4 ${gridColsFor(fixedKeys.length)}`}>
                    {fixedKeys.map((key) => (
                      <FixedCard key={key} label={labelFor(key)}>
                        {nodeFor(key)}
                      </FixedCard>
                    ))}
                  </div>
                </div>
              )}
              {/* Row 3 — the flexible area below it (5th+ non-pinned cards, still draggable). */}
              {row3Keys.length > 0 && (
                <div className={`grid gap-4 ${gridColsFor(row3Keys.length)}`}>
                  {row3Keys.map((key) => (
                    <SortableCard
                      key={key}
                      id={key}
                      label={labelFor(key)}
                      mandatory={byKey.get(key)?.mandatory ?? false}
                      shaking={shakeKey === key}
                      mandatoryMessage={t('mandatoryCardMessage')}
                      onRemove={requestRemove}
                    >
                      {nodeFor(key)}
                    </SortableCard>
                  ))}
                </div>
              )}
            </SortableContext>
          </DndContext>
        </div>
      ) : current ? (
        <div className="current-work-ribbons">
          {visible.map((key, i) => <details key={key} className="current-work-ribbon" open={i === 0}>
            <summary><span>{labelFor(key)}</span><span aria-hidden className="current-ribbon-toggle">+</span></summary>
            <div className="current-work-focus">{nodeFor(key)}</div>
          </details>)}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Row 1 — the employee's arranged top-row grid (up to 4 cards). */}
          {row1Keys.length > 0 && (
            <div className={`grid gap-6 ${gridColsFor(row1Keys.length)} ${MONO_ROW1}`}>
              {row1Keys.map((key) => (
                <div key={key} className={`h-full ${MONO_ROW1_CELL}`}>{nodeFor(key)}</div>
              ))}
            </div>
          )}
          {/* Shortcuts — the employee's mini-card row, in their saved order. Hidden when empty so a
              dashboard with no shortcuts renders exactly as it did before (feedback 3d2bc793). */}
          {shortcutRowKeys.length > 0 && (
            <div className={`grid gap-6 ${gridColsFor(shortcutRowKeys.length)} ${MONO_ROWS}`}>
              {shortcutRowKeys.map((key) => (
                <div key={key} className="h-full">{nodeFor(key)}</div>
              ))}
            </div>
          )}
          {/* Row 2 — the fixed full-width row. Empty today. */}
          {fixedKeys.length > 0 && (
            <div className={`grid gap-6 ${gridColsFor(fixedKeys.length)} ${MONO_ROWS}`}>
              {fixedKeys.map((key) => (
                <div key={key} className="h-full">{nodeFor(key)}</div>
              ))}
            </div>
          )}
          {/* Row 3 — everything else, below it. */}
          {row3Keys.length > 0 && (
            <div className={`grid gap-6 ${gridColsFor(row3Keys.length)} ${MONO_ROWS}`}>
              {row3Keys.map((key) => (
                <div key={key} className="h-full">{nodeFor(key)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Remove-confirm (feedback removeconfirm): guards the individual card × so an accidental click while
          rearranging can't drop a card. Controlled by pendingRemoveKey; Cancel is a no-op close. */}
      <AlertDialog.Root
        open={pendingRemoveKey !== null}
        onOpenChange={(open) => {
          if (!open) cancelRemove();
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <AlertDialog.Title className="text-base font-semibold">
              {t('removeConfirmTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
              {t('removeConfirmBody', { card: pendingRemoveKey ? labelFor(pendingRemoveKey) : '' })}
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline" size="sm" onClick={cancelRemove}>
                  {t('removeConfirmCancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" variant="destructive" size="sm" onClick={confirmRemove}>
                  {t('removeConfirmConfirm')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
