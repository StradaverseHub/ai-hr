export type Status = 'loading' | 'locked' | 'signedOut' | 'signedIn';
export type Visibility = 'active' | 'inactive' | 'background';
type Snapshot = { status: Status; employmentId: string | null; error: boolean; visible: boolean; unlocking: boolean };
type Ports = {
  hasStoredSession: () => Promise<boolean>;
  canUnlock: () => Promise<boolean>;
  authenticate: () => Promise<boolean>;
  clearTokens: () => Promise<void>;
};

/** Device gate only; WorkOS identity and employment authorization still belong to the server. */
export function createSessionState(ports: Ports, initialVisibility: Visibility = 'active') {
  let visibility = initialVisibility;
  let generation = 0;
  let initialized = false;
  let snapshot: Snapshot = { status: 'loading', employmentId: null, error: false, visible: visibility === 'active', unlocking: false };
  const listeners = new Set<() => void>();
  function update(patch: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }
  function current(owner: number) { return owner === generation; }
  function canShowUnlockResult() { return visibility !== 'background'; }
  async function signOut() {
    generation += 1;
    const owner = generation;
    initialized = true;
    update({ status: 'signedOut', employmentId: null, error: false, unlocking: false });
    try { await ports.clearTokens(); }
    catch { if (current(owner)) update({ error: true }); }
  }
  async function unlock() {
    if (!initialized) { await initialize(); return; }
    if (snapshot.status !== 'locked' || snapshot.unlocking || visibility !== 'active') return;
    const owner = generation;
    update({ unlocking: true, error: false });
    try {
      const possible = await ports.canUnlock();
      if (!current(owner)) return;
      // No OS credentials: full hosted sign-in, never an automatic unlock of a stored session.
      if (!possible) { await signOut(); return; }
      const success = await ports.authenticate();
      if (current(owner) && success && canShowUnlockResult()) update({ status: 'signedIn' });
    } catch {
      if (current(owner)) update({ error: true });
    } finally {
      if (current(owner)) update({ unlocking: false });
    }
  }
  async function initialize() {
    const owner = generation;
    try {
      const has = await ports.hasStoredSession();
      if (!current(owner)) return;
      initialized = true;
      update({ status: has ? 'locked' : 'signedOut', error: false });
      if (has) await unlock();
    } catch { if (current(owner)) update({ status: 'locked', error: true }); }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize,
    unlock,
    signOut,
    markSignedIn() {
      generation += 1;
      initialized = true;
      update({ status: visibility === 'active' ? 'signedIn' : 'locked', employmentId: null, unlocking: false, error: false });
    },
    setEmploymentId(employmentId: string | null) {
      if (snapshot.status === 'signedIn') update({ employmentId });
    },
    setVisibility(next: Visibility) {
      visibility = next;
      if (next === 'background' && snapshot.unlocking) generation += 1; // invalidate a pending OS result
      update({ visible: next === 'active', ...(next === 'background' ? { unlocking: false } : {}),
        ...(next !== 'active' && snapshot.status === 'signedIn' ? { status: 'locked' as const } : {}) });
    },
    blur() {
      if (snapshot.status === 'signedIn') update({ status: 'locked' });
    },
    dispose() { generation += 1; listeners.clear(); },
  };
}
