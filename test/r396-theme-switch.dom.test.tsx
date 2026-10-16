/**
 * r396 — the UI theme control, RENDERED: a real <select> with a real <label>, in all six locales, with
 * NextIntlClientProvider's onError THROWING so a missing key fails here instead of painting
 * MISSING_MESSAGE. Also: changing it repaints <html data-ui-theme> at once (before the server round trip)
 * and calls the server action with the chosen name; and it is reachable inside the account menu.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import {registerUnsavedGuard,__resetUnsavedGuards} from '../lib/unsaved-changes';
import type { ReactNode } from 'react';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import zh from '../messages/zh.json';

const setUiTheme = vi.fn(async (_theme: unknown) => ({ ok: true }));
vi.mock('@/app/ui-theme-actions', () => ({ setUiTheme: (t: unknown) => setUiTheme(t) }));
const navigation=vi.hoisted(()=>({push:vi.fn(),pathname:'/'}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:navigation.push}),usePathname:()=>navigation.pathname}));
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
  setUiTheme.mockReset();setUiTheme.mockResolvedValue({ok:true});navigation.push.mockClear();navigation.pathname='/';__resetUnsavedGuards();
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
      expect(options.map((o) => o.value)).toEqual(['monolith', 'classic', 'current', 'ai-responsive']);
      expect(options.map((o) => o.textContent)).toEqual([strings.monolith, strings.classic, strings.current, strings['ai-responsive']]);
    },
  );

  it('shows the theme <html> is painted in', () => {
    document.documentElement.setAttribute('data-ui-theme', 'classic');
    wrap(<UiThemeSwitcher />);
    expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('classic');
  });

  it('changing it repaints <html data-ui-theme> after persistence and calls the server action', async () => {
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
  it('persists AI Responsive before navigation and does not repaint or navigate on save refusal',async()=>{
    let complete!:(value:{ok:boolean})=>void;setUiTheme.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    wrap(<UiThemeSwitcher />);await userEvent.selectOptions(screen.getByRole('combobox',{name:'Theme'}),'ai-responsive');
    expect(navigation.push).not.toHaveBeenCalled();expect(document.documentElement.getAttribute('data-ui-theme')).toBe('monolith');
    await act(async()=>complete({ok:true}));await waitFor(()=>expect(navigation.push).toHaveBeenCalledWith('/assistant'));
    expect(document.documentElement.getAttribute('data-ui-theme')).toBe('ai-responsive');
    setUiTheme.mockResolvedValueOnce({ok:false});await userEvent.selectOptions(screen.getByRole('combobox',{name:'Theme'}),'classic');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');expect(document.documentElement.getAttribute('data-ui-theme')).toBe('ai-responsive');expect(navigation.push).toHaveBeenCalledTimes(1);
  });
  it('asks the existing dirty-form owner before persisting/navigating, so cancel preserves inputs/theme',async()=>{
    let proceed:(()=>void)|undefined;const prompt=vi.fn((next:()=>void)=>{proceed=next;});registerUnsavedGuard({isDirty:()=>true,prompt});
    wrap(<UiThemeSwitcher />);await userEvent.selectOptions(screen.getByRole('combobox',{name:'Theme'}),'ai-responsive');
    expect(prompt).toHaveBeenCalledOnce();expect(setUiTheme).not.toHaveBeenCalled();expect(navigation.push).not.toHaveBeenCalled();expect(document.documentElement.getAttribute('data-ui-theme')).toBe('monolith');
    await act(async()=>proceed!());await waitFor(()=>expect(navigation.push).toHaveBeenCalledWith('/assistant'));
  });

});
