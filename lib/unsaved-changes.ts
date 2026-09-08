/**
 * 420ebab5 part two — the one place a screen can ask "does anything on this page have unsaved edits?"
 *
 * The consolidated per-tab Save (components/tab-save-scope.tsx) and the tab strip
 * (components/personnel-tabs.tsx) are two independent client islands: the strip renders the buttons that
 * change tab, the scope owns the dirty state and the Save/Discard/Cancel dialog, and neither is an
 * ancestor of the other, so React context cannot join them. A module-level registry can: both files
 * import THIS module, so both hold the same `guards` Set inside the one client bundle.
 *
 * Deliberately tiny and deliberately fail-open. When no scope is mounted — every tab that has not been
 * consolidated yet, and the whole employee ESS view — `firstDirtyGuard()` returns null and the tab strip
 * behaves exactly as it did before this item: switch immediately, prompt nothing. A half-applied pattern
 * therefore degrades to the old behaviour rather than to a broken one.
 *
 * `prompt` is what the guard OWNS: only the scope knows how to save its own sections, what "discard"
 * restores, and which words to show. The caller hands it a continuation and gets it back if — and only
 * if — the user chose Save (after the save succeeded) or Discard. Cancel drops the continuation on the
 * floor, which is precisely "stay put and keep the edits".
 */

/**
 * An anchor the unsaved-changes guard must NOT intercept — put it on the `<a>` itself or on a container.
 *
 * The guard watches document clicks while a tab is dirty because an in-app `<Link>` is a CLIENT-SIDE
 * navigation that `beforeunload` never sees. A handful of anchors on these screens are deliberately NOT
 * links to a page: the Employment History "Export to Excel" anchor is a bare `<a>` pointing at a route
 * handler that returns a workbook, and clicking it downloads a file without leaving the screen at all.
 * Intercepting one of those replaces a download with an "Unsaved changes" dialog and then a `router.push`
 * at a route that has no RSC payload to render — a prompt for an action that loses nothing, followed by a
 * navigation nobody asked for. Anything the guard skips here is still covered by `beforeunload`, which
 * DOES fire for the hard navigation a bare `<a>` performs.
 */
export const UNSAVED_GUARD_ATTR = 'data-unsaved-guard';
export const UNSAVED_GUARD_IGNORE_SELECTOR = `[${UNSAVED_GUARD_ATTR}="ignore"]`;

export type UnsavedGuard = {
  /** True while the scope holds edits that have not been written. */
  isDirty: () => boolean;
  /**
   * Ask the user what to do about those edits. `proceed` runs on Save (after a successful save) or on
   * Discard, and never on Cancel.
   */
  prompt: (proceed: () => void) => void;
};

const guards = new Set<UnsavedGuard>();

/** Register a scope. Returns the de-registration function an effect cleanup calls. */
export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/** The first registered guard that currently holds unsaved edits, or null when everything is clean. */
export function firstDirtyGuard(): UnsavedGuard | null {
  for (const guard of guards) {
    try {
      if (guard.isDirty()) return guard;
    } catch {
      // A guard that throws must never wedge navigation — treat it as clean.
    }
  }
  return null;
}

/** True when any registered scope holds unsaved edits. */
export function hasUnsavedChanges(): boolean {
  return firstDirtyGuard() !== null;
}

/** Test seam only — the registry is module state and jsdom keeps one module per file. */
export function __resetUnsavedGuards(): void {
  guards.clear();
}
