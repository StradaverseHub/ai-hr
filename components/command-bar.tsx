'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Search, ArrowRight, UserCog, CornerDownLeft, UserRound } from 'lucide-react';
import { DelegationManager } from '@/components/delegation-manager';
import { loadDelegationContextAction, type DelegationContext } from '@/app/delegations/actions';
// r306 — the palette's page list IS the rail's visibility answer, not a second copy of it.
import { visibleNavRows, type NavGates, type NavSearchRow } from '@/components/sidebar';
import {
  commandBarGatesAction,
  searchPeopleAction,
  type CommandPersonHit,
} from '@/app/command-bar-actions';

/**
 * R44 delegation (Phase 1) — the product's FIRST global command bar. There was no search / cmdk primitive
 * anywhere, so this is built from scratch: a topbar trigger + a Cmd/Ctrl-K listener open a Radix Dialog with
 * a text box that substring-matches a small in-code registry of quick actions. It is deliberately generic
 * (add entries to COMMAND_ITEMS) — v1 shipped one action, "Approval Delegation".
 *
 * r306 — IT NOW FINDS PAGES AND PEOPLE, because one action was not a search and "I cannot find it" is the
 * complaint this product gets most: a public-holiday screen the consultant could not locate (R20), a grade
 * field that was on the page all along behind a collapsed section (2026-09-12), 200-odd screens behind a
 * rail that only fits 16 rows at a time.
 *
 *   • PAGES come from `visibleNavRows` in components/sidebar.tsx — the rail's own filter, so the palette
 *     cannot offer a screen the menu hides or a module the tenant has not bought. One owner, not a copy.
 *   • PEOPLE come from the People screen's own paginated query under RLS, six at a time.
 *   • ACTIONS stay the in-code registry below.
 *
 * The gates and the people search are server actions fetched when the dialog opens (app/command-bar-actions.ts),
 * so the header keeps rendering `<CommandBar />` with no props and an unopened palette costs nothing.
 *
 * Popup parity (feedback 29fe2d45): the delegation quick panel renders the SAME DelegationManager as the
 * /delegations page — coverage cascade, existing-delegation list, edit/revoke, history toggle, HR
 * on-behalf create — so the entire setup completes inside the popup; the full page is just a larger
 * workspace. Saving stays in the dialog (uniform action results, no redirect), and a loader failure shows
 * an error + retry instead of wrongly telling an approver they cannot delegate.
 */

type CommandItemId = 'delegation';

type CommandItem = {
  id: CommandItemId;
  /** i18n keys under the `commandBar` namespace. */
  titleKey: string;
  subtitleKey: string;
  /** Extra English keywords for substring match (title/subtitle are always matched too). */
  keywords: string[];
};

// The registry. Keep this the single source of truth for what the command bar can do — extend it, don't
// scatter conditionals through the render. Matching is a case-insensitive substring over the localized
// title + subtitle + these keywords.
const COMMAND_ITEMS: CommandItem[] = [
  {
    id: 'delegation',
    titleKey: 'delegationTitle',
    subtitleKey: 'delegationSubtitle',
    keywords: ['delegation', 'delegate', 'approval', 'cover', 'stand-in', 'standin', 'away', 'leave cover'],
  },
];

export function CommandBar() {
  const t = useTranslations('commandBar');
  // Page labels are the rail's own keys, read from the rail's own namespace — so a screen is called
  // the same thing in ⌘K as it is in the menu, in all six locales, with nothing new to translate.
  const nav = useTranslations('nav');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Which action's sub-panel is showing (null = the search list).
  const [active, setActive] = useState<CommandItemId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // r306 — resolved once per session on first open, then reused: the gates do not change under the user.
  const [gates, setGates] = useState<NavGates | null>(null);
  const [people, setPeople] = useState<CommandPersonHit[]>([]);
  const [peopleBusy, setPeopleBusy] = useState(false);

  // Cmd/Ctrl-K opens the bar from anywhere; Escape is handled by the Dialog itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The gates arrive from the server on first open. A failure leaves `gates` null, which renders the
  // palette WITHOUT pages rather than with a guessed list — the one thing worse than no page list is a
  // page list that advertises somebody else's screens.
  useEffect(() => {
    if (!open || gates !== null) return;
    let live = true;
    commandBarGatesAction()
      .then((g) => {
        if (live) setGates(g);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, gates]);

  // People are searched server-side, so the query is debounced: one keystroke is not one query. The
  // `live` flag drops a late response from an earlier query — otherwise fast typing can paint results
  // for a prefix the person has already finished.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setPeople([]);
      setPeopleBusy(false);
      return;
    }
    let live = true;
    setPeopleBusy(true);
    const timer = setTimeout(() => {
      searchPeopleAction(q)
        .then((hits) => {
          if (live) setPeople(hits);
        })
        .catch(() => {
          if (live) setPeople([]);
        })
        .finally(() => {
          if (live) setPeopleBusy(false);
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, open]);

  const reset = useCallback(() => {
    setQuery('');
    setActive(null);
    setPeople([]);
    setPeopleBusy(false);
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) reset();
    },
    [reset],
  );

  const q = query.trim().toLowerCase();
  const results = COMMAND_ITEMS.filter((item) => {
    if (!q) return true;
    const hay = [t(item.titleKey), t(item.subtitleKey), ...item.keywords].join(' ').toLowerCase();
    return hay.includes(q);
  });

  // r306 — pages. Matched on the LOCALIZED label and on the href, so a Malay-speaking user finds the
  // screen by its Malay name and an operator who knows the address finds it by that. Unfiltered the
  // list is every screen this viewer can reach, which is a menu, not a search result, so it only
  // appears once something is typed.
  const pageRows: NavSearchRow[] = gates ? visibleNavRows(gates) : [];
  const pages = q
    ? pageRows.filter((r) => `${nav(r.labelKey)} ${r.href}`.toLowerCase().includes(q)).slice(0, 8)
    : [];
  const nothingFound = q.length > 0 && pages.length === 0 && people.length === 0 && results.length === 0 && !peopleBusy;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        {/* Search-field-looking trigger: fills the header's centre track on sm+ (w-full), collapses to a
            compact icon below sm. aria-label uses the visible text (placeholder) so the accessible name
            contains the label (WCAG 2.5.3); below sm the trigger is icon-only and still needs it. */}
        <button
          type="button"
          aria-label={t('placeholder')}
          className="inline-flex h-10 w-auto min-w-0 items-center gap-2 rounded-md border border-input bg-card px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:w-full"
        >
          <Search className="size-4 shrink-0" />
          <span className="hidden truncate sm:inline">{t('placeholder')}</span>
          <kbd className="ml-auto hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium sm:inline">
            ⌘K
          </kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        {/* Content owns the height AND is the single scroller (the house idiom across the repo's dialogs) —
            no inner vh-sized boxes, so nothing can be clipped with no scrollbar to recover it. The delegation
            state widens ONLY while it is active because the shared delegation table has a 720px floor and the
            padding chain (quick-panel p-4 + Card border + list wrapper p-4 = 68px) eats the headroom; the
            search list keeps its compact width. NB: the width guard is source-static — raising that table
            floor would clip again without failing a test. */}
        <Dialog.Content
          style={{ outline: 'none' }}
          className={`fixed left-1/2 top-[12vh] z-50 max-h-[76vh] w-[calc(100%-2rem)] ${
            active === 'delegation' ? 'max-w-4xl' : 'max-w-lg'
          } -translate-x-1/2 overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-lg`}
        >
          <Dialog.Title className="sr-only">{t('open')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('placeholder')}</Dialog.Description>
          {active === null ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                {/* min-w-0/flex-1 is a defensive shrink guard, not the overlap fix - the r69 horizontal theory was measured false. */}
                <input
                  ref={inputRef}
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('placeholder')}
                  className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="p-3">
                {nothingFound && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('noResults')}</div>
                )}
                {pages.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('groupPages')}
                    </p>
                    <ul className="mb-2 space-y-1">
                      {pages.map((row) => (
                        <li key={`page-${row.href}`}>
                          <Link
                            href={row.href}
                            onClick={() => onOpenChange(false)}
                            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                          >
                            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                              <CornerDownLeft className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{nav(row.labelKey)}</span>
                              {row.sectionLabelKey && (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {nav(row.sectionLabelKey)}
                                </span>
                              )}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {(people.length > 0 || peopleBusy) && (
                  <>
                    <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('groupPeople')}
                    </p>
                    {people.length === 0 ? (
                      <p className="px-3 py-2 text-sm text-muted-foreground">{t('searching')}</p>
                    ) : (
                      <ul className="mb-2 space-y-1">
                        {people.map((person) => (
                          <li key={`person-${person.employmentId}`}>
                            <Link
                              href={`/personnel/${person.employmentId}`}
                              onClick={() => onOpenChange(false)}
                              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                            >
                              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                                <UserRound className="size-4" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">{person.name}</span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {[person.employeeCode, person.department, person.company]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {results.length > 0 && (
                  <>
                    <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('groupActions')}
                    </p>
                    <ul className="space-y-1">
                    {results.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => setActive(item.id)}
                          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                            <UserCog className="size-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{t(item.titleKey)}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {t(item.subtitleKey)}
                            </span>
                          </span>
                          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                        </button>
                      </li>
                    ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          ) : active === 'delegation' ? (
            <DelegationQuickPanel onClose={() => onOpenChange(false)} onBack={() => setActive(null)} />
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The quick "Approval Delegation" panel inside the command bar — now a thin SHELL (popup parity, feedback
 * 29fe2d45): back link, open-full link, a loading state, an error-with-retry state, and the shared
 * DelegationManager (the exact component the /delegations page renders). The context loads lazily on mount
 * via loadDelegationContextAction; the manager itself refetches after every save and history toggle.
 * A transient loader failure shows a retry — it is NEVER mapped to "you cannot delegate" anymore.
 */
function DelegationQuickPanel({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const t = useTranslations('commandBar');
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error' } | { status: 'ready'; ctx: DelegationContext }
  >({ status: 'loading' });

  // The fetch itself never sets state synchronously (only in the promise callbacks), so the mount effect
  // stays cascade-free; the retry handler flips back to 'loading' first — fine in an event handler.
  const fetchCtx = useCallback(() => {
    loadDelegationContextAction(false)
      .then((ctx) => setState({ status: 'ready', ctx }))
      .catch(() => setState({ status: 'error' }));
  }, []);

  useEffect(() => {
    fetchCtx();
  }, [fetchCtx]);

  const retry = () => {
    setState({ status: 'loading' });
    fetchCtx();
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            ← {t('back')}
          </button>
          <span className="text-sm font-semibold">{t('delegationTitle')}</span>
        </div>
        <a href="/delegations" className="text-xs text-muted-foreground hover:underline" onClick={onClose}>
          {t('openFull')}
        </a>
      </div>

      {state.status === 'loading' ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{t('loading')}</div>
      ) : state.status === 'error' ? (
        <div className="space-y-3 py-2 text-sm text-muted-foreground">
          <p>{t('loadError')}</p>
          <button type="button" onClick={retry} className="text-sm text-primary hover:underline">
            {t('retry')}
          </button>
        </div>
      ) : (
        <DelegationManager surface="popup" initialContext={state.ctx} />
      )}
    </div>
  );
}
