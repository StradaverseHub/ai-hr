'use client';

import { useState } from 'react';
import { Badge, Button, inputCls } from '@/components/ui';
import { LEVEL_KINDS, isFixedLevelKind } from '@/lib/leave-approval-kinds';

/* 6fadb036 (R17 gap-close): the reporter's full 7-role approver vocabulary (list C), ordered as requested.
   r293 — READ FROM `LEVEL_KINDS` rather than re-listed here. The local copy this replaces had to be edited
   in step with the kernel const every time the vocabulary grew, and nothing failed when it was not: a kind
   the engine accepts but the picker never offers is invisible until somebody hand-writes a template row.
   `test/r293-approval-builder.test.ts` pins that the picker offers exactly LEVEL_KINDS. */
const KIND_OPTIONS = LEVEL_KINDS;

export type StepListLabels = {
  chain: string;
  empty: string;
  manager: string;
  departmentHead: string;
  businessUnitHead: string;
  hr: string;
  hrManager: string;
  payroll: string;
  customRole: string;
  add: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  dragToReorder: string;
  /* ── r293 builder ─────────────────────────────────────────────────────────────────────────────────
     `levelTemplate` carries its own ICU placeholder back in from the server side of the boundary — the
     app/admin/notice-board/new/page.tsx:102 idiom. This component holds a STRING, not a translator, so it
     substitutes `{n}` itself; a bare `t('level')` would find no `n`, throw FORMATTING_ERROR and render the
     key path behind a green 200. */
  levelTemplate: string;
  badgeDynamic: string;
  badgeFixed: string;
  flowStart: string;
  flowEnd: string;
  addLevel: string;
  fixedWarning: string;
  /** Per-kind "how this level finds its approver" line, keyed by LEVEL_KINDS value. */
  hints: Record<string, string>;
};

/** r293 — the Dynamic/Fixed badge. The classification has ONE owner in the kernel
 *  (core/leave-approval-policy.ts `isFixedLevelKind`); this is only how it is drawn. */
function LevelBadge({ kind, labels }: { kind: string; labels: StepListLabels }) {
  const fixed = isFixedLevelKind(kind);
  return (
    <Badge variant={fixed ? 'warning' : 'info'}>{fixed ? labels.badgeFixed : labels.badgeDynamic}</Badge>
  );
}

/** The thin down-arrow that makes the sequence readable as a sequence rather than as a list. */
function Connector() {
  return (
    <div aria-hidden className="flex justify-center py-1 text-base leading-none text-muted-foreground/60">
      ↓
    </div>
  );
}

/**
 * 6fadb036 (R17) — shared ordered approval-step editor. Extracted from the near-identical lists in
 * editor.tsx and rule-builder.tsx so all three surfaces (company default, scoped rule, template) share one
 * implementation, and so DRAG-AND-DROP reordering (native HTML5 drag events) is delivered everywhere at
 * once. The ↑/↓ buttons stay for keyboard/accessibility. Controlled: the parent owns `levels` and submits
 * it as a CSV hidden field.
 *
 * ═══ r293 — THE VISUAL BUILDER, OVER THE STRUCTURE THAT WAS ALREADY THERE ═══
 *
 * The reporter asked for "a dynamic, visual approval workflow builder", believing the system could only do
 * Direct Manager and HR at two fixed levels. It could already do seven kinds at any depth — `levels` is
 * jsonb and `LEVEL_KINDS` has carried seven since the 6fadb036 gap-close — and this editor already had
 * drag-to-reorder, add, remove and automatic renumbering. What was missing was the READING of it: a dense
 * one-line-per-step list said nothing about sequence, and nothing at all about the difference between a
 * level that can be skipped and one that cannot.
 *
 * So this is a re-presentation, not a rebuild. Each level is a CARD with its number, its Dynamic/Fixed
 * badge, its approver picker and a plain sentence saying how that level finds its approver and whether it
 * can be skipped; connector arrows and the Employee-submits / Approved end caps make the chain read
 * top-to-bottom. No new dependency: the drag is the same native HTML5 dragstart/dragover/drop this file
 * has always used (checked before reaching for a library — the repo has none and one was not added).
 *
 * WHY THE SKIP SENTENCE IS NOT DECORATION: r285 — `department_head` and `business_unit_head` were silently
 * skipped for every request on the customer's tenant because no department or BU had a head set, and no
 * screen said a level could be skipped at all. The sentence, and the preview beside this editor, are what
 * make that visible on day one instead of on the round that finds it.
 */
export function StepListEditor({
  levels,
  setLevels,
  labels,
  disabled,
  maxSteps,
}: {
  levels: string[];
  setLevels: (next: string[]) => void;
  labels: StepListLabels;
  disabled?: boolean;
  /** Cap on the chain length (feedback d4735493). Undefined = unlimited, today's behaviour. When the
   *  cap is reached the add control is hidden rather than disabled: a greyed-out "Add" invites the user
   *  to hunt for why it will not work, whereas its absence matches the single-step choice they made. */
  maxSteps?: number;
}) {
  const atCap = maxSteps !== undefined && levels.length >= maxSteps;
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const kindLabel = (k: string): string => {
    switch (k) {
      case 'department_head':
        return labels.departmentHead;
      case 'business_unit_head':
        return labels.businessUnitHead;
      case 'hr_admin':
        return labels.hr;
      case 'hr_manager':
        return labels.hrManager;
      case 'payroll':
        return labels.payroll;
      case 'custom_role':
        return labels.customRole;
      default:
        return labels.manager;
    }
  };
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
  const setKind = (i: number, kind: string) => setLevels(levels.map((k, idx) => (idx === i ? kind : k)));

  return (
    <div className={disabled ? 'pointer-events-none space-y-2 opacity-50' : 'space-y-2'}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{labels.chain}</div>
        {levels.length > 1 && <span className="text-[11px] text-muted-foreground">{labels.dragToReorder}</span>}
      </div>

      {levels.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <>
          <div className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {labels.flowStart}
          </div>
          <Connector />
          <ol className="space-y-0">
            {levels.map((k, i) => {
              const fixed = isFixedLevelKind(k);
              return (
                <li key={i}>
                  {i > 0 && <Connector />}
                  <div
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragIndex !== null) moveTo(dragIndex, i);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={`cursor-grab space-y-2 rounded-xl border bg-card p-3 active:cursor-grabbing ${
                      fixed ? 'border-amber-400 dark:border-amber-600' : 'border-border'
                    } ${dragIndex === i ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="shrink-0 select-none text-muted-foreground/70">
                        ⠿
                      </span>
                      {/* The level NUMBER is derived from the position, so reordering renumbers by itself —
                          there is no stored index that can disagree with the order that is saved. */}
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {labels.levelTemplate.replace('{n}', String(i + 1))}
                      </span>
                      <LevelBadge kind={k} labels={labels} />
                      <span className="flex-1" />
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
                    </div>

                    <select
                      value={k}
                      onChange={(e) => setKind(i, e.target.value)}
                      aria-label={labels.levelTemplate.replace('{n}', String(i + 1))}
                      className={inputCls}
                    >
                      {KIND_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {kindLabel(opt)}
                        </option>
                      ))}
                    </select>

                    {/* How this level finds its approver, and whether it can be skipped. The skip half is
                        the r285 lesson made visible. */}
                    {labels.hints[k] && <p className="text-xs text-muted-foreground">{labels.hints[k]}</p>}

                    {fixed && (
                      <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                        {labels.fixedWarning}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <Connector />
          <div className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {labels.flowEnd}
          </div>
        </>
      )}

      {!atCap && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-dashed"
          onClick={() => setLevels([...levels, 'hr_admin'])}
        >
          {levels.length === 0 ? labels.add : labels.addLevel}
        </Button>
      )}
    </div>
  );
}
