import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StrictMode } from 'react';
import { expect, it, vi } from 'vitest';
import { OnboardingTour } from '../components/onboarding-tour';
import { TourLauncher } from '../components/tour-launcher';
import en from '../messages/en.json';

const readSteps = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ usePathname: () => '/me', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../app/onboarding-actions', () => ({ readTourStepsAction: readSteps, completeOnboardingAction: vi.fn() }));

it('opens the requested tour when its overlay mounts after the launcher click', async () => {
  readSteps.mockResolvedValue([{ id: 'welcome', target: null, placement: 'center', titleKey: 'welcomeTitle', bodyKey: 'welcomeBody' }]);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const view = render(<NextIntlClientProvider locale="en" messages={en}><TourLauncher /></NextIntlClientProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: en.onboarding.launch }));
    expect(readSteps).not.toHaveBeenCalled();
    view.rerender(<NextIntlClientProvider locale="en" messages={en}><TourLauncher /><StrictMode><OnboardingTour /></StrictMode></NextIntlClientProvider>);
    const dialog = await screen.findByRole('dialog', { name: en.onboarding.aria });
    expect(dialog).toHaveTextContent(en.onboarding.welcomeTitle);
    expect(readSteps).toHaveBeenCalledExactlyOnceWith('welcome');
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});
