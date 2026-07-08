'use client';

import { useState } from 'react';
import { Button, inputCls } from '@/components/ui';

const KIND_OPTIONS = ['direct_manager', 'hr_admin'] as const;

export type StepListLabels = {
  chain: string;
  empty: string;
  manager: string;
  hr: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  dragToReorder: string;
};

/**
 * 6fadb036 (R17) — shared ordered approval-step editor. Extracted from the near-identical lists in
 * editor.tsx and rule-builder.tsx so all three surfaces (company default, scoped rule, template) share one
 * implementation, and so DRAG-AND-DROP reordering (native HTML5 drag events) is delivered everywhere at
 * once. The ↑/↓ buttons stay for keyboard/accessibility. Controlled: the parent owns `levels` and submits
 * it as a CSV hidden field. Approver vocabulary is still the two supported kinds (direct_manager, hr_admin);
 * the extra roles the reporter listed remain gated (ADR-0071 §i).
 */
export function StepListEditor({
  levels,
  setLevels,
  labels,
  disabled,
}: {
  levels: string[];
  setLevels: (next: string[]) => void;
  labels: StepListLabels;
  disabled?: boolean;
}) {
  const [addKind, setAddKind] = useState<string>('hr_admin');
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const kindLabel = (k: string) => (k === 'hr_admin' ? labels.hr : labels.manager);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= levels.length) return;
    const next = [...levels];
    [next[i], next[j]] = [next[j], next[i]];
    setLevels(next);
  };
  const moveTo = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= levels.length || to >= levels.length) return;
    const next = [...levels];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setLevels(next);
  };

  return (
    <div className={disabled ? 'pointer-events-none space-y-3 opacity-50' : 'space-y-3'}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.chain}</div>
        {levels.length > 1 && <span className="text-[11px] text-muted-foreground">{labels.dragToReorder}</span>}
      </div>
      {levels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <ol className="space-y-2">
          {levels.map((k, i) => (
            <li
              key={i}
              draggable
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) moveTo(dragIndex, i);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className={`flex cursor-grab items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm active:cursor-grabbing ${
                dragIndex === i ? 'opacity-50' : ''
              }`}
            >
              <span aria-hidden className="shrink-0 text-muted-foreground/70 select-none">⠿</span>
              <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{i + 1}</span>
              <span className="flex-1 font-medium">{kindLabel(k)}</span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={labels.moveUp}
                className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === levels.length - 1}
                aria-label={labels.moveDown}
                className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => setLevels(levels.filter((_, idx) => idx !== i))}
                className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {labels.remove}
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <select value={addKind} onChange={(e) => setAddKind(e.target.value)} className={inputCls}>
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" onClick={() => setLevels([...levels, addKind])}>
          {labels.add}
        </Button>
      </div>
    </div>
  );
}
