/**
 * D-P1-32 D3 (APR-025, ADR-0152) — the Performance & Talent area theme in a REAL engine: compiled Tailwind,
 * app/globals.css, app/atelier.css and app/(app)/performance/area-theme.css, read back with getComputedStyle.
 *
 * What jsdom cannot see and this pins: inside <div data-area-theme="performance"> a shared Card and Button
 * compute the SAME values in Classic, Monolith and Atelier (the tokens, the `monolith:` / `atelier:` variant
 * exclusion and the `revert-layer` neutralisers together), the light and dark values are the area's own, AI
 * actions are red, and outside the wrapper each theme still paints its own primary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/(app)/performance/area-theme.css';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle } from '../components/ui/card';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-ui-theme');
  document.documentElement.classList.remove('dark');
});

const THEMES = ['classic', 'monolith', 'atelier'] as const;
const EXPECTED = {
  light: { card: 'rgb(255, 255, 255)', primary: 'rgb(37, 42, 89)', aiInk: 'rgb(181, 20, 29)', page: 'rgb(245, 246, 250)' },
  dark: { card: 'rgb(23, 26, 51)', primary: 'rgb(59, 68, 147)', aiInk: 'rgb(255, 122, 128)', page: 'rgb(15, 17, 36)' },
} as const;

function paint(theme: (typeof THEMES)[number], dark: boolean) {
  document.documentElement.setAttribute('data-ui-theme', theme);
  document.documentElement.classList.toggle('dark', dark);
  render(
    <main>
      <div data-area-theme="performance" data-testid="area">
        <Card data-testid="inside-card">
          <CardHeader>
            <CardTitle>Fictional cycle</CardTitle>
          </CardHeader>
        </Card>
        <Button>Inside primary</Button>
        <Button variant="secondary">
          <Sparkles aria-hidden />
          Fictional draft
        </Button>
      </div>
      <Card data-testid="outside-card" />
      <Button>Outside primary</Button>
    </main>,
  );
  const area = screen.getByTestId('area');
  const card = screen.getByTestId('inside-card');
  const primary = screen.getByRole('button', { name: 'Inside primary' });
  const ai = screen.getByRole('button', { name: 'Fictional draft' });
  const s = (el: Element) => getComputedStyle(el);
  const result = {
    page: s(area).backgroundColor,
    font: s(area).fontFamily,
    cardBg: s(card).backgroundColor,
    cardRadius: s(card).borderTopLeftRadius,
    cardShadow: s(card).boxShadow,
    primaryBg: s(primary).backgroundColor,
    primaryInk: s(primary).color,
    primaryRadius: s(primary).borderTopLeftRadius,
    primaryHeight: primary.getBoundingClientRect().height,
    aiInk: s(ai).color,
    aiIcon: s(ai.querySelector('svg.lucide-sparkles')!).color,
    outsidePrimaryBg: s(screen.getByRole('button', { name: 'Outside primary' })).backgroundColor,
  };
  cleanup();
  return result;
}

describe.each([false, true])('dark=%s', (dark) => {
  it('inside the area every theme computes the same card and button', () => {
    const want = EXPECTED[dark ? 'dark' : 'light'];
    const seen = THEMES.map((theme) => ({ theme, ...paint(theme, dark) }));
    for (const r of seen) {
      expect(r.page, r.theme).toBe(want.page);
      expect(r.cardBg, r.theme).toBe(want.card);
      expect(r.cardRadius, r.theme).toBe('12px');
      expect(r.cardShadow, r.theme).toBe('none');
      expect(r.primaryBg, r.theme).toBe(want.primary);
      expect(r.primaryInk, r.theme).toBe('rgb(255, 255, 255)');
      expect(r.primaryRadius, r.theme).toBe('8px');
      expect(r.font.startsWith('-apple-system'), `${r.theme}: ${r.font}`).toBe(true);
      expect(r.aiInk, r.theme).toBe(want.aiInk);
      expect(r.aiIcon, r.theme).toBe('rgb(214, 25, 35)');
      // Theme-independent geometry: whatever the pointer media resolves to here, all three agree.
      expect(r.primaryHeight, r.theme).toBeGreaterThan(0);
      expect(r.primaryHeight, r.theme).toBe(seen[0].primaryHeight);
    }
    // Outside the wrapper each theme still paints its own primary, none of them the area's.
    const outside = seen.map((r) => r.outsidePrimaryBg);
    expect(new Set(outside).size).toBe(3);
    for (const bg of outside) expect(bg).not.toBe(want.primary);
  });
});
