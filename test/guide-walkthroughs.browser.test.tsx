import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { GuideTourButton } from '../components/guide-tour-button';
import { OnboardingTour } from '../components/onboarding-tour';
import { guideTourId, toursForRoles } from '../lib/onboarding-tour';
import en from '../messages/en.json';
import '../app/globals.css';

const state = vi.hoisted(() => ({ pathname: '/knowledge-base/example', push: vi.fn(), complete: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ push: state.push }) }));
vi.mock('../app/onboarding-actions', () => ({ completeOnboardingAction: state.complete }));

afterEach(() => { cleanup(); vi.clearAllMocks(); state.pathname = '/knowledge-base/example'; });

describe('guide walkthrough launch in Chromium', () => {
  it('launches a new guide, navigates to its module and spotlights a real-sized control', async () => {
    const id = guideTourId('employee-claims')!;
    const ui = () => <NextIntlClientProvider locale="en" messages={en}>
      <GuideTourButton tourId={id} />
      <div data-tour="claims-compose" style={{ width: 400, height: 120 }}>Claim form</div>
      <div data-tour="claims-history" style={{ width: 400, height: 120 }}>Claims history</div>
      <OnboardingTour tours={toursForRoles(['employee'])} autoStartTourId={null} />
    </NextIntlClientProvider>;
    const view = render(ui());
    fireEvent.click(screen.getByRole('button', { name: en.kb.startWalkthrough }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Submit an expense claim' })).toBeTruthy();
    expect(state.push).toHaveBeenCalledWith('/claims');
    state.pathname = '/claims'; view.rerender(ui());
    fireEvent.click(screen.getByRole('button', { name: en.onboarding.next }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Prepare the claim' })).toBeTruthy());
    await waitFor(() => {
      const spotlight = screen.getByRole('dialog').querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(spotlight).toBeTruthy();
      expect(Number.parseFloat(spotlight.style.width)).toBeGreaterThan(400);
    });
    expect(screen.getByRole('heading', { name: 'Prepare the claim' }).closest('[lang]')?.getAttribute('lang')).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: en.onboarding.next }));
    expect(screen.getByRole('heading', { name: 'Track the result' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.onboarding.done }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.complete).toHaveBeenCalledTimes(1);
  });

  it('launches an operator guide and refuses the same tour in an administrator bundle', async () => {
    const id = guideTourId('operator-provisioning')!;
    const ui = (roles: string[]) => <NextIntlClientProvider locale="en" messages={en}>
      <GuideTourButton tourId={id} />
      <OnboardingTour tours={toursForRoles(roles)} autoStartTourId={null} />
    </NextIntlClientProvider>;
    const view = render(ui(['hr_admin']));
    fireEvent.click(screen.getByRole('button', { name: en.kb.startWalkthrough }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state.push).not.toHaveBeenCalled();
    view.rerender(ui(['operator']));
    fireEvent.click(screen.getByRole('button', { name: en.kb.startWalkthrough }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Provision a customer' })).toBeTruthy());
    expect(state.push).toHaveBeenCalledWith('/operator');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
