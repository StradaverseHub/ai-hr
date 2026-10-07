'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { openCommandBar } from '@/lib/command-bar-events';
import { useIsMonolith } from '@/components/ui-theme-context';

/**
 * r398 — the Monolith INTENT BAR (docs/design/monolith/README.md §3, shell.css `.intent`): 60px, 1px ink
 * top and bottom, the orange sparkle, a plain 19px input, ↵ on the right.
 *
 * It is the command palette made visible and NOTHING MORE. It searches nothing itself: Enter (or ↵) opens
 * the existing <CommandBar /> dialog with the typed text as its query (lib/command-bar-events.ts), so the
 * registry, the matching and the delegation panel stay the command bar's alone. ⌘K still works from
 * anywhere, because the command bar keeps its own listener in both themes.
 *
 * Classic renders nothing here: Classic's way in is the search trigger in the header's centre track, which
 * Monolith hides (app/layout.tsx).
 *
 * Every string is the command bar's own (`commandBar.open` / `commandBar.placeholder`), because this IS
 * that control: a second label for the same action would be a second name for one thing.
 */
export function IntentBar() {
  const monolith = useIsMonolith();
  const t = useTranslations('commandBar');
  const id = useId();
  const [value, setValue] = useState('');
  if (!monolith) return null;

  return (
    <form
      role="search"
      className="monolith-rv flex h-[60px] shrink-0 items-center gap-3.5 border-y border-ink px-0.5 [animation-delay:50ms]"
      onSubmit={(e) => {
        e.preventDefault();
        openCommandBar(value.trim());
        setValue('');
      }}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" className="shrink-0 fill-signal" aria-hidden="true">
        <path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2z" />
      </svg>
      <label htmlFor={id} className="sr-only">
        {t('open')}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('placeholder')}
        className="h-full min-w-0 flex-1 bg-transparent text-[19px] font-medium tracking-[-0.01em] text-ink placeholder:text-faint"
      />
      <kbd aria-hidden="true" className="mono hidden shrink-0 text-mid sm:inline">
        ⌘K
      </kbd>
      <button
        type="submit"
        aria-label={t('open')}
        className="inline-flex min-h-10 shrink-0 items-center px-0.5 text-lg text-ink hover:text-signal-text"
      >
        ↵
      </button>
    </form>
  );
}
