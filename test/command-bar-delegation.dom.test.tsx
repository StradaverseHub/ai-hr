import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { expect, it, vi } from 'vitest';
import { CommandBar } from '../components/command-bar';
import { enWithAiCentre } from './helpers/ai-centre-messages';

const fake = vi.hoisted(() => ({ read: vi.fn(), importManager: vi.fn() }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('../app/delegations/actions', () => ({ loadDelegationContextAction: fake.read }));
vi.mock('../components/delegation-manager', () => {
  fake.importManager();
  return {
    DelegationManager: ({ initialContext, surface }: {
      initialContext: { witness: string }; surface: string;
    }) => <div data-surface={surface}>{initialContext.witness}</div>,
  };
});

it('loads the delegation tools and context together only after selection, and retries a failed read', async () => {
  let rejectRead: (error: Error) => void = () => {};
  fake.read.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRead = reject; }))
    .mockResolvedValueOnce({ witness: 'Fictional delegation context' });
  const labels = enWithAiCentre.commandBar;

  render(<NextIntlClientProvider locale="en" messages={enWithAiCentre}><CommandBar /></NextIntlClientProvider>);
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  const choice = screen.getByRole('button', { name: new RegExp(labels.delegationTitle) });
  expect(fake.importManager).not.toHaveBeenCalled();
  expect(fake.read).not.toHaveBeenCalled();

  fireEvent.click(choice);
  expect(screen.getByText(labels.loading)).toBeTruthy();
  expect(fake.read).toHaveBeenCalledExactlyOnceWith(false);
  await waitFor(() => expect(fake.importManager).toHaveBeenCalledOnce());

  await act(async () => { rejectRead(new Error('Fixture read failed')); });
  expect(await screen.findByText(labels.loadError)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: labels.retry }));
  expect((await screen.findByText('Fictional delegation context')).getAttribute('data-surface')).toBe('popup');
  expect(fake.read).toHaveBeenCalledTimes(2);
  expect(fake.importManager).toHaveBeenCalledOnce();
});
