type Scope = { namespace: string; organization: string; username: string };
type Ports = { read: () => Promise<string | null>; write: (value: string) => Promise<void>; remove: () => Promise<void>; markerExists: () => boolean; createMarker: () => void };
const canonical = (scope: Scope) => ({ ...scope, organization: scope.organization.trim().toLowerCase(), username: scope.username.trim().toLowerCase() });
/** One device-only proof, bound to a server/account. Writes and stale-generation cleanup are serialized. */
export function createRememberedMfaStore(ports: Ports) {
  let queue: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>) => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  async function initialize() {
    // Keychain survives uninstall on iOS; this separate sandbox marker does not.
    if (!ports.markerExists()) { await ports.remove(); ports.createMarker(); }
  }
  return {
    read(scope: Scope, assertCurrent: () => void): Promise<string | null> { return run(async () => {
      assertCurrent(); let raw: string | null;
      try { await initialize(); raw = await ports.read(); } catch { assertCurrent(); return null; }
      assertCurrent();
      try {
        const value = JSON.parse(raw ?? 'null'), expected = canonical(scope);
        if (value?.namespace !== expected.namespace || value.organization !== expected.organization || value.username !== expected.username ||
          typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return null;
        return value.token;
      } catch { return null; }
    }); },
    save(scope: Scope, token: string, seconds: number, assertCurrent: () => void): Promise<void> { return run(async () => {
      assertCurrent();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 90 * 86400) return;
      try { await initialize(); } catch { assertCurrent(); return; }
      assertCurrent();
      try { await ports.write(JSON.stringify({ ...canonical(scope), token, expiresAt: Date.now() + seconds * 1000 })); }
      catch { assertCurrent(); return; } // Optional remembering must not prevent a fully verified sign-in.
      try { assertCurrent(); } catch (error) { await ports.remove().catch(() => {}); throw error; }
    }); },
  };
}
