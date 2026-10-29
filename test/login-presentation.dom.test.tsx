import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { LoginShell } from '../app/login/login-shell';
import { InternalAuthForm } from '../app/login/internal-form';
import { LoginPresentationForm } from '../app/admin/settings/login/presentation-form';
import { DEFAULT_LOGIN_PRESENTATION } from '../lib/login-presentation';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vietnamese from '../messages/vi.json';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
const save = vi.hoisted(() => vi.fn(async () => ({ status: 'saved', revision: 1 })));
vi.mock('../app/admin/settings/login/actions', () => ({ saveLoginPresentationAction: (...args: unknown[]) => save(...args as []) }));
const wrap = (child: React.ReactNode, locale = 'en', messages = en) => render(<NextIntlClientProvider locale={locale} messages={messages} onError={e => { throw e; }}>{child}</NextIntlClientProvider>);
afterEach(() => { cleanup(); save.mockClear(); });
describe('login presentation', () => {
  it.each(Object.entries({ en, ms, zh, ta, th, vi: vietnamese }))('renders the form and help in %s without missing translations', (locale, messages) => {
    wrap(<InternalAuthForm organization="fixture"/>, locale, messages as typeof en);
    expect(screen.getByRole('heading', { name: messages.loginPresentation.welcome })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.internalAuth.signIn })).toBeInTheDocument();
  });
  it('shows and hides the password without submitting the form', async () => {
    wrap(<InternalAuthForm organization="fixture"/>);
    const password = screen.getByLabelText(en.internalAuth.password);
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: en.loginPresentation.showPassword }));
    expect(password).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: en.loginPresentation.hidePassword }));
    expect(password).toHaveAttribute('type', 'password');
  });
  it('renders configured images and falls back after a broken image', () => {
    wrap(<LoginShell presentation={{ ...DEFAULT_LOGIN_PRESENTATION, mediaType: 'image', mediaUrl: 'https://example.test/welcome.png', alt: 'Fictional workspace' }}>Form</LoginShell>);
    fireEvent.error(screen.getByRole('img', { name: 'Fictional workspace' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('region', { name: en.loginTour.label })).toBeInTheDocument();
  });
  it('keeps GIF motion stopped until chosen and lets the visitor stop it', async () => {
    wrap(<LoginShell presentation={{ ...DEFAULT_LOGIN_PRESENTATION, mediaType: 'gif', mediaUrl: 'https://example.test/welcome.gif', alt: 'Fictional animation' }}>Form</LoginShell>);
    expect(screen.queryByRole('img')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: en.loginPresentation.playAnimation }));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.test/welcome.gif');
    await userEvent.click(screen.getByRole('button', { name: en.loginPresentation.pauseMedia }));
    expect(screen.queryByRole('img')).toBeNull();
  });
  it('videos retain native controls and do not autoplay', () => {
    const view = wrap(<LoginShell presentation={{ ...DEFAULT_LOGIN_PRESENTATION, mediaType: 'video', mediaUrl: 'https://example.test/welcome.mp4', alt: 'Fictional film' }}>Form</LoginShell>);
    const video = view.container.querySelector('video')!;
    expect(video).toHaveAttribute('controls'); expect(video).toHaveAttribute('playsinline'); expect(video).not.toHaveAttribute('autoplay');
  });
  it('saves clearing media while retaining a configurable browser icon, then allows another save', async () => {
    wrap(<LoginPresentationForm presentation={{ ...DEFAULT_LOGIN_PRESENTATION, iconUrl: 'https://example.test/icon.png' }} revision={0}/>);
    await userEvent.click(screen.getByRole('button', { name: en.loginPresentation.save }));
    expect(await screen.findByRole('status')).toHaveTextContent(en.loginPresentation.result.saved);
    const form = save.mock.calls[0] as unknown as [unknown, FormData];
    expect(form[1].get('mediaType')).toBe('none');
    expect(form[1].get('mediaUrl')).toBe(''); expect(form[1].get('iconUrl')).toBe('https://example.test/icon.png');
    expect(document.querySelector('input[name="revision"]')).toHaveValue('1');
  });
});
