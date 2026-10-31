import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { LoginShell } from '../app/(auth)/login/login-shell';
import { LoginTour } from '../app/(auth)/login/login-tour';
import { DEFAULT_LOGIN_PRESENTATION } from '../lib/login-presentation';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vietnamese from '../messages/vi.json';

let reducedMotion = false;
beforeEach(() => {
  vi.useFakeTimers();
  reducedMotion = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduce') && reducedMotion,
    media: query, addEventListener: () => {}, removeEventListener: () => {},
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const wrap = (child: React.ReactNode, locale = 'en', messages = en) =>
  render(<NextIntlClientProvider locale={locale} messages={messages} onError={e => { throw e; }}>{child}</NextIntlClientProvider>);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const log = () => screen.getByRole('list');
const tour = en.loginTour;

describe('login tour', () => {
  it('is the default welcome when no media is configured, and stays out when media is', () => {
    const view = wrap(<LoginShell presentation={DEFAULT_LOGIN_PRESENTATION}>Form</LoginShell>);
    expect(screen.getByRole('region', { name: tour.label })).toBeInTheDocument();
    view.unmount();
    wrap(<LoginShell presentation={{ ...DEFAULT_LOGIN_PRESENTATION, mediaType: 'video', mediaUrl: 'https://example.test/a.mp4', alt: 'Fictional film' }}>Form</LoginShell>);
    expect(screen.queryByRole('region', { name: tour.label })).toBeNull();
  });

  it.each(Object.entries({ en, ms, zh, ta, th, vi: vietnamese }))('plays every topic in %s without missing translations', (locale, messages) => {
    wrap(<LoginTour/>, locale, messages as typeof en);
    // Three topics, two turns each: enough time for the film to loop back to the first topic.
    for (let i = 0; i < 3; i++) advance(30_000);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
  });

  it('plays on its own: the assistant types, the film picks the first reply, the assistant answers', () => {
    wrap(<LoginTour/>);
    expect(within(log()).queryByText(tour.leave.open1)).toBeNull();
    advance(1_100);
    expect(within(log()).getByText(tour.leave.open1)).toBeInTheDocument();
    advance(2_400);
    expect(within(log()).getByText(tour.leave.pickA1)).toBeInTheDocument();
    advance(1_100);
    expect(within(log()).getByText(tour.leave.pickA1Reply)).toBeInTheDocument();
  });

  it('hands control to the visitor on a click and stops picking for them', () => {
    wrap(<LoginTour/>);
    advance(1_100);
    fireEvent.click(screen.getByRole('button', { name: tour.leave.pickB1 }));
    advance(1_100);
    expect(within(log()).getByText(tour.leave.pickB1Reply)).toBeInTheDocument();
    advance(1_100);
    expect(within(log()).getByText(tour.leave.open2)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tour.play })).toBeInTheDocument();
    advance(20_000);
    expect(within(log()).queryByText(tour.leave.pickA2)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: tour.leave.pickB2 }));
    advance(1_100);
    expect(within(log()).getByText(tour.leave.pickB2Reply)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: tour.again }));
    expect(within(log()).queryByText(tour.leave.pickB2Reply)).toBeNull();
  });

  it('pauses on request and switches topics by hand', () => {
    wrap(<LoginTour/>);
    fireEvent.click(screen.getByRole('button', { name: tour.pause }));
    advance(1_100);
    advance(20_000);
    expect(within(log()).queryByText(tour.leave.pickA1)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: tour.pay.topic }));
    expect(screen.getByRole('button', { name: tour.pay.topic })).toHaveAttribute('aria-pressed', 'true');
    advance(1_100);
    expect(within(log()).getByText(tour.pay.open1)).toBeInTheDocument();
  });

  it('opens paused with no typing beat under reduced motion', () => {
    reducedMotion = true;
    wrap(<LoginTour/>);
    advance(0);
    expect(within(log()).getByText(tour.leave.open1)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tour.play })).toBeInTheDocument();
    advance(20_000);
    expect(within(log()).queryByText(tour.leave.pickA1)).toBeNull();
  });
});
