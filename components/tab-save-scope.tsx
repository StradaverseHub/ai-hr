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
 * WHY THE CARDS STAY SEPARATE `<form>`s. Each posts a different payload to a different service; several
 * carry a sibling's value as a hidden input; and the writers read an ABSENT field as "leave as-is". One
 * merged form would collide duplicate names and start posting fields a card deliberately dropped. So the
 * markup is unchanged apart from losing its per-card Save button, and lib/tab-save-dom.ts reads each
 * subtree separately. The forms even keep their `action={…}`, which is the no-JavaScript fallback.
 *
 * ENTER NO LONGER SUBMITS ONE CARD. With the per-card Save buttons gone, HTML's implicit submission still
 * fires for a form left with exactly one field that blocks it (the compliance card, whose only such field
 * is the date of birth). A capture-phase keydown guard turns Enter into the consolidated save instead.
 * The submit guard beside it is a second line: React's form-action plugin runs its listener from the ROOT
 * container, so an inner capture listener cannot be relied on to beat it — the keydown guard is what
 * actually makes it impossible for a submit event to exist.
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
import { registerUnsavedGuard } from '@/lib/unsaved-changes';
import {
  buildTabPayload,
  diffTab,
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
      const dirtySections = Array.from(new Set(changes.map((c) => c.section)));
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
    [changes, employmentId, rebaselineSections, router, saveAction, t, tabKey],
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

  // Leaving the SCREEN. `beforeunload` covers reload / close / an external address; the capture-phase
  // click guard covers in-app links (back to the list, another employee, any nav item), which are
  // client-side navigations `beforeunload` never sees. Browser Back on a client-side history entry is not
  // interceptable by either and is the one gap — recorded in the round write-up rather than papered over.
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
