/**
 * An expired session's redirect to /login, followed by the client router, kept the authenticated root layout
 * mounted: the login form rendered inside the old sidebar and top bar. AuthRouteReload must cover that shell
 * and reload the document once, without looping when the server itself renders the shell on an auth route.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { AuthRouteReload } from '../components/auth-route-reload';

const KEY = 'aihr-auth-route-reload';
const at = (path: string) => { nav.pathname = path.split('?')[0]; window.history.replaceState(null, '', path); };
const cover = () => document.querySelector('[data-auth-route-reload]');

describe('AuthRouteReload', () => {
  beforeEach(() => window.sessionStorage.clear());

  it('does nothing on an application route', () => {
    at('/leave');
    const reload = vi.fn();
    render(<AuthRouteReload reload={reload} />);
    expect(reload).not.toHaveBeenCalled();
    expect(cover()).toBeNull();
  });

  it('covers the shell and reloads the login address once', () => {
    at('/login?returnTo=%2Fleave');
    const reload = vi.fn();
    const { rerender } = render(<AuthRouteReload reload={reload} />);
    rerender(<AuthRouteReload reload={reload} />);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith('http://localhost:3000/login?returnTo=%2Fleave');
    expect(cover()).not.toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toMatch(/^\d+\|http:\/\/localhost:3000\/login\?returnTo=%2Fleave$/);
  });

  it('applies to every login-flow route', () => {
    at('/reset-password');
    const reload = vi.fn();
    render(<AuthRouteReload reload={reload} />);
    expect(reload).toHaveBeenCalledWith('http://localhost:3000/reset-password');
  });

  it('stops after one recent attempt for the same address and uncovers the page', () => {
    at('/login?returnTo=%2Fpayroll');
    window.sessionStorage.setItem(KEY, `${Date.now() - 1000}|http://localhost:3000/login?returnTo=%2Fpayroll`);
    const reload = vi.fn();
    render(<AuthRouteReload reload={reload} />);
    expect(reload).not.toHaveBeenCalled();
    expect(cover()).toBeNull();
  });

  it('reloads again once the earlier attempt is stale', () => {
    at('/login?returnTo=%2Fclaims');
    window.sessionStorage.setItem(KEY, `${Date.now() - 60_000}|http://localhost:3000/login?returnTo=%2Fclaims`);
    const reload = vi.fn();
    render(<AuthRouteReload reload={reload} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
