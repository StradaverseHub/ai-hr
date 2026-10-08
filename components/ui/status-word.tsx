import * as React from 'react';

/**
 * r427 (50ed39e1 contest) — a status written the same way on every screen. In Classic it is exactly the pill
 * the caller passes (`className`, appended to nothing and changed by nothing — the string is used verbatim,
 * not run through tailwind-merge); in Monolith it is a word (README §8: status is a word, no tinted fill):
 * DM Mono 11px uppercase, in ink (done), signal-text (needs attention) or mid (neutral).
 * The `monolith:` variant is declared after `dark:` in globals.css, so it wins over the dark tints too.
 */
export type StatusWordTone = 'ink' | 'signal' | 'mid';

export const STATUS_WORD_MONO =
  'monolith:rounded-none monolith:border-0 monolith:bg-transparent monolith:px-0 monolith:py-0 monolith:font-mono monolith:text-[11px] monolith:font-medium monolith:uppercase monolith:tracking-[0.12em]';
const TONE: Record<StatusWordTone, string> = {
  ink: 'monolith:text-ink',
  signal: 'monolith:text-signal-text',
  mid: 'monolith:text-mid',
};

export function StatusWord({
  tone,
  className,
  children,
}: {
  tone: StatusWordTone;
  /** Classic's classes, verbatim. */
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span data-status-word={tone} className={`${className} ${STATUS_WORD_MONO} ${TONE[tone]}`}>
      {children}
    </span>
  );
}
