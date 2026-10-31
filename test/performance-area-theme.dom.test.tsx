/**
 * D-P1-32 D3 (APR-025, ADR-0152) — the Performance & Talent area theme, rendered through the REAL segment layout
 * (app/(app)/performance/layout.tsx). jsdom applies no stylesheet, so this pins markup and wiring only; the cascade
 * itself is test/performance-area-theme.browser.test.tsx and the stylesheet's source rules are
 * test/performance-area-theme.test.ts.
 *
 *  • A page under the layout renders inside `data-area-theme="performance"`, below the band that carries the
 *    area title, and the module guard is still the one bound to 'performance'.
 *  • Inside the area a client structural branch (useUiTheme) renders Classic structure even when the document is
 *    Atelier; outside it the same component still follows the document.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '../messages/en.json';

const guard = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock('@/lib/module-layout', () => ({
  moduleLayout: (code: string) => {
    guard.codes.push(code);
    return function GuardFixture({ children }: { children: ReactNode }) {
      return <div data-guard={code}>{children}</div>;
    };
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => (key: string) => (en as unknown as Record<string, Record<string, string>>)[ns][key],
}));
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/performance',
}));

import PerformanceLayout from '../app/(app)/performance/layout';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle } from '../components/ui/card';
import { ClientPager } from '../components/client-pager';
import { UiThemeProvider } from '../components/ui-theme-context';
import { pageState, parsePageQuery } from '../lib/pagination';

afterEach(() => {
  document.documentElement.removeAttribute('data-ui-theme');
  search = '';
});

const pager = () => <ClientPager state={pageState(parsePageQuery({ page: '1' }), 120, 25)} />;

/** A fictional page: one card with the area's one primary action and a pager, as a real list page has. */
function PageFixture() {
  return (
    <Card data-testid="fixture-card">
      <CardHeader>
        <CardTitle>Fictional cycle</CardTitle>
      </CardHeader>
      <Button>Fictional primary</Button>
      <div data-testid="inside-pager">{pager()}</div>
    </Card>
  );
}

async function renderArea(theme: 'classic' | 'monolith' | 'atelier') {
  document.documentElement.setAttribute('data-ui-theme', theme);
  const tree = await PerformanceLayout({ children: <PageFixture /> });
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <UiThemeProvider theme={theme}>
        <main>
          {tree}
          <div data-testid="outside-pager">{pager()}</div>
        </main>
      </UiThemeProvider>
    </NextIntlClientProvider>,
  );
}

describe('the Performance & Talent segment layout', () => {
  it('keeps the module guard bound to performance', () => {
    expect(guard.codes).toEqual(['performance']);
  });

  it.each(['classic', 'monolith', 'atelier'] as const)('%s: a page under the layout renders inside the area wrapper', async (theme) => {
    const { container } = await renderArea(theme);
    const areas = container.querySelectorAll('[data-area-theme]');
    expect(areas).toHaveLength(1);
    const area = areas[0] as HTMLElement;
    expect(area.getAttribute('data-area-theme')).toBe('performance');
    // The guard still wraps the whole area, so a module that is off never paints the band.
    expect(area.closest('[data-guard="performance"]')).not.toBeNull();
    // The page's card and its one primary action are inside the wrapper.
    expect(screen.getByTestId('fixture-card').closest('[data-area-theme="performance"]')).toBe(area);
    expect(screen.getByRole('button', { name: 'Fictional primary' }).closest('[data-area-theme="performance"]')).toBe(area);
    // The band is the wrapper's first child and carries the area title from messages, nothing else.
    const band = area.firstElementChild as HTMLElement;
    expect(band).toHaveAttribute('data-area-band');
    expect(band).toHaveTextContent(/^Performance & Talent$/);
    expect(en.nav.performanceTalent).toBe('Performance & Talent');
    expect(within(band).queryByRole('img')).toBeNull();
    // Content sits after the band, never inside it.
    expect(band.contains(screen.getByTestId('fixture-card'))).toBe(false);
  });

  it('inside the area a structural branch renders Classic; outside it still follows Atelier', async () => {
    await renderArea('atelier');
    const inside = screen.getByTestId('inside-pager');
    const outside = screen.getByTestId('outside-pager');
    expect(inside.querySelector('[data-ui-pager]')).not.toBeNull();
    expect(inside.querySelector('[data-ui-pager-compact]')).toBeNull();
    expect(outside.querySelector('[data-ui-pager-compact]')).not.toBeNull();
  });
});
