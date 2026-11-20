import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Users } from 'lucide-react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { NavFlyoutPanel } from '../components/nav-flyout';
import { INTENT_DWELL_MS } from '../components/intent-link';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean | null }) => (
    <a {...props} data-prefetch={String(prefetch)} />
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('moves focus into the flyout without starting any destination prefetch', () => {
  vi.useFakeTimers();
  const onClose = vi.fn();
  const onEscape = vi.fn();
  render(
    <NavFlyoutPanel
      labelKey="people"
      items={[
        { href: '/personnel', labelKey: 'directory', icon: Users },
        { href: '/admin/personnel', labelKey: 'management', icon: Users },
      ]}
      isActive={() => false}
      rowBase=""
      panelId="people-menu"
      onClose={onClose}
      onEscape={onEscape}
    />,
  );
  const directory = screen.getByRole('link', { name: 'directory' });
  const management = screen.getByRole('link', { name: 'management' });
  expect(document.activeElement).toBe(directory);
  expect(directory.getAttribute('data-prefetch')).toBe('false');
  expect(management.getAttribute('data-prefetch')).toBe('false');

  fireEvent.pointerEnter(management);
  fireEvent.pointerLeave(management);
  act(() => vi.advanceTimersByTime(INTENT_DWELL_MS));
  expect(management.getAttribute('data-prefetch')).toBe('false');
  fireEvent.pointerEnter(management);
  act(() => vi.advanceTimersByTime(INTENT_DWELL_MS));
  expect(management.getAttribute('data-prefetch')).toBe('true');
  act(() => management.focus());
  act(() => directory.focus());
  expect(directory.getAttribute('data-prefetch')).toBe('true');

  fireEvent.keyDown(directory, { key: 'Escape' });
  expect(onEscape).toHaveBeenCalledOnce();
});
