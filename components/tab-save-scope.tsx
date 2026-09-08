'use client';

/**
 * 420ebab5 part two — ONE "Save Changes" for a tab, the change summary that goes with it, and the
 * Save / Discard / Cancel prompt that stops an edit being walked away from.
 *
 * WHAT IT WRAPS, AND WHAT IT DELIBERATELY DOES NOT. The scope's children are the server-rendered cards
 * whose forms carry `data-save-section="<id>"` — bucket (a) of
 * docs/audits/420ebab5-personnel-save-classification.md, the plain field edits that overwrite a value on
 * the person or employment record. Bucket (b) — adding a dependant, terminating a CP38 order, archiving a
 * qualification, recording a salary revision — is rendered OUTSIDE this component by the page. That is
 * the safety argument, and it is structural rather than a list: this scope cannot read, mark, pack or
 * reset a control it does not contain, so "Discard Changes" can never appear to undo a recorded salary
 * revision. If a (b) card ever needs to move under a tab-wide Save, the classification has to change
 * first — not this file.
 *
 * THE FENCE IS NOT WEAKENED BY THE SUBMIT GUARD FURTHER DOWN. That guard asks before a bucket (b) form
 * writes, because its `redirect()` re-renders the screen and would throw the tab's pending edits away
 * unannounced. Asking is all it does: it never reads, marks, packs or resets that form, it replays the
 * card's OWN submit unchanged, and Cancel leaves the write undone.
 *
 * WHY THE CARDS STAY SEPARATE `<form>`s. Each posts a different payload to a different service; several
 * carry a sibling's value as a hidden input; and the writers read an ABSENT field as "leave as-is". One
 * merged form would collide duplicate names and start posting fields a card deliberately dropped. So the
 * markup is unchanged apart from losing its per-card Save button, and lib/tab-save-dom.ts reads each
 * subtree separately. The forms keep their `action={…}` — NOT as a no-JavaScript fallback, which is what
 * an earlier version of this note wrongly claimed. Implicit submission needs a form with no submit button
 * AND exactly one field that blocks it, and four of the five cards carry several, so with the bundle
 * blocked they cannot be posted by any keystroke. The binding stays because it is still the only place
 * each card's writer is wired to a form, because a bound form is what the submit guard below intercepts,
 * and because a `<form>` with no action at all would POST to the current URL.
 *
 * ENTER NO LONGER SUBMITS ONE CARD — AND NO LONGER SAVES ONE EITHER. The compliance card is the one form
 * left with exactly one blocking field (the date of birth), so HTML's implicit submission can still fire
 * there; a capture-phase keydown guard turns that into the consolidated save. It stands aside for two
 * kinds of target. A TEXTAREA / BUTTON / A owns the key by HTML's own rules. And a widget marked
 * `data-enter-owner` (ENTER_OWNER_SELECTOR, lib/tab-save-dom.ts) commits its own selection on this
 * keystroke — in React's BUBBLE phase, which is AFTER this capture listener. Saving from here was silent
 * data loss: the payload was built from the pre-selection DOM, so the tab saved the value the admin had
 * just replaced, and the post-save re-baseline then adopted the replacement as already-written, leaving
 * the pick gone and the tab reading clean under a "Changes saved" toast. Such a widget calls
 * `preventDefault()` itself, so standing aside cannot let an implicit submission through.
 *
 * THE SAVE READS THE DOM, NOT THE CHANGE STATE. `changes` is recomputed from events and is therefore, by
 * construction, one keystroke behind anything else handling the same keystroke. `save()` re-diffs the
 * live DOM at the instant it runs, so what is written is always what the admin can see.
 *
 * DISCARD REMOUNTS; SAVE DOES NOT. Restoring `input.value` by hand on a discard looks right and is wrong:
 * the Combobox and the other islands hold their selection in React state, so a hand-restored hidden value
 * would disagree with the label still on screen. Bumping a key remounts the whole subtree, which resets
 * every uncontrolled input to its server-rendered default AND every island to its initial props — and the
 * server-rendered default IS the last saved value. A SAVE takes the opposite route and re-baselines in
 * place (see `rebaselineSections`), because remounting there would race `router.refresh()` and could show
 * the reader the pre-save value under a "Changes saved" toast.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui';
import { registerUnsavedGuard, UNSAVED_GUARD_IGNORE_SELECTOR } from '@/lib/unsaved-changes';
import {
  baselineNewSections,
  buildTabPayload,
  diffTab,
  ENTER_OWNER_SELECTOR,
  markEditedFields,
  readSection,
  readTab,
  SECTION_SELECTOR,
  sectionElements,
  sectionId,
  type FieldChange,
  type TabSnapshot,
} from '@/lib/tab-save-dom';
import type { TabSaveResult } from '@/lib/personnel-tab-sections';

/**
 * The marker our own history entry carries, so a `popstate` can be told from a router navigation and the
 * entry can be recognised again after `personnel-tabs.tsx` replaceStates a `?tab=` onto it.
 */
const HISTORY_SENTINEL_KEY = '__tabSaveUnsavedSentinel';

/** One extra history entry at the CURRENT url, so the next Back press lands here instead of leaving. */
function pushHistorySentinel(): void {
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  window.history.pushState({ ...state, [HISTORY_SENTINEL_KEY]: true }, '', window.location.href);
}

function sameChanges(a: FieldChange[], b: FieldChange[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const d = b[i];
    return d != null && c.section === d.section && c.name === d.name && c.from === d.from && c.to === d.to;
  });
}

export function TabSaveScope({
  tabKey,
  employmentId,
  saveAction,
  children,
}: {
  /** The tab this scope belongs to — submitted so the action can land the reader back on it. */
  tabKey: string;
  employmentId: string;
  /** The consolidated server action, handed down by the RSC page (the established RSC→client pattern). */
  saveAction: (formData: FormData) => Promise<TabSaveResult>;
  children: ReactNode;
}) {
  const t = useTranslations('components.tabSave');
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<TabSnapshot>({});
  const [nonce, setNonce] = useState(0);
  const [changes, setChanges] = useState<FieldChange[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [promptOpen, setPromptOpen] = useState(false);
  const proceedRef = useRef<(() => void) | null>(null);

  const blankLabel = t('emptyValue');
  const editedLabel = t('editedBadge');

  const recompute = useCallback(() => {
    const root = contentRef.current;
    if (!root) return;
    // A card that was not on screen when the baseline was taken (the NRIC card appears only while the
    // nationality is Malaysian) gets its baseline the moment it appears, or every non-empty field in it
    // would read as an unsaved edit nobody made. See `baselineNewSections`.
    snapshotRef.current = baselineNewSections(root, snapshotRef.current, blankLabel);
    const next = diffTab(root, snapshotRef.current, blankLabel);
    markEditedFields(root, next, editedLabel);
    setChanges((prev) => (sameChanges(prev, next) ? prev : next));
  }, [blankLabel, editedLabel]);

  // Baseline, taken on mount and re-taken on every remount (`nonce` — which only a Discard bumps).
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    snapshotRef.current = readTab(root, blankLabel);
    markEditedFields(root, [], editedLabel);
    setChanges([]);
    setExpanded(false);
  }, [nonce, blankLabel, editedLabel]);

  /**
   * Re-baseline the sections that just committed, IN PLACE — no remount.
   *
   * A save must not reset the fields it just wrote. What is on screen after a successful save is exactly
   * what was written, so it becomes the new baseline directly. Remounting instead would race
   * `router.refresh()`: the fresh server payload has not necessarily arrived, and an uncontrolled input
   * that remounts against a stale `defaultValue` would show the reader the PRE-save value under a
   * "Changes saved" toast. Only the named sections are re-baselined, so a partial failure leaves the
   * section that did not commit still marked as edited.
   */
  const rebaselineSections = useCallback(
    (sections: string[]) => {
      const root = contentRef.current;
      if (!root || sections.length === 0) return;
      for (const section of sectionElements(root)) {
        const id = sectionId(section);
        if (!sections.includes(id)) continue;
        snapshotRef.current = { ...snapshotRef.current, [id]: readSection(section, blankLabel) };
      }
      snapshotRef.current = baselineNewSections(root, snapshotRef.current, blankLabel);
      const next = diffTab(root, snapshotRef.current, blankLabel);
      markEditedFields(root, next, editedLabel);
      setChanges(next);
      if (next.length === 0) setExpanded(false);
    },
    [blankLabel, editedLabel],
  );

  // What moved. `input`/`change` cover typing and native selects synchronously; the click/keyup/mutation
  // pass covers the islands, which write their value into a hidden input from React state and therefore
  // emit no input event at all.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        recompute();
      });
    };
    const now = () => recompute();
    root.addEventListener('input', now);
    root.addEventListener('change', now);
    root.addEventListener('click', schedule);
    root.addEventListener('keyup', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['value', 'checked'] });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('input', now);
      root.removeEventListener('change', now);
      root.removeEventListener('click', schedule);
      root.removeEventListener('keyup', schedule);
      observer.disconnect();
    };
  }, [recompute, nonce]);

  const dirty = changes.length > 0;

  const save = useCallback(
    (onDone?: () => void) => {
      const root = contentRef.current;
      if (!root) return;
      // WHAT IS ON SCREEN, not what the last event pass recorded. `changes` is derived from input/change/
      // click/keyup and a rAF pass, so it necessarily lags anything that handles the SAME keystroke later
      // in the same dispatch — which is how a save came to be packed from a Combobox's pre-selection
      // value and then re-baselined over the admin's actual pick. Re-diffing here removes that whole class
      // of race: the payload is built from the DOM as it stands at the instant Save runs.
      snapshotRef.current = baselineNewSections(root, snapshotRef.current, blankLabel);
      const live = diffTab(root, snapshotRef.current, blankLabel);
      const dirtySections = Array.from(new Set(live.map((c) => c.section)));
      if (dirtySections.length === 0) {
        onDone?.();
        return;
      }
      // Browser validation first, exactly as each card's own Save button used to get for free.
      for (const form of Array.from(root.querySelectorAll<HTMLFormElement>(`form${SECTION_SELECTOR}`))) {
        if (!dirtySections.includes(form.getAttribute('data-save-section') ?? '')) continue;
        if (!form.reportValidity()) return;
      }
      const payload = buildTabPayload(root, dirtySections, { employmentId, tab: tabKey });
      setError(null);
      startTransition(async () => {
        const result = await saveAction(payload);
        // Whatever DID commit is the server's truth now, success or not — re-baseline exactly those
        // sections so a partial failure leaves only the section that did not commit still marked edited.
        rebaselineSections(result.saved);
        if (result.saved.length > 0) router.refresh();
        if (!result.ok) {
          setError(result.error ?? t('saveFailed'));
          toast.error(result.error ?? t('saveFailed'));
          return;
        }
        toast.success(t('savedToast'));
        onDone?.();
      });
    },
    [blankLabel, employmentId, rebaselineSections, router, saveAction, t, tabKey],
  );

  const discard = useCallback(() => {
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  // Enter must never post one card on its own any more — see the header note.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (!target || !target.closest(SECTION_SELECTOR)) return;
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A') return;
      // A widget that OWNS Enter commits its own selection on this keystroke, from React's bubble-phase
      // handler — after this capture listener. Acting here would save the value it is about to replace
      // and then adopt the replacement as the new baseline, losing the edit AND reporting the tab clean.
      // It calls preventDefault() itself, so nothing can be implicitly submitted by standing aside.
      if (target.closest(ENTER_OWNER_SELECTOR)) return;
      e.preventDefault();
      save();
    };
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.matches(SECTION_SELECTOR)) return;
      e.preventDefault();
      e.stopPropagation();
      save();
    };
    root.addEventListener('keydown', onKeyDown, true);
    root.addEventListener('submit', onSubmit, true);
    return () => {
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('submit', onSubmit, true);
    };
  }, [save, nonce]);

  const ask = useCallback((proceed: () => void) => {
    proceedRef.current = proceed;
    setPromptOpen(true);
  }, []);

  // The tab strip (components/personnel-tabs.tsx) is a sibling island, not an ancestor, so the two meet
  // through the module-level registry rather than through context.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(
    () =>
      registerUnsavedGuard({
        isDirty: () => dirtyRef.current,
        prompt: (proceed) => askRef.current(proceed),
      }),
    [],
  );

  // Leaving the SCREEN. `beforeunload` covers reload / close / an external address and the hard
  // navigation a bare `<a>` performs; the capture-phase click guard covers in-app links (back to the
  // list, another employee, any nav item), which are client-side navigations `beforeunload` never sees;
  // the submit guard below covers a bucket (b) write, whose redirect re-renders the screen; and the
  // popstate guard after it covers browser Back / Forward. The tab strip (personnel-tabs.tsx) and the
  // Search Employee switcher reach the same prompt through lib/unsaved-changes.ts. That is every route
  // the reporter listed.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      // An anchor that is not a link to a page — the Employment History workbook route is a bare `<a>`
      // whose click downloads a file and leaves nobody anywhere. Prompting there would be a dialog for an
      // action that loses nothing, followed by a router.push at a route with no page to render.
      if (anchor.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // A same-page anchor is not leaving anything.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      ask(() => router.push(`${url.pathname}${url.search}${url.hash}`));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, ask, router]);

  /**
   * A BUCKET (b) WRITE IS ALSO A WAY OFF THIS TAB, and it was the one route nothing watched.
   *
   * Adding an emergency contact, archiving a qualification, recording a salary revision — each of those is
   * a server action whose `redirect()` re-renders the screen. That is neither an anchor click nor a
   * document unload nor a history pop, so an unsaved Full Name edit went with it, silently, with no
   * Save / Discard / Cancel. The loss predates the consolidated save (per-card saves reloaded too), but
   * this scope's promise — the system will not let you wander off and lose work — has to cover it.
   *
   * It is a CAPTURE-phase listener on `document`, and both halves of that matter. React 19 accumulates a
   * form's `action` listener only in the BUBBLE phase (`!inCapturePhase` in accumulateSinglePhaseListeners),
   * so stopping propagation at the document on the way DOWN means the action is never dispatched at all —
   * measured, not assumed. And it has to be on the document rather than on this component's subtree,
   * because the bucket (b) forms are elsewhere: the emergency-contact register sits below the scope, and
   * its add/edit forms render inside a Radix dialog, portalled to `document.body`.
   *
   * NOTHING IS RE-IMPLEMENTED. On Save or Discard the guard replays the ORIGINAL submit —
   * `form.requestSubmit(submitter)`, carrying the button that was pressed so a `formAction` still applies,
   * which is the same gesture components/ui/confirm-submit.tsx already uses on this screen. The replay is
   * let through by the ref below, so the guard cannot see its own echo. Cancel drops it: no write, edits
   * kept, reader where they were.
   */
  const replayingRef = useRef<HTMLFormElement | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const root = contentRef.current;
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      // Our own replay coming back round.
      if (replayingRef.current === form) {
        replayingRef.current = null;
        return;
      }
      // The tab's own cards are handled by the scope-local submit guard, which knows how to turn one into
      // the consolidated save rather than a prompt.
      if (root?.contains(form)) return;
      if (form.closest(UNSAVED_GUARD_IGNORE_SELECTOR)) return;
      const submitter = (e as SubmitEvent).submitter;
      e.preventDefault();
      e.stopPropagation();
      ask(() => {
        replayingRef.current = form;
        if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
          form.requestSubmit(submitter);
        } else {
          form.requestSubmit();
        }
      });
    };
    document.addEventListener('submit', onSubmit, true);
    return () => document.removeEventListener('submit', onSubmit, true);
  }, [dirty, ask]);

  /**
   * BROWSER BACK / FORWARD — "Click Back" is one of the routes the reporter named, and it is the one
   * neither `beforeunload` nor the click guard can see: an App Router history pop is a client-side
   * navigation with no unload and no anchor, and Next 16 exposes no navigation-cancel hook.
   *
   * SO THE GUARD IS A HISTORY SENTINEL. The first time the tab goes dirty we push one extra entry with
   * the SAME url as the page. A Back press then pops that entry instead of leaving: nothing on screen
   * changes, and `popstate` tells us what happened. Still dirty → we re-push the sentinel (so a second
   * Back is caught too) and ask; choosing Save or Discard traverses -2, past the sentinel and past the
   * entry it shadows, which is exactly the one step back the reader asked for. Already clean → the
   * sentinel has done its job, so we complete the reader's Back with -1 instead of prompting.
   *
   * WHY ARMED ONCE AND NOT PER DIRTY/CLEAN CYCLE. Popping the sentinel on every save would mean a
   * history traversal racing `router.refresh()`, and — worse — a traversal fired after the reader had
   * ALREADY left through the prompt's own Save/Discard, sending them a step further back than they
   * asked. Leaving it armed costs one extra Back press's worth of nothing on a page that was edited, and
   * a page nobody edited never arms it at all.
   */
  const sentinelArmedRef = useRef(false);
  useEffect(() => {
    if (!dirty || sentinelArmedRef.current || typeof window === 'undefined') return;
    pushHistorySentinel();
    sentinelArmedRef.current = true;
  }, [dirty]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      if (!sentinelArmedRef.current) return;
      if (!dirtyRef.current) {
        // Nothing to lose — finish the journey the reader started.
        sentinelArmedRef.current = false;
        window.history.go(-1);
        return;
      }
      pushHistorySentinel();
      askRef.current(() => {
        sentinelArmedRef.current = false;
        window.history.go(-2);
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const closePrompt = () => {
    proceedRef.current = null;
    setPromptOpen(false);
  };

  return (
    <div className="space-y-6" data-tab-save-scope={tabKey}>
      <div key={nonce} ref={contentRef} className="space-y-6">
        {children}
      </div>

      <div
        data-tab-save-bar
        className="sticky bottom-3 z-30 rounded-[1.25rem] border border-border bg-card/95 p-3 shadow-[var(--shadow-card)] backdrop-blur"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            {dirty ? (
              <>
                <span
                  data-tab-save-count
                  className="inline-flex items-center rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground"
                >
                  {t('changedCount', { count: changes.length })}
                </span>
                <button
                  type="button"
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded ? t('hideChanges') : t('reviewChanges')}
                </button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{t('noChanges')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!dirty || pending} onClick={discard}>
              {t('discardChanges')}
            </Button>
            <Button type="button" size="sm" disabled={!dirty || pending} onClick={() => save()}>
              {pending ? t('saving') : t('saveChanges')}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {dirty && expanded && (
          <div className="mt-3 overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colField')}</th>
                  <th className="px-3 py-2 font-medium">{t('colOriginal')}</th>
                  <th className="px-3 py-2 font-medium">{t('colNew')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {changes.map((c) => (
                  <tr key={`${c.section}.${c.name}`} data-change-row={`${c.section}.${c.name}`}>
                    <td className="px-3 py-1.5 font-medium">{c.label}</td>
                    <td className="px-3 py-1.5 text-muted-foreground line-through">{c.from}</td>
                    <td className="px-3 py-1.5">{c.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog.Root open={promptOpen} onOpenChange={(open) => (open ? setPromptOpen(true) : closePrompt())}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
            <Dialog.Title className="text-base font-semibold">{t('unsavedTitle')}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {t('unsavedBody')}
            </Dialog.Description>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closePrompt}>
                {t('cancel')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const proceed = proceedRef.current;
                  closePrompt();
                  discard();
                  proceed?.();
                }}
              >
                {t('discardChanges')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => {
                  const proceed = proceedRef.current;
                  setPromptOpen(false);
                  proceedRef.current = null;
                  // `proceed` runs only after the save actually succeeds — a failed save must leave the
                  // reader on the tab, with the edits still there.
                  save(() => proceed?.());
                }}
              >
                {t('saveChanges')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
