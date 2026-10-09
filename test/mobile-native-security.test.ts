import { describe, expect, it, vi } from 'vitest';
import { createAuthState, type TokenPair } from '../mobile/lib/auth-state';
import { apiOriginProblem } from '../mobile/lib/config';
import { SessionChangedError, SignInRequiredError, UnavailableError } from '../mobile/lib/errors';
import { createInstallationStore } from '../mobile/lib/installation-store';
import { createSessionState } from '../mobile/lib/session-state';
import { providerLogoutUrl, sessionIdFromToken } from '../mobile/lib/provider-logout';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pair = (id: string): TokenPair => ({ access_token: id, refresh_token: `refresh-${id}` });
function authFixture() {
  let token: string | null = 'stored-refresh';
  const ports = {
    read: vi.fn(async () => token),
    write: vi.fn(async (value: string) => { token = value; }),
    remove: vi.fn(async () => { token = null; }),
    authenticate: vi.fn(async (_body: Record<string, string>) => pair('fresh')),
  };
  return { state: createAuthState(ports), ports, stored: () => token };
}
async function drain() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe('native credentials — actual storage and network races', () => {
  it('a delayed refresh cannot restore credentials after logout', async () => {
    const f = authFixture();
    const request = deferred<TokenPair>();
    f.ports.authenticate.mockReturnValueOnce(request.promise);
    const pending = f.state.refresh().catch((error: unknown) => error);
    await drain();
    expect(f.ports.authenticate).toHaveBeenCalledTimes(1);
    await f.state.signOut();
    request.resolve(pair('old'));
    expect(await pending).toBeInstanceOf(SessionChangedError);
    expect(f.stored()).toBeNull();
    expect(f.ports.write).not.toHaveBeenCalled();
  });

  it('an old refusal cannot sign out a newer account', async () => {
    const f = authFixture();
    const request = deferred<TokenPair>();
    f.ports.authenticate.mockReturnValueOnce(request.promise);
    const pending = f.state.refresh().catch((error: unknown) => error);
    await drain();
    await f.state.completeSignIn('code', 'verifier', f.state.beginSignIn());
    request.reject(new SignInRequiredError());
    expect(await pending).toBeInstanceOf(SessionChangedError);
    expect(f.stored()).toBe('refresh-fresh');
    expect(f.ports.remove).not.toHaveBeenCalled();
  });

  it('logout orders deletion after an OS write already in progress', async () => {
    const f = authFixture();
    const write = deferred<void>();
    const original = f.ports.write.getMockImplementation()!;
    f.ports.write.mockImplementationOnce(async (value) => { await write.promise; await original(value); });
    const pending = f.state.refresh().catch((error: unknown) => error);
    await drain();
    expect(f.ports.write).toHaveBeenCalledTimes(1);
    const logout = f.state.signOut();
    write.resolve();
    await logout;
    expect(await pending).toBeInstanceOf(SessionChangedError);
    expect(f.stored()).toBeNull();
  });

  it('a stale flight cannot clear a new flight and spend its refresh token twice', async () => {
    const f = authFixture();
    const old = deferred<TokenPair>(); const fresh = deferred<TokenPair>();
    f.ports.authenticate.mockReturnValueOnce(old.promise);
    const previous = f.state.refresh().catch((error: unknown) => error);
    await drain();
    await f.state.completeSignIn('code', 'verifier', f.state.beginSignIn());
    f.ports.authenticate.mockReturnValueOnce(fresh.promise);
    const current = f.state.refresh();
    await drain(); old.resolve(pair('old')); await previous;
    expect(f.state.refresh()).toBe(current);
    fresh.resolve(pair('new')); await current;
    expect(f.stored()).toBe('refresh-new');
    expect(f.ports.authenticate).toHaveBeenCalledTimes(3);
  });

  it('logout invalidates a browser code exchange already in progress', async () => {
    const f = authFixture(); const request = deferred<TokenPair>();
    f.ports.authenticate.mockReturnValueOnce(request.promise);
    const pending = f.state.completeSignIn('code', 'verifier', f.state.beginSignIn()).catch((error: unknown) => error);
    await f.state.signOut(); request.resolve(pair('late'));
    expect(await pending).toBeInstanceOf(SessionChangedError);
    expect(f.stored()).toBeNull();
  });

  it('concurrent callers share one refresh and store its rotated token', async () => {
    const f = authFixture();
    const first = f.state.refresh();
    expect(f.state.refresh()).toBe(first);
    expect(await first).toBe('fresh');
    expect(f.ports.authenticate).toHaveBeenCalledTimes(1);
    expect(f.stored()).toBe('refresh-fresh');
  });

  it('persists local revocation synchronously, before an asynchronous deletion starts', async () => {
    const f = authFixture(); const marker = vi.fn();
    const state = createAuthState({ ...f.ports, markLoggedOut: marker });
    const pending = state.signOut();
    expect(marker).toHaveBeenCalledTimes(1);
    expect(f.ports.remove).not.toHaveBeenCalled();
    await pending;
    expect(f.stored()).toBeNull();
  });

  it('a credential refusal clears the current session; an outage keeps it', async () => {
    const f = authFixture();
    f.ports.authenticate.mockRejectedValueOnce(new UnavailableError());
    await expect(f.state.refresh()).rejects.toBeInstanceOf(UnavailableError);
    expect(f.stored()).toBe('stored-refresh');
    f.ports.authenticate.mockRejectedValueOnce(new SignInRequiredError());
    await expect(f.state.refresh()).rejects.toBeInstanceOf(SignInRequiredError);
    expect(f.stored()).toBeNull();
  });
});

function sessionFixture() {
  const ports = { hasStoredSession: vi.fn(async () => true), canUnlock: vi.fn(async () => true),
    authenticate: vi.fn(async () => true), clearTokens: vi.fn(async (): Promise<void> => {}) };
  return { ports, state: createSessionState(ports) };
}
describe('native device gate', () => {
  it('cannot automatically unlock a stored session without an OS credential', async () => {
    const f = sessionFixture(); f.ports.canUnlock.mockResolvedValue(false);
    await f.state.initialize();
    expect(f.state.getSnapshot().status).toBe('signedOut');
    expect(f.ports.authenticate).not.toHaveBeenCalled();
    expect(f.ports.clearTokens).toHaveBeenCalledTimes(1);
  });
  it('a cancelled OS prompt keeps private screens locked', async () => {
    const f = sessionFixture(); f.ports.authenticate.mockResolvedValue(false);
    await f.state.initialize();
    expect(f.state.getSnapshot().status).toBe('locked');
  });
  it('locks on inactive, background and Android blur, until another successful unlock', async () => {
    const f = sessionFixture(); await f.state.initialize();
    f.state.setEmploymentId('employment-one');
    for (const transition of ['inactive', 'background', 'blur'] as const) {
      if (transition === 'blur') f.state.blur(); else f.state.setVisibility(transition);
      expect(f.state.getSnapshot().status).toBe('locked');
      f.state.setVisibility('active');
      expect(f.state.getSnapshot().status).toBe('locked');
      await f.state.unlock();
      expect(f.state.getSnapshot().status).toBe('signedIn');
    }
    expect(f.state.getSnapshot().employmentId).toBe('employment-one');
  });
  it.each(['background', 'logout', 'dispose'] as const)('ignores a late successful unlock after %s', async (change) => {
    const f = sessionFixture(); const prompt = deferred<boolean>();
    f.ports.authenticate.mockReturnValueOnce(prompt.promise);
    const pending = f.state.initialize(); await drain();
    expect(f.ports.authenticate).toHaveBeenCalledTimes(1);
    if (change === 'background') f.state.setVisibility('background');
    else if (change === 'logout') await f.state.signOut();
    else f.state.dispose();
    prompt.resolve(true); await pending;
    expect(f.state.getSnapshot().status).not.toBe('signedIn');
  });
  it('allows the OS prompt transient inactive state without showing private content there', async () => {
    const f = sessionFixture(); const prompt = deferred<boolean>();
    f.ports.authenticate.mockReturnValueOnce(prompt.promise);
    const pending = f.state.initialize(); await drain();
    f.state.setVisibility('inactive'); prompt.resolve(true); await pending;
    expect(f.state.getSnapshot().visible).toBe(false);
    f.state.setVisibility('active');
    expect(f.state.getSnapshot()).toMatchObject({ status: 'signedIn', visible: true });
  });
  it('hides private data and employment immediately, before credential deletion completes', async () => {
    const f = sessionFixture(); await f.state.initialize(); f.state.setEmploymentId('employment-one');
    const deletion = deferred<void>(); f.ports.clearTokens.mockReturnValueOnce(deletion.promise);
    const pending = f.state.signOut();
    expect(f.state.getSnapshot()).toMatchObject({ status: 'signedOut', employmentId: null });
    deletion.resolve(); await pending;
  });
  it('storage/protection initialization failure stays locked and retries initialization', async () => {
    const f = sessionFixture(); f.ports.hasStoredSession.mockRejectedValueOnce(new Error('storage unavailable'));
    await f.state.initialize();
    expect(f.state.getSnapshot()).toMatchObject({ status: 'locked', error: true });
    expect(f.ports.authenticate).not.toHaveBeenCalled();
    await f.state.unlock();
    expect(f.ports.hasStoredSession).toHaveBeenCalledTimes(2);
    expect(f.state.getSnapshot().status).toBe('signedIn');
  });
  it('backgrounding while storage loads does not leave startup stuck', async () => {
    const f = sessionFixture(); const storage = deferred<boolean>();
    f.ports.hasStoredSession.mockReturnValueOnce(storage.promise);
    const pending = f.state.initialize(); f.state.setVisibility('background');
    storage.resolve(true); await pending;
    expect(f.state.getSnapshot().status).toBe('locked');
    expect(f.ports.authenticate).not.toHaveBeenCalled();
  });
});

describe('first install and HTTPS boundaries', () => {
  it('provider logout sends only the encoded session id, never bearer credentials', () => {
    const jwt = `header.${Buffer.from(JSON.stringify({ sid: 'session&other=value' })).toString('base64url')}.signature`;
    const url = providerLogoutUrl(sessionIdFromToken(jwt));
    expect(url).toBe('https://api.workos.com/user_management/sessions/logout?session_id=session%26other%3Dvalue');
    expect(url).not.toContain(jwt);
    expect(sessionIdFromToken('not-a-token')).toBeNull();
    expect(providerLogoutUrl(null)).toBeNull();
    expect(providerLogoutUrl('session', 'aihr://auth/callback')).toContain('&return_to=aihr%3A%2F%2Fauth%2Fcallback');
  });
  it('deletes surviving Keychain credentials before creating a sandbox marker', async () => {
    let marker = false; let token: string | null = 'surviving-keychain-token';
    const events: string[] = [];
    const store = createInstallationStore({ markerExists: () => marker,
      createMarker() { events.push('marker'); marker = true; }, read: async () => token,
      write: async (value) => { token = value; }, remove: async () => { events.push('delete'); token = null; } });
    expect(await store.read()).toBeNull();
    expect(events).toEqual(['delete', 'marker']);
    await store.write('new-login');
    expect(await store.read()).toBe('new-login');
    expect(events).toEqual(['delete', 'marker']);
  });
  it('a failed deletion leaves no marker; the next attempt must retry deletion', async () => {
    const createMarker = vi.fn(); const remove = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(undefined);
    const store = createInstallationStore({ markerExists: () => false, createMarker, read: async () => null, write: async () => undefined, remove });
    await expect(store.read()).rejects.toThrow('locked');
    expect(createMarker).not.toHaveBeenCalled();
    await store.read(); expect(remove).toHaveBeenCalledTimes(2); expect(createMarker).toHaveBeenCalledTimes(1);
  });
  it('a logout marker refuses surviving credentials after a failed secure deletion and restart', async () => {
    let revoked = false;
    const ports = { markerExists: () => true, createMarker: () => { revoked = false; },
      logoutPending: () => revoked, markLogoutPending: () => { revoked = true; },
      read: vi.fn(async () => 'surviving-credential'), write: vi.fn(async (_token: string) => undefined),
      remove: vi.fn(async () => { throw new Error('Keychain inaccessible'); }) };
    const store = createInstallationStore(ports);
    expect(await store.read()).toBe('surviving-credential');
    store.markLoggedOut();
    await expect(store.remove()).rejects.toThrow('Keychain inaccessible');
    expect(await store.read()).toBeNull();
    expect(ports.read).toHaveBeenCalledTimes(1);
    const restarted = createInstallationStore(ports);
    await expect(restarted.read()).rejects.toThrow('Keychain inaccessible');
    expect(revoked).toBe(true);
    expect(ports.read).toHaveBeenCalledTimes(1);
  });
  it.each(['http://example.com', 'http://localhost:3000', 'ftp://example.com', 'https://user:password@example.com',
    'https://example.com/path', 'https://example.com?token=secret', 'https://example.com#fragment', '', 'broken'])('refuses %s', (origin) => {
    expect(apiOriginProblem(origin)).not.toBeNull();
  });
  it('accepts an HTTPS origin, including a TLS development port', () => {
    expect(apiOriginProblem('https://hr.example.com')).toBeNull();
    expect(apiOriginProblem('https://localhost:3443')).toBeNull();
  });
});
