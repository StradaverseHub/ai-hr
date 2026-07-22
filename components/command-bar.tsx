'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Search, ArrowRight, UserCog } from 'lucide-react';
import { DelegationManager } from '@/components/delegation-manager';
import { loadDelegationContextAction, type DelegationContext } from '@/app/delegations/actions';

/**
 * R44 delegation (Phase 1) — the product's FIRST global command bar. There was no search / cmdk primitive
 * anywhere, so this is built from scratch: a topbar trigger + a Cmd/Ctrl-K listener open a Radix Dialog with
 * a text box that substring-matches a small in-code registry of quick actions. It is deliberately generic
 * (add entries to COMMAND_ITEMS) — v1 ships one action, "Approval Delegation".
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Which action's sub-panel is showing (null = the search list).
  const [active, setActive] = useState<CommandItemId | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const reset = useCallback(() => {
    setQuery('');
    setActive(null);
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
        {/* The delegation panel needs a full workspace (list table + edit forms), so the dialog widens
            ONLY while it is active; the search list keeps its compact max-w-lg. */}
        <Dialog.Content
          className={`fixed left-1/2 top-[12vh] z-50 max-h-[76vh] w-[calc(100%-2rem)] ${
            active === 'delegation' ? 'max-w-3xl' : 'max-w-lg'
          } -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg`}
        >
          <Dialog.Title className="sr-only">{t('open')}</Dialog.Title>
          <Dialog.Description className="sr-only">{t('placeholder')}</Dialog.Description>
          {active === null ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-4">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('placeholder')}
                  className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="max-h-[56vh] overflow-y-auto p-2">
                {results.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('noResults')}</div>
                ) : (
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
    <div className="max-h-[76vh] overflow-y-auto p-4">
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
