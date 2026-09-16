'use client';

import { useState } from 'react';
import { Badge, Button, inputCls } from '@/components/ui';
import {
  EmployeeSearchField,
  type EmployeeSearchFieldLabels,
  type EmployeeSearchOption,
} from '@/components/employee-search-field';
import { LEVEL_KINDS, isFixedLevelKind, type ApprovalLevel, type LeaveLevelKind } from '@/lib/leave-approval-kinds';

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
  /** r293 phase 2 — the second hop up the reporting line. */
  managerManager: string;
  /** r293 phase 3 — the one FIXED kind: a named person. */
  specificEmployee: string;
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
  /** Shown on a fixed level whose named approver is no longer an active employment (r293 phase 3). */
  fixedApproverEnded: string;
  /** Prompt on a fixed level before anybody has been chosen. */
  fixedApproverMissing: string;
  /** Per-kind "how this level finds its approver" line, keyed by LEVEL_KINDS value. */
  hints: Record<string, string>;
  /** Captions for the employee picker a FIXED level renders. */
  employeeSearch: EmployeeSearchFieldLabels;
  /* ── r293 phase 4: any-one approval ───────────────────────────────────────────────────────────── */
  /** The approval-mode legend. */
  modeTitle: string;
  modeSequential: string;
  modeSequentialHint: string;
  modeAnyOne: string;
  modeAnyOneHint: string;
  /** "Add another approver for this level". */
  addAlternate: string;
  /** Sits between a level's approvers: "or". */
  orLabel: string;
  /** Badge on a level that any one of several approvers can clear. */
  badgeAnyOne: string;
};

/**
 * Kind → the field of the label bag that names it.
 *
 * ⚠️ A FULL `Record<LeaveLevelKind, …>`, AND THE ONE OWNER OF THIS MAPPING. What stood here was a `switch`
 * with `default: return labels.manager`, and `app/admin/leave-approval/template-manager.tsx` carried a
 * SECOND copy of the same switch. When r293 phase 2 added `manager_manager` only one of them learned it,
 * so the template LIST printed "Direct manager" for a Manager's-Manager level — a wrong name, not a
 * missing one, which is the kind a reader believes. tsc, eslint and every guard were green; it was found
 * by rendering the page and reading the markup with <script> stripped (CLAUDE.md §8).
 *
 * Typed exhaustively, a kind added to the vocabulary without a label cannot compile, and `kindLabelOf`
 * below falls back to the RAW KIND rather than to any particular label — a miss must look like a bug.
 */
const KIND_LABEL_FIELD: Record<LeaveLevelKind, keyof StepListLabels> = {
  direct_manager: 'manager',
  manager_manager: 'managerManager',
  department_head: 'departmentHead',
  business_unit_head: 'businessUnitHead',
  hr_admin: 'hr',
  hr_manager: 'hrManager',
  payroll: 'payroll',
  custom_role: 'customRole',
  specific_employee: 'specificEmployee',
};

/** The display name for an approver kind, from the caller's own label bag. Exported so every surface that
 *  prints a chain uses this one mapping — see KIND_LABEL_FIELD for what a second copy cost. */
export function kindLabelOf(kind: string, labels: StepListLabels): string {
  const field = KIND_LABEL_FIELD[kind as LeaveLevelKind];
  const value = field ? labels[field] : undefined;
  return typeof value === 'string' ? value : kind;
}

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
  employees = [],
  endedEmploymentIds = [],
}: {
  levels: ApprovalLevel[];
  setLevels: (next: ApprovalLevel[]) => void;
  labels: StepListLabels;
  disabled?: boolean;
  /** r293 phase 3 — the population a FIXED level may name, already scope-fenced by the page. Empty on
   *  the surfaces that do not offer a fixed approver; the kind is then simply never pickable. */
  employees?: EmployeeSearchOption[];
  /** Of those, the ones that are no longer an ACTIVE employment. A level naming one of them is still
   *  KEPT by the engine — it cannot be dropped — which is exactly why the card has to say so. */
  endedEmploymentIds?: readonly string[];
  /** Cap on the chain length (feedback d4735493). Undefined = unlimited, today's behaviour. When the
   *  cap is reached the add control is hidden rather than disabled: a greyed-out "Add" invites the user
   *  to hunt for why it will not work, whereas its absence matches the single-step choice they made. */
  maxSteps?: number;
}) {
  const atCap = maxSteps !== undefined && levels.length >= maxSteps;
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const kindLabel = (k: string) => kindLabelOf(k, labels);
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
  /** Changing the kind CLEARS the named approver: an employment id left on a dynamic level would be
   *  unreachable (the engine never reads it) and a later reader might believe it. */
  const setKind = (i: number, kind: string) =>
    setLevels(
      levels.map((l, idx) =>
        idx === i
          ? {
              ...l,
              kind: kind as ApprovalLevel['kind'],
              employmentId: isFixedLevelKind(kind) ? l.employmentId : null,
            }
          : l,
      ),
    );
  const setApprover = (i: number, employmentId: string) =>
    setLevels(levels.map((l, idx) => (idx === i ? { ...l, employmentId: employmentId || null } : l)));

  /* ── r293 phase 4 — any-one approval ───────────────────────────────────────────────────────────────
     THE MODE IS DERIVED, NOT STORED. r79 0322 deleted the "Require multi-step approval" switch because
     the chain's own LENGTH already answered it and a flag that could disagree with the chain beside it
     was the whole defect. A stored `mode` would be the same mistake one level down: it could read
     "any one" over levels that hold a single approver. A level WITH alternates is an any-one level; the
     radio below is how the administrator turns that on, and it reads back out of the levels. */
  const anyOne = levels.some((l) => l.alternates.length > 0);
  const setAlternate = (i: number, j: number, patch: Partial<ApprovalLevel>) =>
    setLevels(
      levels.map((l, idx) =>
        idx === i ? { ...l, alternates: l.alternates.map((a, aj) => (aj === j ? { ...a, ...patch } : a)) } : l,
      ),
    );
  const addAlternate = (i: number) =>
    setLevels(
      levels.map((l, idx) =>
        idx === i ? { ...l, alternates: [...l.alternates, { kind: 'hr_admin' as const, employmentId: null }] } : l,
      ),
    );
  const removeAlternate = (i: number, j: number) =>
    setLevels(
      levels.map((l, idx) => (idx === i ? { ...l, alternates: l.alternates.filter((_, aj) => aj !== j) } : l)),
    );
  /** Switching back to sequential DISCARDS the alternates, because that is what sequential means — and it
   *  is the only honest reading: leaving them stored while the radio says "sequential" would be a level
   *  that routes to three people and a screen that says one. */
  const setMode = (next: boolean) =>
    next ? addAlternate(0) : setLevels(levels.map((l) => ({ ...l, alternates: [] })));

  /** A fixed kind is only offerable where the page supplied a population to pick from. */
  const kindOptions = KIND_OPTIONS.filter((k) => !isFixedLevelKind(k) || employees.length > 0);

  return (
    <div className={disabled ? 'pointer-events-none space-y-2 opacity-50' : 'space-y-2'}>
      {/* r293 phase 4 — APPROVAL MODE. Two radios, and neither is stored: `anyOne` is read back out of
          the levels (a level with alternates IS an any-one level), so the control and the chain beneath
          it cannot disagree. Hidden when the chain is empty: there is nothing to be any-one about yet. */}
      {levels.length > 0 && (
        <fieldset className="space-y-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {labels.modeTitle}
          </legend>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="approvalMode"
              className="mt-0.5"
              checked={!anyOne}
              onChange={() => setMode(false)}
            />
            <span>
              <span className="font-medium">{labels.modeSequential}</span>
              <span className="block text-xs text-muted-foreground">{labels.modeSequentialHint}</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="approvalMode"
              className="mt-0.5"
              checked={anyOne}
              onChange={() => setMode(true)}
            />
            <span>
              <span className="font-medium">{labels.modeAnyOne}</span>
              <span className="block text-xs text-muted-foreground">{labels.modeAnyOneHint}</span>
            </span>
          </label>
        </fieldset>
      )}

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
            {levels.map((level, i) => {
              const k = level.kind;
              const fixed = isFixedLevelKind(k);
              const ended = !!level.employmentId && endedEmploymentIds.includes(level.employmentId);
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
                      {level.alternates.length > 0 && <Badge variant="accent">{labels.badgeAnyOne}</Badge>}
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
                      {kindOptions.map((opt) => (
                        <option key={opt} value={opt}>
                          {kindLabel(opt)}
                        </option>
                      ))}
                    </select>

                    {/* r293 phase 3 — a FIXED level names a PERSON, so it needs a person picker. Ranked
                        and capped by the rule the rest of the product searches employees by
                        (lib/employee-search matchEmployees), through the shared control rather than a
                        fourth employee box. It posts nothing: this editor owns the whole chain and
                        submits it as one field. */}
                    {fixed && (
                      <EmployeeSearchField
                        employees={employees}
                        value={level.employmentId}
                        labels={labels.employeeSearch}
                        onValueChange={(v) => setApprover(i, v)}
                        className="w-full"
                      />
                    )}

                    {/* How this level finds its approver, and whether it can be skipped. The skip half is
                        the r285 lesson made visible. */}
                    {labels.hints[k] && <p className="text-xs text-muted-foreground">{labels.hints[k]}</p>}

                    {fixed && !level.employmentId && (
                      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {labels.fixedApproverMissing}
                      </p>
                    )}

                    {/* The promise the plan makes the reporter by name: WARN when a fixed approver is no
                        longer an active employment. It is a warning and not a skip — the engine cannot
                        drop a fixed level, and dropping one would silently remove an approval the
                        administrator put there deliberately. */}
                    {ended && (
                      <p className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                        {labels.fixedApproverEnded}
                      </p>
                    )}

                    {fixed && (
                      <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                        {labels.fixedWarning}
                      </p>
                    )}

                    {/* r293 phase 4 — the OTHER approvers for this level. Each renders the same picker the
                        primary does, because an alternate is an approver by the same rules — the reporter's
                        "Sarah OR Ahmad" is two approvers on one level, not two levels. */}
                    {level.alternates.map((alt, j) => {
                      const altFixed = isFixedLevelKind(alt.kind);
                      const altEnded = !!alt.employmentId && endedEmploymentIds.includes(alt.employmentId);
                      return (
                        <div key={j} className="space-y-2 rounded-lg border border-dashed border-border p-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {labels.orLabel}
                            </span>
                            <LevelBadge kind={alt.kind} labels={labels} />
                            <span className="flex-1" />
                            <button
                              type="button"
                              onClick={() => removeAlternate(i, j)}
                              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              {labels.remove}
                            </button>
                          </div>
                          <select
                            value={alt.kind}
                            onChange={(e) =>
                              setAlternate(i, j, {
                                kind: e.target.value as ApprovalLevel['kind'],
                                employmentId: isFixedLevelKind(e.target.value) ? alt.employmentId : null,
                              })
                            }
                            aria-label={labels.addAlternate}
                            className={inputCls}
                          >
                            {kindOptions.map((opt) => (
                              <option key={opt} value={opt}>
                                {kindLabel(opt)}
                              </option>
                            ))}
                          </select>
                          {altFixed && (
                            <EmployeeSearchField
                              employees={employees}
                              value={alt.employmentId}
                              labels={labels.employeeSearch}
                              onValueChange={(v) => setAlternate(i, j, { employmentId: v || null })}
                              className="w-full"
                            />
                          )}
                          {altFixed && !alt.employmentId && (
                            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                              {labels.fixedApproverMissing}
                            </p>
                          )}
                          {altEnded && (
                            <p className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                              {labels.fixedApproverEnded}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {anyOne && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => addAlternate(i)}>
                        {labels.addAlternate}
                      </Button>
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
          onClick={() => setLevels([...levels, { kind: 'hr_admin', employmentId: null, alternates: [] }])}
        >
          {levels.length === 0 ? labels.add : labels.addLevel}
        </Button>
      )}
    </div>
  );
}
