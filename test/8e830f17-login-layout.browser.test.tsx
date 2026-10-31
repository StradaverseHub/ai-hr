import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { LoginShell } from '../app/(auth)/login/login-shell';
import '../app/globals.css';
import '../app/(auth)/login/login.css';

afterEach(async () => { cleanup(); document.body.style.margin = ''; await page.viewport(1280, 720); });
const visible = (el: Element | null) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
function mount() {
  document.body.style.margin = '0';
  return render(<NextIntlClientProvider locale="en" messages={en}><LoginShell><form data-testid="form"><input aria-label="Username" style={{ width: '100%', height: 44 }}/><button style={{ width: '100%', height: 44 }}>Sign in</button></form></LoginShell></NextIntlClientProvider>);
}

describe('8e830f17 login layout', () => {
  // Reproduced on staging: a phone held sideways (844x390) split the page in half and clipped the form.
  it.each([[844, 390], [390, 844], [768, 1024], [1000, 700]])('shows only the form at %ix%i', async (width, height) => {
    await page.viewport(width, height); const view = mount();
    expect(visible(view.container.querySelector('.login-welcome'))).toBe(false);
    expect(visible(view.container.querySelector('.login-mobile-brand'))).toBe(true);
    // The form keeps its designed reading width (it is capped), but it is whole: not squeezed into half the
    // screen beside the welcome panel and not cut off at either edge.
    const form = view.getByTestId('form').getBoundingClientRect();
    expect(form.left).toBeGreaterThanOrEqual(0);
    expect(form.right).toBeLessThanOrEqual(width + 0.5);
    expect(form.width).toBeGreaterThanOrEqual(Math.min(width - 64, 400));
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
  it('keeps the two-panel welcome layout on a desktop', async () => {
    await page.viewport(1440, 900); const view = mount();
    expect(visible(view.container.querySelector('.login-welcome'))).toBe(true);
    expect(visible(view.container.querySelector('.login-mobile-brand'))).toBe(false);
  });
});
