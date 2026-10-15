import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../app/providers';
import { observePageStyles } from '../lib/page-style-recovery';
import en from '../messages/en.json';

vi.mock('next-themes', () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
const owned: HTMLLinkElement[] = [];
let dispose: (() => void) | undefined;
const readyState = Object.getOwnPropertyDescriptor(document, 'readyState');
function link(href = '/_next/static/chunks/global.css', loaded = false) {
  const value = document.createElement('link'); value.rel = 'stylesheet'; value.href = href;
  value.dataset.styleFixture = 'true'; owned.push(value); document.head.append(value);
  if (loaded) Object.defineProperty(value, 'sheet', { configurable: true, value: {} });
  return value;
}
function replacement() {
  const values = [...document.querySelectorAll<HTMLLinkElement>('link[data-aihr-style-original]')];
  expect(values).toHaveLength(1); return values[0];
}
beforeEach(() => {
  vi.useFakeTimers(); Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' });
  // jsdom does not implement the native dialog's top-layer methods.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => {
  cleanup(); dispose?.(); dispose = undefined;
  for (const value of owned.splice(0)) value.remove();
  document.querySelectorAll('link[data-aihr-style-original]').forEach(value => value.remove());
  vi.useRealTimers();
  if (readyState) Object.defineProperty(document, 'readyState', readyState); else delete (document as unknown as Record<string, unknown>).readyState;
});
describe('page style recovery', () => {
  it('recovers the real provider surface without resetting a filled authentication form', () => {
    const original = link(); original.setAttribute('integrity', 'sha256-fixture'); original.nonce = 'fixture-nonce';
    render(<NextIntlClientProvider locale="en" messages={en}><Providers><input aria-label="Username" defaultValue="employee.private"/></Providers></NextIntlClientProvider>);
    act(() => { original.dispatchEvent(new Event('error')); });
    expect(screen.getByRole('status')).toHaveTextContent(en.pageStyleRecovery.restoring);
    const retry = replacement(), url = new URL(retry.href);
    expect(url.origin).toBe(window.location.origin); expect(url.pathname).toBe('/_next/static/chunks/global.css');
    expect(url.searchParams.get('_aihr_style_retry')).toBeTruthy();
    expect(retry.getAttribute('integrity')).toBe('sha256-fixture'); expect(retry.nonce).toBe('fixture-nonce');
    expect(original.nextElementSibling).toBe(retry);
    act(() => { Object.defineProperty(retry, 'sheet', { value: {} }); retry.dispatchEvent(new Event('load')); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Username' })).toHaveValue('employee.private');
    expect(original.href).toBe(new URL('/_next/static/chunks/global.css', window.location.origin).href);
    cleanup(); expect(retry.isConnected).toBe(true);
    dispose = observePageStyles(document, vi.fn());
    act(() => { original.dispatchEvent(new Event('error')); });
    expect(replacement()).toBe(retry);
  });
  it('discovers a stylesheet that failed before hydration, without retrying loaded or external sheets', () => {
    const missing = link(); link('/_next/static/chunks/healthy.css', true); link('https://external.fixture.test/style.css');
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    const changed = vi.fn(); dispose = observePageStyles(document, changed);
    expect(replacement().dataset.aihrStyleOriginal).toBe(missing.href); expect(changed).toHaveBeenLastCalledWith('retrying');
  });
  it('does not mistake a still-downloading stylesheet for a failure', () => {
    const pending = link(), changed = vi.fn(); dispose = observePageStyles(document, changed);
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull();
    Object.defineProperty(pending, 'sheet', { value: {} }); window.dispatchEvent(new Event('load'));
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull(); expect(changed).not.toHaveBeenCalled();
  });
  it('bounds repeated errors and timeouts at two retries and shows a usable failure surface', () => {
    const original = link();
    render(<NextIntlClientProvider locale="en" messages={en}><Providers><input aria-label="Username" defaultValue="retained"/></Providers></NextIntlClientProvider>);
    act(() => { original.dispatchEvent(new Event('error')); original.dispatchEvent(new Event('error')); });
    const first = replacement();
    act(() => { first.dispatchEvent(new Event('error')); });
    const second = replacement(); expect(second.href).not.toBe(first.href); expect(first.isConnected).toBe(false);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(en.pageStyleRecovery.failed);
    expect(screen.getByRole('button', { name: en.pageStyleRecovery.reload })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveFocus(); expect(screen.getByRole('textbox', { name: 'Username' })).toHaveValue('retained');
    act(() => { original.dispatchEvent(new Event('error')); vi.advanceTimersByTime(60000); });
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull();
  });
  it('ignores script, cross-origin, disabled and non-Next resource failures', () => {
    const changed = vi.fn(); dispose = observePageStyles(document, changed);
    const values = [link('https://outside.fixture.test/_next/static/chunks/global.css'), link('/some-other.css'), link('/_next/static/chunks/disabled.css')];
    values[2].disabled = true;
    for (const value of values) value.dispatchEvent(new Event('error'));
    const script = document.createElement('script'); document.head.append(script); script.dispatchEvent(new Event('error')); script.remove();
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull(); expect(changed).not.toHaveBeenCalled();
  });
  it('does not keep an obsolete route blocked after its original stylesheet is removed', () => {
    const original = link(), changed = vi.fn(); dispose = observePageStyles(document, changed);
    original.dispatchEvent(new Event('error')); const retry = replacement(); original.remove(); retry.dispatchEvent(new Event('error'));
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull(); expect(changed).toHaveBeenLastCalledWith(null);
  });
  it('cancels pending work when disposed and never injects a late replacement', () => {
    const original = link(), changed = vi.fn(); dispose = observePageStyles(document, changed);
    original.dispatchEvent(new Event('error')); const retry = replacement(); dispose(); changed.mockClear();
    vi.advanceTimersByTime(60000); retry.dispatchEvent(new Event('load')); original.dispatchEvent(new Event('error'));
    expect(document.querySelector('link[data-aihr-style-original]')).toBeNull(); expect(changed).not.toHaveBeenCalled();
  });
});
