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

/**
 * r402 — Monolith's underlined field, for a native <select> (components/ui/input.tsx draws the same look on
 * <Input>, whose constant is private so its public API stays exactly r400's). Kept identical to that string;
 * test/r402-statutory-forms-versions.test.ts pins the two together.
 */
export const MONO_UNDERLINE_FIELD =
  'monolith:h-10 monolith:rounded-none monolith:border-0 monolith:border-b monolith:border-input monolith:bg-transparent monolith:px-0 monolith:py-2 monolith:text-[15px] monolith:font-medium monolith:shadow-none monolith:placeholder:text-faint monolith:focus-visible:border-signal monolith:focus-visible:ring-0 monolith:focus-visible:shadow-[0_1px_0_0_var(--signal)]';
