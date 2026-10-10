import { SessionChangedError, SignInRequiredError } from './errors';

export type TokenPair = { access_token: string; refresh_token: string; id_token?: string };
type Ports = {
  read: () => Promise<string | null>;
  write: (token: string, accessToken: string, idToken?: string) => Promise<void>;
  remove: () => Promise<void>;
  markLoggedOut?: () => void;
  authenticate: (body: Record<string, string>) => Promise<TokenPair>;
};

/** One owner per login. Storage writes are ordered even when an OS operation cannot be cancelled. */
export function createAuthState(ports: Ports) {
  let generation = 0;
  let accessToken: string | null = null;
  let flight: { generation: number; promise: Promise<string> } | null = null;
  let writes: Promise<unknown> = Promise.resolve();

  function assertCurrent(owner: number) {
    if (owner !== generation) throw new SessionChangedError();
  }
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const pending = writes.then(run);
    writes = pending.catch(() => undefined);
    return pending;
  }
  function invalidate() {
    generation += 1;
    accessToken = null;
    flight = null;
    return generation;
  }
  async function commit(pair: TokenPair, owner: number) {
    return enqueue(async () => {
      assertCurrent(owner);
      await ports.write(pair.refresh_token, pair.access_token, pair.id_token);
      assertCurrent(owner);
      accessToken = pair.access_token;
      return accessToken;
    });
  }
  function signOut() {
    invalidate(); // synchronous, before any storage/network wait
    const deletion = enqueue(ports.remove);
    try { ports.markLoggedOut?.(); }
    catch (error) { return deletion.then(() => { throw error; }); }
    return deletion;
  }
  async function hasStoredSession() {
    const owner = generation;
    await writes;
    const token = await ports.read();
    assertCurrent(owner);
    return token !== null;
  }
  function refresh(): Promise<string> {
    const owner = generation;
    if (flight?.generation === owner) return flight.promise;
    const promise = (async () => {
      await writes;
      assertCurrent(owner);
      const token = await ports.read();
      assertCurrent(owner);
      if (!token) throw new SignInRequiredError();
      try {
        const pair = await ports.authenticate({ grant_type: 'refresh_token', refresh_token: token });
        assertCurrent(owner);
        return await commit(pair, owner);
      } catch (error) {
        assertCurrent(owner); // a stale refusal must never delete a newer login
        if (error instanceof SignInRequiredError) {
          try { await signOut(); } catch { /* Invalidated in memory; keep the credential refusal for the UI gate. */ }
        }
        throw error;
      }
    })().finally(() => {
      if (flight?.promise === promise) flight = null;
    });
    flight = { generation: owner, promise };
    return promise;
  }
  return {
    generation: () => generation,
    assertCurrent,
    hasStoredSession,
    refresh,
    signOut,
    /** Invalidates previous browser callbacks before opening the system browser. */
    beginSignIn: invalidate,
    async completeSignIn(code: string, codeVerifier: string, owner: number) {
      assertCurrent(owner);
      const pair = await ports.authenticate({ grant_type: 'authorization_code', code, code_verifier: codeVerifier });
      assertCurrent(owner);
      await commit(pair, owner);
    },
    async getAccessToken() {
      if (accessToken && expiryOf(accessToken) - Date.now() / 1000 > 60) return accessToken;
      return refresh();
    },
  };
}

/** Only a refresh scheduling hint. The server, never this decoder, verifies the JWT. */
function expiryOf(token: string): number {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')));
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp : 0;
  } catch {
    return 0;
  }
}
