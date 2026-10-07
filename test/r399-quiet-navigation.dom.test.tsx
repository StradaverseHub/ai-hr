/**
 * r399 — the owner saw "weird empty white boxes" while opening a feedback item: r394's loading shell (three empty
 * cards and a panel) shown for ~350 ms on production. Two fixes are pinned here:
 *  1. IntentLink prefetches the FULL route only after the pointer rests INTENT_DWELL_MS on it (so sweeping a long
 *     list does not render every row's page), and at once on focus or touch; the feedback board uses it.
 *  2. The shell draws no card boxes and fades in late (CSS), so a fast load shows nothing extra.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const seen: unknown[] = [];
vi.mock('next/link', () => ({
  default: ({ prefetch, children, ...rest }: { prefetch?: unknown; children?: React.ReactNode } & Record<string, unknown>) => {
    seen.push(prefetch);
    return <a data-prefetch={String(prefetch)} {...(rest as Record<string, unknown>)}>{children}</a>;
  },
}));
import { IntentLink, INTENT_DWELL_MS } from '../components/intent-link';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
beforeEach(() => { vi.useFakeTimers(); seen.length = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('r399 · IntentLink waits for a resting pointer', () => {
  it('a pointer that rests for the dwell escalates to a full prefetch', () => {
    render(<IntentLink href="/feedback/x">Item</IntentLink>);
    const a = screen.getByText('Item');
    expect(a.getAttribute('data-prefetch')).toBe('null');
    fireEvent.pointerEnter(a);
    expect(a.getAttribute('data-prefetch'), 'not before the dwell').toBe('null');
    act(() => { vi.advanceTimersByTime(INTENT_DWELL_MS); });
    expect(a.getAttribute('data-prefetch')).toBe('true');
  });

  it('a pointer that passes over without resting never escalates', () => {
    render(<IntentLink href="/feedback/y">Row</IntentLink>);
    const a = screen.getByText('Row');
    fireEvent.pointerEnter(a);
    act(() => { vi.advanceTimersByTime(INTENT_DWELL_MS - 30); });
    fireEvent.pointerLeave(a);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(a.getAttribute('data-prefetch')).toBe('null');
  });

  it('focus and touch are deliberate: they escalate at once', () => {
    render(<><IntentLink href="/a">Focus me</IntentLink><IntentLink href="/b">Touch me</IntentLink></>);
    fireEvent.focus(screen.getByText('Focus me'));
    fireEvent.touchStart(screen.getByText('Touch me'));
    expect(screen.getByText('Focus me').getAttribute('data-prefetch')).toBe('true');
    expect(screen.getByText('Touch me').getAttribute('data-prefetch')).toBe('true');
  });

  it("a caller's prefetch={false} still wins", () => {
    render(<IntentLink href="/c" prefetch={false}>Never</IntentLink>);
    fireEvent.focus(screen.getByText('Never'));
    expect(screen.getByText('Never').getAttribute('data-prefetch')).toBe('false');
  });

  it('the feedback board links its rows through IntentLink', () => {
    expect(read('app/feedback/bulk-table.tsx')).toContain("import Link from '@/components/intent-link';");
  });
});

describe('r399 · the navigation shell is quiet', () => {
  const src = read('components/route-loading.tsx');
  it('draws no card boxes or panels', () => {
    expect(src).not.toMatch(/rounded-\[1\.25rem\]/);
    expect(src).not.toMatch(/\bbg-card\b/);
    expect(src).toContain('divide-y divide-border');
  });
  it('fades in only after a delay, and not at all under reduced motion', () => {
    expect(src).toContain('route-loading ');
    const css = read('app/globals.css');
    expect(css).toMatch(/\.route-loading\s*\{\s*animation:\s*route-loading-in\s+\d+ms\s+ease-out\s+150ms\s+both;/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.route-loading\s*\{\s*animation:\s*none;/);
  });
});
