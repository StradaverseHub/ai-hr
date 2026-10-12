/**
 * r396 — the UI theme control, RENDERED: a real <select> with a real <label>, in all six locales, with
 * NextIntlClientProvider's onError THROWING so a missing key fails here instead of painting
 * MISSING_MESSAGE. Also: changing it repaints <html data-ui-theme> at once (before the server round trip)
 * and calls the server action with the chosen name; and it is reachable inside the account menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

const setUiTheme = vi.fn(async (_theme: unknown) => ({ ok: true }));
vi.mock('@/app/ui-theme-actions', () => ({ setUiTheme: (t: unknown) => setUiTheme(t) }));
vi.mock('@/app/auth-actions', () => ({ logoutAction: async () => {} }));

const { UiThemeSwitcher } = await import('../components/ui-theme-switcher');
const { UserMenu } = await import('../components/user-menu');

const LOCALES = { en, ms, ta, th, vi: vi_, zh } as const;

const wrap = (ui: ReactNode, locale = 'en', messages: Record<string, unknown> = en as never) =>
  render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages as never}
      onError={(e: unknown) => {
        throw e;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  setUiTheme.mockClear();
  document.documentElement.setAttribute('data-ui-theme', 'monolith');
});
afterEach(() => document.documentElement.removeAttribute('data-ui-theme'));

describe('r396 — the theme control', () => {
  it.each(Object.keys(LOCALES) as (keyof typeof LOCALES)[])(
    '[%s] is a labelled <select> offering Monolith, Classic and Current, zero next-intl errors',
    (loc) => {
      const msgs = LOCALES[loc] as unknown as { components: { uiTheme: Record<string, string> } };
      const strings = msgs.components.uiTheme;
      expect(strings.label?.trim()).toBeTruthy();
      wrap(<UiThemeSwitcher />, loc, msgs as never);
      const select = screen.getByRole('combobox', { name: strings.label });
      expect(select.tagName).toBe('SELECT');
      const options = within(select).getAllByRole('option') as HTMLOptionElement[];
      expect(options.map((o) => o.value)).toEqual(['monolith', 'classic', 'current']);
      expect(options.map((o) => o.textContent)).toEqual([strings.monolith, strings.classic, strings.current]);
    },
  );

  it('shows the theme <html> is painted in', () => {
    document.documentElement.setAttribute('data-ui-theme', 'classic');
    wrap(<UiThemeSwitcher />);
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('classic');
  });

  it('changing it repaints <html data-ui-theme> immediately and calls the server action', async () => {
    wrap(<UiThemeSwitcher />);
    const select = screen.getByRole('combobox', { name: 'Theme' });
    expect(select).toHaveValue('monolith');
    await userEvent.selectOptions(select, 'classic');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('classic');
    expect(setUiTheme).toHaveBeenCalledWith('classic');
    await userEvent.selectOptions(select, 'current');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('current');
    expect(setUiTheme).toHaveBeenLastCalledWith('current');
    await userEvent.selectOptions(select, 'monolith');
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('monolith');
    expect(setUiTheme).toHaveBeenLastCalledWith('monolith');
  });

  it('is reachable in the account menu', async () => {
    const { container } = wrap(<UserMenu name="Aisyah Rahman" employeeCode="EMP-0001" employed />);
    await userEvent.click(container.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('combobox', { name: 'Theme' }).tagName).toBe('SELECT');
  });
});
