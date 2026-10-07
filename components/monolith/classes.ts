/**
 * r400 — the Monolith class fragments the primitives share (docs/design/monolith/shell.css). Every class is
 * `monolith:`-scoped, so a fragment does nothing in Classic. Spelled out as utilities rather than leaning on
 * the `.mono` class: `.mono` sits in @layer components, so any Classic size or tracking utility on the same
 * element (text-xs, tracking-wide) would beat it in Monolith.
 */
/** DM Mono 11px uppercase, tracking 0.12em — labels, status words, column heads (`.mono`). */
export const MONO_LABEL =
  'monolith:font-mono monolith:text-[11px] monolith:font-normal monolith:uppercase monolith:tracking-[0.12em]';
/** A figure: DM Mono, tabular (`.num`). Classic gets tabular-nums from the plain utility. */
export const MONO_NUM = 'num tabular-nums monolith:font-mono';
