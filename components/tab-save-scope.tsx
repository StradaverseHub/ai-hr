'use client';

/**
 * 420ebab5 part two — ONE "Save Changes" for a tab, the change summary that goes with it, and the
 * Save / Discard / Cancel prompt that stops an edit being walked away from.
 *
 * WHAT IT WRAPS, AND WHAT IT DELIBERATELY DOES NOT. The scope's children are the server-rendered cards
 * whose forms carry `data-save-section="<id>"` — bucket (a) of
 * docs/audits/420ebab5-personnel-save-classification.md, the plain field edits that overwrite a value on
 * the person or employment record. Bucket (b) — adding a dependant, terminating a CP38 order, archiving a
 * qualification, recording a salary revision — is not among them. That is the safety argument, and it is
 * structural rather than a list: this scope reads, marks, packs and resets ONLY `[data-save-section]`
 * subtrees, so "Discard Changes" can never appear to undo a recorded salary revision. If a (b) card ever
 * needs to move under a tab-wide Save, the classification has to change first — not this file.
 *
 * r255 — "rendered outside this component" is how the page keeps most of bucket (b) away, and it is no
 * longer the whole story: the Employment tab's company-transfer form lives inside the very card that
 * carries the Employment Dates section. THE MARKER, NOT THE SUBTREE, IS THE FENCE. Both guards below were
 * corrected to test it.
 *
 * AND THE BAR SAYS WHAT IT COVERS, because on three of the four tabs it is NOT the last thing on the tab.
 * A tab Save can only enclose a CONTIGUOUS run of cards, and every tab except Bank & Statutory has bucket
 * (b) cards that have to sit outside that run — so the sticky bar renders above cards it does not own.
 * A bar reading only "Save Changes" would then be a control that appears to do something it does not
 * (press it after editing the Direct Superior and it answers "No unsaved changes"); the `covers` prop
 * makes it name its own cards instead. The alternative — pushing the scope to the foot of every tab —
 * was tried and rejected: on Attendance it silently reversed item 52a30630's "Holiday Calendar pinned
 * first", trading an honest control for a wrong reading order.
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
 * WHAT DISCARD REACHES, STATED PLAINLY (r255). The remount below resets the scope's whole subtree to its
 * server-rendered state, and on the Employment tab that subtree also contains two forms the tab does not
 * own — the company-transfer form and the company-change navigation form, which live inside the same card
 * as the Employment Dates form. Nothing they hold is a recorded act (their controls are all
 * `defaultValue=""` or the current company, so the reset lands them exactly where the server drew them),
 * and nothing of theirs is ever read, marked, packed or counted: lib/tab-save-dom.ts only ever walks
 * `[data-save-section]` subtrees. What Discard can undo is therefore still only what the change summary
 * listed. It cannot reach a WRITE it did not make — no dependant, no salary revision, no CP38 order.
 *
 * DISCARD REMOUNTS; SAVE DOES NOT. Restoring `input.value` by hand on a discard looks right and is wrong:
 * the Combobox and the other islands hold their selection in React state, so a hand-restored hidden value
 * would disagree with the label still on screen. Bumping a key remounts the whole subtree, which resets
 * every uncontrolled input to its server-rendered default AND every island to its initial props — and the
 * server-rendered default IS the last saved value. A SAVE takes the opposite route and re-baselines in
 * place (see `rebaselineSections`), because remounting there would race `router.refresh()` and could show
 * the reader the pre-save value under a "Changes saved" toast.
 *
 * …WHICH IS ONLY TRUE ONCE THE REFRESH HAS COME BACK, and r257 measured what happens before it does: the
 * server-rendered default is then the PRE-save value, so a Discard pressed in that window did not just
 * show a stale field, it wrote one back. See the note over `discard` — the discard now waits for the
 * payload it restores from.
 *
 * 15e5bd93 REVISION 4 (r372) — AND IT NOW SERVES A SCREEN AS WELL AS A TAB. The dedicated Statutory
 * Payment Setup screen is eight statutory bodies with every field open under ONE Save, which is the
 * reporter's own expected_function and the one combination this product has never built. Everything a
 * SCREEN needs and a tab does not — the same two actions repeated above the cards, a Cancel that LEAVES
 * rather than reverting in place, and a leave prompt worded for leaving — arrives through the single
 * optional `screenActions` prop below. Every scope that came before it omits the prop and renders
 * byte-identically; `sectionLabels` set that precedent one round earlier.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, buttonVariants } from '@/components/ui';
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
import type { TabSaveResult } from '@/lib/tab-save-sections';

/**
 * The marker our own history entry carries, so a `popstate` can be told from a router navigation and the
 * entry can be recognised again after `personnel-tabs.tsx` replaceStates a `?tab=` onto it.
 */
const HISTORY_SENTINEL_KEY = '__tabSaveUnsavedSentinel';

/**
 * HOW LONG A DISCARD WILL WAIT for the refreshed server payload before restoring from the markup it
 * already has (see the note over `discard`). In practice the wait is whatever is LEFT of one RSC round
 * trip — the reader can only be in that window because the refresh is still in flight — so it is normally
 * a few hundred milliseconds. The bound exists for the one case that is not: a refresh that never comes
 * back must not leave Discard as a control that does nothing, which AGENTS 28 rates worse than the narrow
 * window it is protecting against.
 */
const REFRESH_WAIT_MS = 5_000;

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
  identity,
  saveAction,
  covers,
  sectionLabels,
  screenActions,
  children,
}: {
  /** The tab this scope belongs to — submitted so the action can land the reader back on it. */
  tabKey: string;
  /**
   * THE TOP-LEVEL IDENTITY OF THE RECORD BEING EDITED, set once on the consolidated payload.
   *
   * It was `employmentId: string` until 65b22c00 gave the Organization company panel a consolidated
   * Save; the company's key is `companyId`, and passing a company under the name `employmentId` would be
   * a lie in the wire format that the server would then have to un-tell. The shape is a record because
   * the reason this exists at all is that the id must arrive ONCE, at the top level, rather than being
   * trusted from each section's own hidden copy — n hidden copies of an id are n chances for a crafted
   * payload to point one write at a different record (see `sectionFormData`).
   *
   * Read through a ref inside `save` rather than closed over, so a caller that renders this scope inside
   * a CLIENT component (the company panel does) does not rebuild every listener on every keystroke.
   */
  identity: Record<string, string>;
  /** The consolidated server action, handed down by the RSC page (the established RSC→client pattern). */
  saveAction: (formData: FormData) => Promise<TabSaveResult>;
  /**
   * THE NAMES OF THE CARDS THIS SAVE OWNS, already translated by the page, printed on the bar itself.
   *
   * Required, not optional, and that is the point. Only Bank & Statutory has a scope that covers its
   * whole tab; on Profile, Attendance and Employment the bar sits above cards it does NOT cover (the
   * emergency-contact register, Work Location and Shift Arrangement, the Direct Superior line and the
   * delegations) because a tab Save must enclose a CONTIGUOUS run of cards and those cards are bucket
   * (b). A sticky bar with nothing but "Save Changes" on it reads as covering everything below it, which
   * is precisely the control-that-lies the classification exists to prevent — so it says what it covers,
   * and a new tab cannot be wired up without answering the question.
   */
  covers: string[];
  /**
   * 15e5bd93 (r352) — SECTION ID → THE NAME OF THE CARD IT IS, so the bar can say WHICH cards moved.
   *
   * `covers` is static: it names everything this Save owns, whether or not it changed. On a tab whose
   * cards are a handful of named things that all look alike — the Organization Statutory tab is eight
   * statutory bodies with an identical field set — "Unsaved changes: 3" does not answer the question the
   * reader actually has, which is *which bodies*. The reporter's approved drawing for that item has the
   * bar reading "2 bodies changed — EPF, LHDN", and this is that.
   *
   * OPTIONAL, and omitted by every scope that existed before it: a tab whose cards are already visibly
   * different from one another gains nothing, and the bar renders exactly as it did. An id with no entry
   * is skipped rather than printed raw, so a section added without a label degrades to the old bar.
   * Deliberately NOT a new catalogue string: the values are card names the page has already translated,
   * and they are printed as a plain list beside the count rather than inside a sentence.
   */
  sectionLabels?: Record<string, string>;
  /**
   * 15e5bd93 REVISION 4 (r372) — THE SCREEN SHAPE. Absent on every scope that came before it, and the
   * bar renders byte-identically there; this is `sectionLabels`' pattern, one round on.
   *
   * A TAB's scope lives inside a screen that has its own header, its own Back link and other tabs below
   * it. A SCREEN's scope IS the screen, and the dedicated Statutory Payment Setup screen is eight
   * statutory bodies with every field open — long enough that the actions have to be reachable without
   * scrolling to either end. Three things follow, and each is drawn on the approved mockup:
   *
   *  1. THE SAME TWO ACTIONS ABOVE THE CARDS AS WELL AS BELOW THEM. The top row is the two buttons and
   *     nothing else: the count chip, the "what this saves" line and the change table stay in the one
   *     sticky bar at the foot, so no marker this file emits is duplicated.
   *
   *  2. CANCEL LEAVES; IT DOES NOT REVERT IN PLACE. The reporter's own words are "Back returns to the
   *     selected company's Statutory tab… If there are unsaved changes: Save & Leave / Discard & Leave /
   *     Cancel". So on a screen scope the bar's outline button is a LINK to `leave.href`, and the
   *     capture-phase anchor guard further down turns it into exactly that three-button prompt when the
   *     screen is dirty. Discard-and-stay is NOT drawn on the approved mockup and is not invented here;
   *     discarding is reachable as the prompt's middle button, which is where the reporter put it.
   *
   *  3. THE PROMPT SPEAKS THE SCREEN'S OWN WORDS. `components.tabSave` says "Discard Changes" /
   *     "Save Changes", which are the right words for a tab you are staying on and the wrong ones for a
   *     leave prompt. The five strings are passed in, already translated, so the personnel and General
   *     scopes are untouched.
   */
  screenActions?: {
    /** Where Cancel goes. A LINK, so the anchor guard below owns the unsaved case. */
    leave: { href: string; label: string };
    /** The Save caption on both rows ("Save all changes"), and the prompt's own Save caption. */
    saveLabel: string;
    prompt: { title: string; body: string; cancel: string; discard: string; save: string };
  };
  children: ReactNode;
}) {
  const t = useTranslations('components.tabSave');
  const router = useRouter();
  // See `identity`: the live value, so `save` need not close over a prop the caller may rebuild.
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const contentRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef<TabSnapshot>({});
  const [nonce, setNonce] = useState(0);
  const [changes, setChanges] = useState<FieldChange[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [promptOpen, setPromptOpen] = useState(false);
  const proceedRef = useRef<(() => void) | null>(null);

  // THE REFRESH WINDOW (r257) — all of it is explained over `discard`. Declared up here because the save
  // path arms the first of them and the bar's buttons read the third.
  /** A save has committed and its `router.refresh()` has not come back: `children` is behind the record. */
  const staleUntilRefreshRef = useRef(false);
  /** A Discard pressed inside that window, armed and waiting for the payload it needs. */
  const discardWaitingRef = useRef(false);
  const [discardWaiting, setDiscardWaiting] = useState(false);
  /** The wait timed out and the reader was given the restore that WAS available; repair it when the
   *  payload finally lands. */
  const remountOnFreshRef = useRef(false);
  const waitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /**
   * 15e5bd93 — WHICH cards moved, in document order (which is the order `diffTab` walks the sections in,
   * and therefore the order the reader sees them on screen). An id with no label is skipped: a bar that
   * printed a raw section id would be worse than one that printed nothing.
   */
  const changedLabels = sectionLabels
    ? Array.from(new Set(changes.map((c) => c.section)))
        .map((id) => sectionLabels[id])
        .filter((label): label is string => Boolean(label))
    : [];

  const save = useCallback(
    (onDone?: () => void) => {
      const root = contentRef.current;
      if (!root) return;
      // A DISCARD IS ALREADY ARMED and waiting for the refreshed payload (see `discard`); writing now
      // would commit the very edits the reader has just asked to throw away. Both bar buttons and the
      // prompt's Save are disabled while that is true, so this covers the routes that are not buttons:
      // the Enter key and an implicit form submission.
      if (discardWaitingRef.current) return;
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
      const payload = buildTabPayload(root, dirtySections, { ...identityRef.current, tab: tabKey });
      setError(null);
      startTransition(async () => {
        const result = await saveAction(payload);
        // Whatever DID commit is the server's truth now, success or not — re-baseline exactly those
        // sections so a partial failure leaves only the section that did not commit still marked edited.
        rebaselineSections(result.saved);
        if (result.saved.length > 0) {
          // From here until the payload comes back, the server markup this scope would restore from is
          // one round trip behind the record. See `discard`.
          staleUntilRefreshRef.current = true;
          router.refresh();
        }
        if (!result.ok) {
          setError(result.error ?? t('saveFailed'));
          toast.error(result.error ?? t('saveFailed'));
          return;
        }
        toast.success(t('savedToast'));
        onDone?.();
      });
    },
    [blankLabel, rebaselineSections, router, saveAction, t, tabKey],
  );

  const endDiscardWait = useCallback(() => {
    if (waitTimerRef.current !== null) {
      clearTimeout(waitTimerRef.current);
      waitTimerRef.current = null;
    }
    discardWaitingRef.current = false;
    setDiscardWaiting(false);
  }, []);

  /**
   * DISCARD, AND THE ONE WINDOW IN WHICH THE MARKUP IT RESTORES FROM IS NOT THE LAST SAVED VERSION.
   *
   * r257 measured this rather than reasoning about it. `router.refresh()` dispatches inside its OWN
   * transition and returns synchronously, so the moment a save resolves the bar is live again while
   * `children` still carries the values the page opened with. A Discard pressed there did not merely SHOW
   * a stale field, which is how an earlier note under-described it: the remount put the PRE-save value
   * back into the input, the fresh baseline adopted it as "last saved", and the next save of that section
   * posted it — `buildTabPayload` packs every control of a dirty section, not only the changed ones, and
   * `syncCarriedValues` mirrors the same stale value into the sibling section's carry-through input. An
   * edit that had already been written was therefore overwritten by its own pre-save value, silently.
   *
   * SO THE DISCARD WAITS FOR THE PAYLOAD IT NEEDS. `staleUntilRefreshRef` is armed when a save commits and
   * cleared when a new `children` identity arrives — which is the refreshed RSC payload and nothing else,
   * because this component's own state changes re-render it with the SAME element the server made. A
   * Discard inside the window is armed instead of run and fires the instant that payload lands, restoring
   * the real last-saved values through the same remount as always, islands included.
   *
   * WHY NOT WRITE THE SAVED VALUES BACK INSTEAD, which would need no wait at all: half of these controls
   * are React-CONTROLLED by client islands (the Combobox submits through `<input type="hidden"
   * value={selected}>`), so a hand-restored value would disagree with the label beside it and be reverted
   * by that island's next render — the hazard the header note has warned about since this file was
   * written. Restoring from what the client POSTED has a second fault: the server normalises what it
   * stores, so Discard would put back the admin's raw keystrokes rather than the record as it now reads.
   *
   * WHAT IS LEFT. If the payload does not come back within REFRESH_WAIT_MS the reader gets the restore
   * that IS available (the pre-r257 behaviour) rather than a button that never answers, and the repair is
   * re-armed: when the payload does arrive, a tab nobody has touched since is remounted onto it. What
   * survives that is one case — a refresh slower than the bound AND a further edit AND a save of the same
   * section before the payload lands.
   */
  const discard = useCallback(() => {
    setError(null);
    // Already armed. Pressing again cannot make the payload come back sooner.
    if (discardWaitingRef.current) return;
    if (staleUntilRefreshRef.current) {
      discardWaitingRef.current = true;
      setDiscardWaiting(true);
      waitTimerRef.current = setTimeout(() => {
        endDiscardWait();
        // The refresh is not coming. Stop making every later Discard pay the same wait to learn that
        // again — but keep the repair armed, so if the payload does turn up the saved values go back.
        staleUntilRefreshRef.current = false;
        remountOnFreshRef.current = true;
        setNonce((n) => n + 1);
      }, REFRESH_WAIT_MS);
      return;
    }
    setNonce((n) => n + 1);
  }, [endDiscardWait]);

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

  /**
   * THE REFRESHED PAYLOAD ARRIVING — the moment the markup Discard restores from stops being stale.
   *
   * A new `children` IDENTITY is that payload and nothing else: this component re-renders on its own
   * state constantly (every keystroke moves `changes`) and React hands it the SAME element the server
   * made each time, so only a replaced RSC tree can change this prop. That makes it the signal a discard
   * armed in the window is waiting for — see `discard`.
   */
  useEffect(() => {
    staleUntilRefreshRef.current = false;
    const armed = discardWaitingRef.current;
    const rearmed = remountOnFreshRef.current;
    remountOnFreshRef.current = false;
    if (!armed && !rearmed) return;
    endDiscardWait();
    // The re-arm is a repair, not a command: if the reader has started editing again since the wait timed
    // out, their edits outrank putting the saved values back on screen. An ARMED discard is a command.
    if (!armed && dirtyRef.current) return;
    setNonce((n) => n + 1);
  }, [children, endDiscardWait]);

  // Never leave a wait timer running behind an unmounted tab.
  useEffect(
    () => () => {
      if (waitTimerRef.current !== null) clearTimeout(waitTimerRef.current);
    },
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
   * because bucket (b) forms are BOTH outside and inside it: the emergency-contact register sits below the
   * scope and renders its add/edit forms inside a Radix dialog portalled to `document.body`, while the
   * Employment tab's company-transfer form sits INSIDE the same card as the Employment Dates form the tab
   * does own. What separates the two kinds is the section marker, not the subtree — see the test below.
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
    const onSubmit = (e: Event) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      // Our own replay coming back round.
      if (replayingRef.current === form) {
        replayingRef.current = null;
        return;
      }
      // A CONSOLIDATED CARD is handled by the scope-local submit guard below, which knows how to turn one
      // into the consolidated save rather than a prompt.
      //
      // r255 — the test is the SECTION MARKER, and it used to be "is this form inside the scope's
      // subtree?", which was wrong the moment a tab put a bucket (b) form inside a consolidated card. The
      // Employment tab does exactly that: the company-transfer form and the `method="get"` company-change
      // navigation form both live INSIDE the Employment Information card, above the Employment Dates form
      // that carries the marker. Under the old test both were invisible to this guard AND to the
      // scope-local one, so submitting either took the reader's unsaved date edits with it, silently, in a
      // redirect — the exact loss this guard exists to stop.
      if (form.matches(SECTION_SELECTOR)) return;
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

  /**
   * 15e5bd93 rev 4 — the screen scope's action pair, rendered ABOVE the cards and again inside the
   * sticky bar. One function, so the two rows cannot drift into two different Saves.
   *
   * Cancel is a `<Link>` and never a button: the capture-phase anchor guard above is what turns it into
   * the Save & Leave / Discard & Leave / Cancel prompt while the screen is dirty, and it only ever sees
   * anchors. `discardWaiting` disables Save for the same reason the bar's own Save is disabled — a
   * discard armed and waiting for the refreshed payload must not be overwritten by the edits it is
   * throwing away.
   */
  const screenActionPair = (where: 'top' | 'bar') =>
    screenActions ? (
      <>
        <Link
          href={screenActions.leave.href}
          data-tab-save-leave={where}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {screenActions.leave.label}
        </Link>
        <Button
          type="button"
          size="sm"
          data-tab-save-submit={where}
          disabled={!dirty || pending || discardWaiting}
          onClick={() => save()}
        >
          {pending ? t('saving') : screenActions.saveLabel}
        </Button>
      </>
    ) : null;

  return (
    <div className="space-y-6" data-tab-save-scope={tabKey}>
      {/* The actions repeated above the cards — the screen is eight bodies with every field open, and
          the approved mockup draws Cancel and Save at the top as well as the foot. Deliberately NOT a
          second copy of the bar: no covers line, no count chip, no change table, so every marker this
          file emits still appears exactly once. */}
      {screenActions && (
        <div data-tab-save-bar-top className="flex flex-wrap items-center justify-end gap-2">
          {screenActionPair('top')}
        </div>
      )}

      <div key={nonce} ref={contentRef} className="space-y-6">
        {children}
      </div>

      <div
        data-tab-save-bar
        className="sticky bottom-3 z-30 rounded-[1.25rem] border border-border bg-card/95 p-3 shadow-[var(--shadow-card)] backdrop-blur"
      >
        {/* WHAT THIS BAR COVERS, on the bar. See the `covers` prop: the scope encloses a contiguous run of
            the tab's field-edit cards, and on three of the four tabs there are cards below it that keep
            their own Save button. Naming them is what stops the bar reading as "Save everything on this
            tab". */}
        <p data-tab-save-covers className="mb-2 text-xs text-muted-foreground">
          {t('covers', { cards: covers.join(', ') })}
        </p>
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
                {/* 15e5bd93 — the cards that moved, by name. See `sectionLabels`: absent on every scope
                    that does not ask for it, so the bar is byte-identical there. */}
                {changedLabels.length > 0 && (
                  <span data-tab-save-changed className="min-w-0 text-xs text-muted-foreground">
                    {changedLabels.join(' · ')}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">{t('noChanges')}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* `discardWaiting` disables BOTH: a discard that is waiting for the refreshed payload has
                already been asked for, and a save pressed on top of it would write the edits it is
                throwing away. */}
            {screenActions ? (
              screenActionPair('bar')
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!dirty || pending || discardWaiting}
                  onClick={discard}
                >
                  {discardWaiting ? t('discarding') : t('discardChanges')}
                </Button>
                <Button type="button" size="sm" disabled={!dirty || pending || discardWaiting} onClick={() => save()}>
                  {pending ? t('saving') : t('saveChanges')}
                </Button>
              </>
            )}
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
            {/* 15e5bd93 rev 4 — a screen scope speaks its own words here. The prompt is reached by
                LEAVING (Back, Cancel, a nav link, browser Back), so "Discard Changes" / "Save Changes"
                under-describe what the buttons do; the reporter listed Save & Leave / Discard & Leave /
                Cancel by name. Every other scope falls through to `components.tabSave`, unchanged. */}
            <Dialog.Title className="text-base font-semibold">
              {screenActions ? screenActions.prompt.title : t('unsavedTitle')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {screenActions ? screenActions.prompt.body : t('unsavedBody')}
            </Dialog.Description>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={closePrompt}>
                {screenActions ? screenActions.prompt.cancel : t('cancel')}
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
                {screenActions ? screenActions.prompt.discard : t('discardChanges')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={pending || discardWaiting}
                onClick={() => {
                  const proceed = proceedRef.current;
                  setPromptOpen(false);
                  proceedRef.current = null;
                  // `proceed` runs only after the save actually succeeds — a failed save must leave the
                  // reader on the tab, with the edits still there.
                  save(() => proceed?.());
                }}
              >
                {screenActions ? screenActions.prompt.save : t('saveChanges')}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
