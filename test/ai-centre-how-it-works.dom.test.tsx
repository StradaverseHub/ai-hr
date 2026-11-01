/** AI centre › How it works: the animated walkthrough must be usable without the animation.
 *
 * Pinned here, on the real component with the merged six-language catalogue:
 *  - keyboard: the chapter and step tab lists move with the arrow keys, Home and End, and focus follows;
 *  - focus order: chapters, Previous, Play, Next, the one selected step; the figure takes no focus;
 *  - reduced motion: Play advances one step and never autoplays; the request marker does not travel;
 *  - without reduced motion, Play advances on its own and stops at the last step;
 *  - the step text is a polite live region, and every language renders the step titles it owns. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import aiEn from '../messages/ai-centre/en.json';
import { enWithAiCentre, withAiCentre } from './helpers/ai-centre-messages';
import { HowItWorks, HOW_STEPS } from '../components/ai-centre/how-it-works';

const how = aiEn.aiCentre.how;
function setReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('reduce'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn(),
  }));
}
const show = (messages: Record<string, unknown> = enWithAiCentre, locale = 'en') =>
  render(<NextIntlClientProvider locale={locale} messages={messages as never} timeZone="Asia/Kuala_Lumpur"><HowItWorks /></NextIntlClientProvider>);
const steps = () => screen.getByRole('tablist', { name: how.stepsLabel });
const selectedStep = () => within(steps()).getAllByRole('tab').find(tab => tab.getAttribute('aria-selected') === 'true')!;

beforeEach(() => { vi.useFakeTimers(); setReducedMotion(false); });
afterEach(() => { vi.useRealTimers(); });

describe('How it works walkthrough', () => {
  it('moves through the steps with the keyboard, focus following the selection', () => {
    show();
    expect(selectedStep()).toHaveAccessibleName(how.steps.s0);
    selectedStep().focus();
    fireEvent.keyDown(selectedStep(), { key: 'ArrowRight' });
    fireEvent.keyDown(selectedStep(), { key: 'ArrowRight' });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s2);
    expect(document.activeElement).toBe(selectedStep());
    expect(screen.getByRole('heading', { level: 2, name: how.steps.s2 })).toBeInTheDocument();
    fireEvent.keyDown(selectedStep(), { key: 'End' });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s8);
    expect(screen.getByRole('button', { name: how.next })).toBeDisabled();
    fireEvent.keyDown(selectedStep(), { key: 'Home' });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s0);
    expect(screen.getByRole('button', { name: how.previous })).toBeDisabled();
  });

  it('keeps one tab stop per tab list, in reading order, and the figure takes none', () => {
    const view = show();
    const focusable = [...view.container.querySelectorAll<HTMLElement>('button, a, [tabindex]')].filter(el => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
    const names = focusable.map(el => el.getAttribute('aria-label') ?? el.textContent?.trim());
    expect(names).toEqual([how.chapters.request, how.play, how.next, how.steps.s0]);
    for (const svg of view.container.querySelectorAll('svg[role="img"]')) expect(svg.querySelector('[tabindex]')).toBeNull();
  });

  it('moves between chapters with the arrow keys', () => {
    show();
    const chapters = screen.getByRole('tablist', { name: how.chaptersLabel });
    const first = within(chapters).getByRole('tab', { name: how.chapters.request });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    const last = within(chapters).getByRole('tab', { name: how.chapters.never });
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(last);
    expect(screen.getByRole('tabpanel')).toHaveTextContent(how.never.n1);
  });

  it('plays on its own without reduced motion, and stops at the last step', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: how.play }));
    expect(screen.getByRole('button', { name: how.pause })).toHaveAttribute('aria-pressed', 'true');
    act(() => { vi.advanceTimersByTime(3600 * 2 + 10); });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s2);
    act(() => { vi.advanceTimersByTime(3600 * 10); });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s8);
    expect(screen.getByRole('button', { name: how.play })).toHaveAttribute('aria-pressed', 'false');
  });

  it('under reduced motion, Play advances one step and never autoplays, and the marker does not travel', () => {
    setReducedMotion(true);
    const view = show();
    fireEvent.click(screen.getByRole('button', { name: how.play }));
    expect(selectedStep()).toHaveAccessibleName(how.steps.s1);
    act(() => { vi.advanceTimersByTime(3600 * 5); });
    expect(selectedStep()).toHaveAccessibleName(how.steps.s1);
    const token = view.container.querySelector('[data-clockwork-token]')!;
    expect(token.getAttribute('class')).not.toContain('transform');
    expect(token.getAttribute('class')).toContain('transition-opacity');
  });

  it('announces each step politely', () => {
    show();
    const heading = screen.getByRole('heading', { level: 2, name: how.steps.s0 });
    expect(heading.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  });

  it.each([['ms', ms], ['zh', zh], ['vi', viCopy], ['ta', ta], ['th', th]] as const)('renders in %s from its own catalogue', (locale, base) => {
    const messages = withAiCentre(locale, base as Record<string, unknown>);
    show(messages, locale);
    const own = (messages as { aiCentre: typeof aiEn.aiCentre }).aiCentre.how;
    expect(own.steps.s0).not.toBe(how.steps.s0);
    expect(screen.getByRole('heading', { level: 2, name: own.steps.s0 })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: own.chapters.request })).toBeInTheDocument();
    expect(HOW_STEPS).toHaveLength(9);
  });
});
