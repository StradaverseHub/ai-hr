'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslations } from 'next-intl';
import { Search, ArrowRight, UserCog } from 'lucide-react';
import { inputCls, btnPrimary } from '@/components/ui';
import { DelegationScopePicker } from '@/components/delegation-scope-picker';
import {
  createSelfDelegationAction,
  loadSelfDelegationContextAction,
} from '@/app/delegations/actions';

/**
 * R44 delegation (Phase 1) — the product's FIRST global command bar. There was no search / cmdk primitive
 * anywhere, so this is built from scratch: a topbar trigger + a Cmd/Ctrl-K listener open a Radix Dialog with
 * a text box that substring-matches a small in-code registry of quick actions. It is deliberately generic
 * (add entries to COMMAND_ITEMS) — v1 ships one action, "Approval Delegation", which opens an inline quick
 * modal that posts to the existing self-service create action so a manager can hand over approvals from any
 * screen without hunting through admin menus.
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

type PickerOption = { employmentId: string; name: string; employeeCode: string | null };

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
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 max-h-[76vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
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
 * The quick "Approval Delegation" panel inside the command bar. Loads the caller's self-delegation context
 * lazily on mount (can they delegate + the stand-in picker) and renders the create form, which posts to the
 * existing self-service action (delegator forced to the caller server-side). Non-managers see an explanatory
 * message + a link to the full screen instead of the form.
 */
function DelegationQuickPanel({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const t = useTranslations('commandBar');
  const td = useTranslations('delegations');
  const [state, setState] = useState<{ loading: boolean; canDelegate: boolean; options: PickerOption[] }>({
    loading: true,
    canDelegate: false,
    options: [],
  });
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    let alive = true;
    loadSelfDelegationContextAction()
      .then((ctx) => {
        if (alive) setState({ loading: false, canDelegate: ctx.canSelfDelegate, options: ctx.options });
      })
      .catch(() => {
        if (alive) setState({ loading: false, canDelegate: false, options: [] });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="max-h-[76vh] overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ← {t('back')}
        </button>
        <span className="text-sm font-semibold">{t('delegationTitle')}</span>
      </div>

      {state.loading ? (
        <div className="py-6 text-center text-sm text-muted-foreground">{t('loading')}</div>
      ) : !state.canDelegate ? (
        <div className="space-y-3 py-2 text-sm text-muted-foreground">
          <p>{td('noDownline')}</p>
          <a href="/delegations" className="inline-block text-primary hover:underline" onClick={onClose}>
            {t('openFull')}
          </a>
        </div>
      ) : (
        <form action={createSelfDelegationAction} className="space-y-3" onSubmit={onClose}>
          <p className="text-xs text-muted-foreground">{td('selfHint')}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{td('delegateTo')}</span>
            <select name="delegateEmploymentId" required className={inputCls} defaultValue="">
              <option value="" disabled>
                {td('choose')}
              </option>
              {state.options.map((p) => (
                <option key={p.employmentId} value={p.employmentId}>
                  {p.name}
                  {p.employeeCode ? ` (${p.employeeCode})` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{td('start')}</span>
              <input name="validFrom" type="date" required defaultValue={today} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">{td('end')}</span>
              <input name="validTo" type="date" className={inputCls} />
            </label>
          </div>
          <DelegationScopePicker />
          <div className="flex items-center justify-between pt-1">
            <a href="/delegations" className="text-xs text-muted-foreground hover:underline" onClick={onClose}>
              {t('openFull')}
            </a>
            <button className={btnPrimary}>{td('create')}</button>
          </div>
        </form>
      )}
    </div>
  );
}
