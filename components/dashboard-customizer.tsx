'use client';

/**
 * Employee dashboard customize island (feedback 7d9d145d).
 *
 * v1 = VERTICAL reordering of the EXISTING employee dashboard sections. The server pre-renders each
 * reorderable section into `blocks[id]` (plain server JSX) and passes them in; this client island only
 * decides the ORDER they stack in — it reads no data of its own, so the server/RSC boundary is clean
 * (the page RENDERS this component; it never calls a function out of a 'use client' module).
 *
 * Normal mode: render the blocks in the caller's saved order and show a "Customize Dashboard" button.
 * Customize mode: a @dnd-kit sortable list (drag by keyboard or pointer) whose live render IS the
 * preview, plus Save Changes (persist), Cancel (revert to last-saved) and Reset to Default (clear).
 */

import { type ReactNode, useState, useTransition } from 'react';
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useTranslations } from 'next-intl';
import { GripVertical } from 'lucide-react';
import { Button } from '@/components/ui';
import { DEFAULT_ORDER, type DashboardBlockId } from '@/lib/dashboard-layout';

/** Draggable wrapper around one dashboard block (only mounted in customize mode). */
function SortableBlock({
  id,
  label,
  children,
}: {
  id: DashboardBlockId;
  label: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 20 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative rounded-2xl border-2 border-dashed border-primary/30 p-2 ${
        isDragging ? 'opacity-80 shadow-lg' : ''
      }`}
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
      </div>
      {/* The block preview is inert while reordering so drags don't trigger inner links/controls. */}
      <div className="pointer-events-none select-none">{children}</div>
    </div>
  );
}

export function DashboardCustomizer({
  blocks,
  savedOrder,
  saveAction,
  resetAction,
}: {
  blocks: Record<DashboardBlockId, ReactNode>;
  /** The caller's saved, already-normalised order, or null when they use the system default. */
  savedOrder: DashboardBlockId[] | null;
  saveAction: (order: string[]) => Promise<void>;
  resetAction: () => Promise<void>;
}) {
  const t = useTranslations('dashboard');
  const baselineFromProps = savedOrder ?? [...DEFAULT_ORDER];
  // `baseline` = last saved order (Cancel reverts here); `order` = the working/preview order.
  const [baseline, setBaseline] = useState<DashboardBlockId[]>(baselineFromProps);
  const [order, setOrder] = useState<DashboardBlockId[]>(baselineFromProps);
  const [customizing, setCustomizing] = useState(false);
  const [pending, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((cur) => {
      const from = cur.indexOf(active.id as DashboardBlockId);
      const to = cur.indexOf(over.id as DashboardBlockId);
      if (from < 0 || to < 0) return cur;
      return arrayMove(cur, from, to);
    });
  };

  const enterCustomize = () => {
    setOrder(baseline);
    setCustomizing(true);
  };
  const cancel = () => {
    setOrder(baseline);
    setCustomizing(false);
  };
  const save = () => {
    startTransition(async () => {
      await saveAction(order);
      setBaseline(order);
      setCustomizing(false);
    });
  };
  const reset = () => {
    startTransition(async () => {
      await resetAction();
      setOrder([...DEFAULT_ORDER]);
      setBaseline([...DEFAULT_ORDER]);
      setCustomizing(false);
    });
  };

  const blockLabel = (id: DashboardBlockId) => t(`block_${id}`);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {customizing ? (
          <>
            <p className="text-sm text-muted-foreground">{t('customizeHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={pending}>
                {t('resetToDefault')}
              </Button>
              <Button variant="outline" size="sm" onClick={cancel} disabled={pending}>
                {t('cancel')}
              </Button>
              {/* Save is gated behind a confirmation dialog (feedback 31b46dcc): the actual save()
                  only runs from AlertDialog.Action; AlertDialog.Cancel discards via the existing
                  cancel() (revert to baseline + exit customize). This confirm is reused by the rest
                  of the dashboard-customization chain (add/remove blocks). */}
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="space-y-4">
              {order.map((id) => (
                <SortableBlock key={id} id={id} label={blockLabel(id)}>
                  {blocks[id]}
                </SortableBlock>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="space-y-6">
          {order.map((id) => (
            <div key={id}>{blocks[id]}</div>
          ))}
        </div>
      )}
    </div>
  );
}
